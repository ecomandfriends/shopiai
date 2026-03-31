import express from "express";
import cors from "cors";
import crypto from "crypto";
import fetch from "node-fetch";
import { createClient } from "@supabase/supabase-js";

const app = express();
app.use(express.json());
app.use(cors({ origin: "*" }));

const { SHOPIFY_CLIENT_ID, SHOPIFY_CLIENT_SECRET, ANTHROPIC_API_KEY, APP_URL, SUPABASE_URL, SUPABASE_KEY } = process.env;
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// Conversaciones en memoria por sesión (caché temporal)
const sessionCache = new Map();

// ─────────────────────────────────────────
// SUPABASE — STORES
// ─────────────────────────────────────────

async function getStore(shop) {
  const { data, error } = await supabase.from("stores").select("*").eq("shop", shop).single();
  if (error) return null;
  return data;
}

async function saveStore(shop, data) {
  const { error } = await supabase.from("stores").upsert({ shop, ...data }, { onConflict: "shop" });
  if (error) console.error("Supabase store error:", error.message);
  else console.log("Saved store:", shop);
}

// ─────────────────────────────────────────
// SUPABASE — CONVERSATIONS
// ─────────────────────────────────────────

async function getConversation(sessionId) {
  // Primero intenta caché en memoria
  if (sessionCache.has(sessionId)) return sessionCache.get(sessionId);

  const { data, error } = await supabase
    .from("conversations")
    .select("*")
    .eq("session_id", sessionId)
    .single();

  if (error || !data) return null;
  sessionCache.set(sessionId, data);
  return data;
}

async function saveConversation(shop, sessionId, messages, context) {
  const id = `${shop}_${sessionId}`;
  const data = {
    id,
    shop,
    session_id: sessionId,
    messages,
    context,
    updated_at: new Date().toISOString(),
  };

  const { error } = await supabase
    .from("conversations")
    .upsert(data, { onConflict: "id" });

  if (error) console.error("Conversation save error:", error.message);

  // Actualizar caché
  sessionCache.set(sessionId, data);
}

// ─────────────────────────────────────────
// SUPABASE — EVENTS / ANALYTICS
// ─────────────────────────────────────────

async function trackEvent(shop, sessionId, type, data) {
  await supabase.from("events").insert({
    shop,
    session_id: sessionId,
    type,
    data,
    created_at: new Date().toISOString(),
  });
}

async function getAnalytics(shop) {
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();

  const [eventsRes, convsRes] = await Promise.all([
    supabase.from("events").select("*").eq("shop", shop).gte("created_at", thirtyDaysAgo),
    supabase.from("conversations").select("id,session_id,messages,context,created_at,updated_at").eq("shop", shop).order("updated_at", { ascending: false }).limit(50),
  ]);

  const events = eventsRes.data || [];
  const convs = convsRes.data || [];

  const messages = events.filter(e => e.type === "message");
  const conversions = events.filter(e => e.type === "conversion");
  const sessions = new Set(messages.map(e => e.session_id)).size;

  const qFreq = {};
  messages.forEach(e => {
    const q = e.data?.message?.slice(0, 80);
    if (q) qFreq[q] = (qFreq[q] || 0) + 1;
  });

  return {
    summary: {
      chatSessions: sessions,
      conversions: conversions.length,
      conversionRate: sessions ? ((conversions.length / sessions) * 100).toFixed(1) : 0,
      orderQueries: messages.filter(e => e.data?.hasOrderLookup).length,
      productCardShows: messages.filter(e => e.data?.hasProductCards).length,
      totalMessages: messages.length,
    },
    topQuestions: Object.entries(qFreq)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([q, count]) => ({ q, count })),
    conversations: convs.map(c => {
      const msgs = c.messages || [];
      const firstUserMsg = msgs.find(m => m.role === "user")?.content || "";
      const lastMsg = msgs[msgs.length - 1]?.content || "";
      return {
        sessionId: c.session_id,
        messageCount: msgs.length,
        firstMessage: firstUserMsg.slice(0, 80),
        lastMessage: lastMsg.slice(0, 80),
        createdAt: c.created_at,
        updatedAt: c.updated_at,
        context: c.context,
      };
    }),
  };
}

// ─────────────────────────────────────────
// OAUTH
// ─────────────────────────────────────────

app.get("/auth", (req, res) => {
  const { shop } = req.query;
  if (!shop) return res.status(400).send("Missing shop");
  const scopes = ["read_products","read_collections","read_orders","read_customers","read_inventory","read_shipping","read_content","read_price_rules","read_fulfillments"].join(",");
  const redirectUri = `${APP_URL}/auth/callback`;
  const state = crypto.randomBytes(16).toString("hex");
  res.redirect(`https://${shop}/admin/oauth/authorize?client_id=${SHOPIFY_CLIENT_ID}&scope=${scopes}&redirect_uri=${encodeURIComponent(redirectUri)}&state=${state}`);
});

app.get("/auth/callback", async (req, res) => {
  const { shop, code } = req.query;
  try {
    const tokenRes = await fetch(`https://${shop}/admin/oauth/access_token`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ client_id: SHOPIFY_CLIENT_ID, client_secret: SHOPIFY_CLIENT_SECRET, code }),
    });
    const { access_token } = await tokenRes.json();
    console.log("Token received:", access_token ? "YES" : "NO");
    if (!access_token) return res.status(400).send("No token");

    await saveStore(shop, {
      access_token,
      config: {
        assistantName: "Sara", tone: "friendly", language: "auto",
        triggerDelay: 4, widgetPosition: "right", primaryColor: "#e97a1a",
        welcomeMessage: "¿En qué puedo ayudarte?",
        enableOrderTracking: true, enableUpsell: true, enableExitIntent: true,
        freeShippingThreshold: 50, active: true,
        brandDescription: "", allowedTopics: [], blockedTopics: [], faqs: [], bundles: [],
      },
      installed_at: new Date().toISOString(),
    });

    syncCatalog(shop).catch(console.error);
    res.send(`<html><body style="font-family:sans-serif;text-align:center;padding:60px"><h2>Shopi Advisor instalado</h2><p style="color:#999;font-size:13px">${shop}</p></body></html>`);
  } catch (err) {
    console.error("OAuth error:", err);
    res.status(500).send("Error: " + err.message);
  }
});

// ─────────────────────────────────────────
// SHOPIFY HELPERS
// ─────────────────────────────────────────

async function shopifyFetch(shop, token, endpoint) {
  const res = await fetch(`https://${shop}/admin/api/2024-01/${endpoint}`, { headers: { "X-Shopify-Access-Token": token } });
  if (!res.ok) throw new Error(`Shopify API ${res.status}: ${endpoint}`);
  return res.json();
}

// ─────────────────────────────────────────
// PRODUCT SEARCH
// ─────────────────────────────────────────

async function searchProducts(shop, query, limit = 3) {
  const store = await getStore(shop);
  if (!store?.catalog?.products) return [];
  const q = query.toLowerCase();
  return store.catalog.products
    .map(p => {
      let score = 0;
      const title = p.title?.toLowerCase() || "";
      const desc = p.body_html?.toLowerCase() || "";
      const type = p.product_type?.toLowerCase() || "";
      const tags = (p.tags || "").toLowerCase();
      if (title.includes(q)) score += 10;
      if (type.includes(q)) score += 5;
      if (tags.includes(q)) score += 4;
      if (desc.includes(q)) score += 2;
      q.split(" ").forEach(w => { if (w.length > 3) { if (title.includes(w)) score += 3; if (desc.includes(w)) score += 1; } });
      return { p, score };
    })
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(({ p }) => ({
      id: p.id,
      title: p.title,
      price: p.variants?.[0]?.price || "0",
      compareAtPrice: p.variants?.[0]?.compare_at_price || null,
      image: p.images?.[0]?.src || null,
      handle: p.handle,
      url: `https://${shop}/products/${p.handle}`,
      variantId: p.variants?.[0]?.id || null,
      available: p.variants?.some(v => v.available !== false),
    }));
}

// ─────────────────────────────────────────
// ORDER LOOKUP
// ─────────────────────────────────────────

async function lookupOrder(shop, query) {
  const store = await getStore(shop);
  if (!store?.access_token) return null;
  try {
    const isEmail = query.includes("@");
    const isNum = /^#?\d{4,}$/.test(query.trim());
    let orders = [];
    if (isEmail) {
      const d = await shopifyFetch(shop, store.access_token, `orders.json?email=${encodeURIComponent(query)}&limit=5&status=any`);
      orders = d.orders || [];
    } else if (isNum) {
      const d = await shopifyFetch(shop, store.access_token, `orders.json?name=%23${query.replace("#","")}&limit=1&status=any`);
      orders = d.orders || [];
    }
    if (!orders.length) return null;
    return orders.map(o => {
      const f = o.fulfillments?.[0];
      const statusMap = { null:"preparando", unfulfilled:"preparando", partial:"enviado parcialmente", fulfilled:"enviado", restocked:"devuelto" };
      const status = o.cancelled_at ? "cancelado" : (statusMap[o.fulfillment_status] || "preparando");
      const daysSince = Math.floor((Date.now() - new Date(o.created_at)) / 86400000);
      return {
        name: o.name, status,
        items: o.line_items?.map(i => `${i.quantity}x ${i.title}${i.variant_title && i.variant_title !== "Default Title" ? ` (${i.variant_title})` : ""}`).join(", "),
        total: `€${parseFloat(o.total_price).toFixed(2)}`,
        createdAt: new Date(o.created_at).toLocaleDateString("es-ES", { day:"numeric", month:"long", year:"numeric" }),
        trackingNumber: f?.tracking_number || null,
        trackingCompany: f?.tracking_company || null,
        trackingUrl: f?.tracking_url || null,
        estimatedDelivery: f?.estimated_delivery_at ? new Date(f.estimated_delivery_at).toLocaleDateString("es-ES", { day:"numeric", month:"long" }) : null,
        isLate: daysSince > 7 && o.fulfillment_status !== "fulfilled",
        daysSince, cancelled: !!o.cancelled_at,
      };
    });
  } catch (err) { console.error("Order lookup error:", err.message); return null; }
}

function formatOrderForClaude(orders) {
  if (!orders?.length) return "No se encontraron pedidos.";
  return orders.map(o => {
    let info = `Pedido ${o.name} — ${o.status.toUpperCase()}\nProductos: ${o.items}\nTotal: ${o.total}\nFecha: ${o.createdAt}`;
    if (o.trackingNumber) info += `\nSeguimiento: ${o.trackingNumber} (${o.trackingCompany || "transportista"})`;
    if (o.trackingUrl) info += `\nURL tracking (incluye el enlace completo en tu respuesta): ${o.trackingUrl}`;
    if (o.estimatedDelivery) info += `\nEntrega estimada: ${o.estimatedDelivery}`;
    if (o.isLate) info += `\n⚠ RETRASO: ${o.daysSince} días desde el pedido.`;
    if (o.cancelled) info += `\nPedido cancelado.`;
    return info;
  }).join("\n\n---\n\n");
}

function extractOrderQuery(message, history) {
  const emailMatch = message.match(/[\w.-]+@[\w.-]+\.\w+/);
  if (emailMatch) return emailMatch[0];
  const orderMatch = message.match(/#?(\d{4,})/);
  if (orderMatch) return `#${orderMatch[1]}`;
  if (history.length >= 2) {
    const lastAI = [...history].reverse().find(m => m.role === "assistant");
    if (lastAI?.content?.match(/email|número de pedido|order number/i)) {
      const em = message.match(/[\w.-]+@[\w.-]+\.\w+/);
      if (em) return em[0];
      const num = message.match(/#?(\d{3,})/);
      if (num) return `#${num[1]}`;
    }
  }
  const keywords = ["pedido","envío","paquete","entrega","tracking","seguimiento","llegado","llega","dónde está","order","shipping","delivery"];
  if (keywords.some(k => message.toLowerCase().includes(k))) return "NEEDS_INFO";
  return null;
}

// ─────────────────────────────────────────
// SYSTEM PROMPT
// ─────────────────────────────────────────

function generateSystemPrompt(config, catalog, browserLang) {
  const { products = [], shop } = catalog;

  const productList = products.slice(0, 60).map(p => {
    const price = p.variants?.[0]?.price || "?";
    const variants = p.variants?.map(v => v.title).filter(t => t !== "Default Title").join(", ");
    const desc = p.body_html?.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 120) || "";
    return `- ${p.title} (€${price})${variants ? ` [${variants}]` : ""}${desc ? `: ${desc}` : ""}`;
  }).join("\n");

  const faqText = config?.faqs?.length
    ? "\nPREGUNTAS FRECUENTES:\n" + config.faqs.map(f => `P: ${f.q}\nR: ${f.a}`).join("\n\n") : "";

  const bundlesText = config?.bundles?.length
    ? "\nBUNDLES:\n" + config.bundles.map(b => `- ${b.name}: ${(b.products||[]).join(" + ")} — ${b.discount}% dto. Activar cuando: ${b.trigger || "cliente muestre interés"}`).join("\n") : "";

  const brandText = config?.brandDescription ? `\nSOBRE LA MARCA:\n${config.brandDescription}` : "";

  const lang = config?.language === "auto" ? (browserLang || "es") : (config?.language || "es");
  const langInstruction = { es:"Responde SIEMPRE en español.", ca:"Respon SEMPRE en català.", en:"ALWAYS respond in English.", fr:"Réponds TOUJOURS en français.", de:"Antworte IMMER auf Deutsch.", pt:"Responde SEMPRE em português." }[lang] || "Responde SIEMPRE en español.";

  const toneMap = { friendly:"cercano y natural, como alguien de confianza que trabaja en la tienda", professional:"profesional y claro, sin familiaridades", technical:"técnico y preciso, basado en datos", motivational:"motivador y directo, empuja a la acción" };

  return `Eres el asistente de ${shop?.name || shop}. Tu tono es ${toneMap[config?.tone] || toneMap.friendly}.
${langInstruction}

REGLAS DE COMUNICACIÓN — CRÍTICAS:
1. Máximo 2 frases por mensaje. Sin excepciones.
2. Máximo 1 emoji por mensaje. Si no aporta, ninguno.
3. NUNCA más de 1 pregunta por mensaje.
4. NUNCA uses "o" para unir dos preguntas ("¿Quieres X o prefieres Y?" = PROHIBIDO).
5. Sin "¡Claro!", "¡Por supuesto!", "¡Genial!", "¡Perfecto!" ni relleno positivo.
6. Sin listas con puntos. Solo frases naturales.
7. Si el cliente ya sabe lo que quiere, ayúdale a cerrar sin más preguntas.

MAL: "¿Quieres añadir algo más o prefieres finalizar el pedido?"
BIEN: "¿Añadimos algo más antes de finalizar?"

PEDIDOS:
- Si tienes datos reales del pedido en el contexto, úsalos directamente.
- Si hay URL de tracking, inclúyela completa en tu respuesta.
- Si hay retraso, reconócelo y ofrece UNA solución concreta.
- Si no tienes los datos, pide email o número de pedido en una frase directa.

PRODUCT CARDS — añade al final si es útil:
SHOW_PRODUCTS:{"query":"término","reason":"motivo"}

VENTAS:
- Si le falta poco para envío gratis, menciónalo UNA vez de forma natural.
- 1 producto complementario máximo si tiene sentido real.

CATÁLOGO (${products.length} productos):
${productList || "Sin productos cargados"}
${brandText}${bundlesText}${faqText}

LÍMITES:
- Nunca inventes precios, stock ni plazos no confirmados.
- Si no sabes algo: "No tengo ese dato." y ofrece contacto.
- Sin competencia ni comparativas externas.`;
}

// ─────────────────────────────────────────
// CATALOG SYNC
// ─────────────────────────────────────────

async function syncCatalog(shop) {
  const store = await getStore(shop);
  if (!store?.access_token) { console.error("No token:", shop); return 0; }
  console.log("Syncing:", shop);
  try {
    const [productsData, pagesData, shopData] = await Promise.all([
      shopifyFetch(shop, store.access_token, "products.json?limit=250&fields=id,title,body_html,variants,images,tags,product_type,handle"),
      shopifyFetch(shop, store.access_token, "pages.json?limit=50&fields=title,body_html"),
      shopifyFetch(shop, store.access_token, "shop.json"),
    ]);
    const catalog = { shop: shopData.shop, products: productsData.products || [], pages: pagesData.pages || [], syncedAt: new Date().toISOString() };
    const systemPrompt = generateSystemPrompt(store.config, catalog, "es");
    await saveStore(shop, { access_token: store.access_token, config: store.config, catalog, system_prompt: systemPrompt, last_sync: new Date().toISOString() });
    console.log(`Synced ${catalog.products.length} products for ${shop}`);
    return catalog.products.length;
  } catch (err) { console.error("Sync error:", err.message); return 0; }
}

// ─────────────────────────────────────────
// CHAT
// ─────────────────────────────────────────

app.post("/chat", async (req, res) => {
  const { shop, sessionId, message, context } = req.body;
  if (!shop || !message) return res.status(400).json({ error: "Missing data" });

  const store = await getStore(shop);
  if (!store) return res.status(404).json({ error: "Store not found" });

  // ── Verificar si el agente está activo
  if (store.config?.active === false) {
    return res.status(403).json({ error: "Agent inactive" });
  }

  // ── Cargar o crear conversación
  const conv = await getConversation(sessionId);
  const history = conv?.messages || [];

  // ── Order lookup
  let orderContext = "";
  const orderQuery = extractOrderQuery(message, history);
  if (orderQuery && orderQuery !== "NEEDS_INFO") {
    const orders = await lookupOrder(shop, orderQuery);
    if (orders) orderContext = `\n\n[DATOS REALES DEL PEDIDO:\n${formatOrderForClaude(orders)}\n]`;
    else orderContext = `\n\n[No se encontró pedido con "${orderQuery}". Dile que revise los datos.]`;
  }

  // ── Context block
  const threshold = store.config?.freeShippingThreshold || 50;
  const remaining = context?.cartTotal ? Math.max(0, threshold - context.cartTotal) : threshold;
  const contextBlock = `\n\n[CONTEXTO: ${context?.productTitle ? `Cliente mirando "${context.productTitle}" (€${context.productPrice||"?"}). ` : `Página: ${context?.pageType||"general"}. `}${context?.cartTotal > 0 ? `Carrito: €${context.cartTotal} (${context.cartCount} productos). Faltan €${remaining.toFixed(2)} para envío gratis. ` : "Carrito vacío. "}${context?.isReturning ? "Segunda visita. " : ""}${context?.browserLang ? `Idioma: ${context.browserLang}.` : ""}]${orderContext}`;

  const browserLang = context?.browserLang || "es";
  const systemPrompt = store.catalog
    ? generateSystemPrompt(store.config, store.catalog, browserLang)
    : (store.system_prompt || generateSystemPrompt(store.config, { products: [], shop }, browserLang));

  history.push({ role: "user", content: message });

  try {
    const claudeRes = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model: "claude-sonnet-4-20250514",
        max_tokens: 500,
        system: systemPrompt + contextBlock,
        messages: history.slice(-12),
      }),
    });

    const data = await claudeRes.json();
    const raw = data.content?.[0]?.text || "Lo siento, ha habido un error.";

    const productMatch = raw.match(/SHOW_PRODUCTS:\{"query":"([^"]+)","reason":"([^"]+)"\}/);
    const reply = raw.replace(/SHOW_PRODUCTS:\{[^}]+\}/g, "").trim();

    let productCards = [];
    if (productMatch) productCards = await searchProducts(shop, productMatch[1]);

    history.push({ role: "assistant", content: raw });

    // ── Guardar conversación en Supabase
    await saveConversation(shop, sessionId, history, context);

    // ── Guardar evento en Supabase
    await trackEvent(shop, sessionId, "message", {
      message,
      reply,
      hasOrderLookup: !!orderContext,
      hasProductCards: productCards.length > 0,
      pageType: context?.pageType,
      cartTotal: context?.cartTotal,
    });

    res.json({ reply, productCards, sessionId });
  } catch (err) {
    console.error("Claude error:", err);
    res.status(500).json({ error: "Error del asistente" });
  }
});

// ─────────────────────────────────────────
// ADMIN API
// ─────────────────────────────────────────

app.get("/admin/config/:shop", async (req, res) => {
  const store = await getStore(req.params.shop);
  if (!store) return res.status(404).json({ error: "Store not found" });
  res.json({ config: store.config, lastSync: store.last_sync, productCount: store.catalog?.products?.length || 0 });
});

app.patch("/admin/config/:shop", async (req, res) => {
  const store = await getStore(req.params.shop);
  if (!store) return res.status(404).json({ error: "Store not found" });
  const newConfig = { ...store.config, ...req.body };
  const newPrompt = store.catalog ? generateSystemPrompt(newConfig, store.catalog, "es") : store.system_prompt;
  await saveStore(req.params.shop, { access_token: store.access_token, config: newConfig, catalog: store.catalog, system_prompt: newPrompt, last_sync: store.last_sync });
  res.json({ ok: true, config: newConfig });
});

// ── Toggle activo/inactivo
app.post("/admin/toggle/:shop", async (req, res) => {
  const store = await getStore(req.params.shop);
  if (!store) return res.status(404).json({ error: "Store not found" });
  const newActive = !store.config?.active;
  const newConfig = { ...store.config, active: newActive };
  await saveStore(req.params.shop, { access_token: store.access_token, config: newConfig, catalog: store.catalog, system_prompt: store.system_prompt, last_sync: store.last_sync });
  console.log(`Agent ${newActive ? "activated" : "deactivated"} for ${req.params.shop}`);
  res.json({ ok: true, active: newActive });
});

app.post("/admin/sync/:shop", async (req, res) => {
  const count = await syncCatalog(req.params.shop);
  const store = await getStore(req.params.shop);
  res.json({ ok: true, productCount: count, lastSync: store?.last_sync });
});

// ── Analytics con datos reales de Supabase
app.get("/analytics/:shop", async (req, res) => {
  try {
    const data = await getAnalytics(req.params.shop);
    res.json(data);
  } catch (err) {
    console.error("Analytics error:", err);
    res.status(500).json({ error: "Error loading analytics" });
  }
});

// ── Conversaciones reales
app.get("/admin/conversations/:shop", async (req, res) => {
  try {
    const { data, error } = await supabase
      .from("conversations")
      .select("id,session_id,messages,context,created_at,updated_at")
      .eq("shop", req.params.shop)
      .order("updated_at", { ascending: false })
      .limit(20);

    if (error) throw error;

    const convs = (data || []).map(c => {
      const msgs = c.messages || [];
      const firstUserMsg = msgs.find(m => m.role === "user")?.content || "";
      const lastMsg = msgs[msgs.length - 1]?.content || "";
      const hasOrder = msgs.some(m => m.content?.includes("pedido") || m.content?.includes("tracking"));
      const hasProduct = msgs.some(m => m.content?.includes("SHOW_PRODUCTS"));
      return {
        sessionId: c.session_id,
        messageCount: msgs.length,
        firstMessage: firstUserMsg.slice(0, 100),
        lastMessage: lastMsg.slice(0, 100),
        createdAt: c.created_at,
        updatedAt: c.updated_at,
        context: c.context,
        hasOrder,
        hasProduct,
      };
    });

    res.json({ conversations: convs });
  } catch (err) {
    console.error("Conversations error:", err);
    res.status(500).json({ error: "Error loading conversations" });
  }
});

// ── Conversación individual
app.get("/admin/conversations/:shop/:sessionId", async (req, res) => {
  const conv = await getConversation(req.params.sessionId);
  if (!conv) return res.status(404).json({ error: "Not found" });
  res.json(conv);
});

// ── Report / Insights
app.post("/admin/report/:shop", async (req, res) => {
  try {
    const analytics = await getAnalytics(req.params.shop);
    const { summary, topQuestions } = analytics;

    if (!summary.totalMessages) return res.json({ report: "Sin datos suficientes todavía." });

    const cr = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model: "claude-sonnet-4-20250514", max_tokens: 800,
        system: "Eres un analista de ecommerce. Insights concisos y accionables en español. Sin bullet points. Párrafos cortos.",
        messages: [{ role: "user", content: `Analiza estos datos de Shopi Advisor:\n\nSesiones de chat: ${summary.chatSessions}\nMensajes totales: ${summary.totalMessages}\nConsultas de pedidos: ${summary.orderQueries}\nCards de producto: ${summary.productCardShows}\nConversiones: ${summary.conversions}\nTasa conversión: ${summary.conversionRate}%\n\nPreguntas más frecuentes:\n${topQuestions.map(q => `- "${q.q}" (${q.count} veces)`).join("\n")}\n\nDa 4-5 insights accionables para mejorar el rendimiento del asistente.` }],
      }),
    });
    const d = await cr.json();
    res.json({ report: d.content?.[0]?.text });
  } catch { res.status(500).json({ error: "Error generando informe" }); }
});

// ── Analytics event (desde widget)
app.post("/analytics/event", async (req, res) => {
  const { shop, event } = req.body;
  if (shop && event) {
    await trackEvent(shop, event.sessionId, event.type, event).catch(() => {});
  }
  res.json({ ok: true });
});

// ─────────────────────────────────────────
// WIDGET CONFIG
// ─────────────────────────────────────────

app.get("/widget/config/:shop", async (req, res) => {
  const store = await getStore(req.params.shop);
  if (!store) return res.status(404).json({ error: "Store not configured" });

  // Si está desactivado, devolver señal al widget
  if (store.config?.active === false) {
    return res.json({ active: false });
  }

  res.json({
    active: true,
    assistantName: store.config?.assistantName,
    welcomeMessage: store.config?.welcomeMessage,
    primaryColor: store.config?.primaryColor,
    widgetPosition: store.config?.widgetPosition,
    triggerDelay: store.config?.triggerDelay,
    enableExitIntent: store.config?.enableExitIntent,
    freeShippingThreshold: store.config?.freeShippingThreshold || 50,
    language: store.config?.language || "auto",
  });
});

// ─────────────────────────────────────────
// START
// ─────────────────────────────────────────

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Shopi Advisor v6 running on :${PORT}`));
