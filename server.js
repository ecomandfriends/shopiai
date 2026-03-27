/**
 * SHOPI ADVISOR — Backend
 * Node.js + Express
 * Deploy: Railway
 */

import express from "express";
import cors from "cors";
import crypto from "crypto";
import fetch from "node-fetch";

const app = express();
app.use(express.json());
app.use(cors({ origin: "*" }));

const {
  SHOPIFY_CLIENT_ID,
  SHOPIFY_CLIENT_SECRET,
  ANTHROPIC_API_KEY,
  APP_URL,           // https://tu-app.railway.app
  DB_URL,            // Supabase/Firebase connection
} = process.env;

// ─────────────────────────────────────────
// IN-MEMORY STORE (reemplazar con Supabase)
// ─────────────────────────────────────────
const stores = new Map();        // shopDomain → storeConfig
const conversations = new Map(); // sessionId  → messages[]
const analytics = new Map();     // shopDomain → events[]

// ─────────────────────────────────────────
// SHOPIFY OAUTH
// ─────────────────────────────────────────

// 1. El cliente hace clic en "Instalar app"
app.get("/auth", (req, res) => {
  const { shop } = req.query;
  if (!shop) return res.status(400).send("Missing shop");

  const scopes = [
    "read_products",
    "read_collections",
    "read_orders",
    "read_customers",
    "read_inventory",
    "read_shipping",
    "read_content",        // páginas y blog
    "read_price_rules",    // descuentos
  ].join(",");

  const state = crypto.randomBytes(16).toString("hex");
  const redirectUri = `${APP_URL}/auth/callback`;

  const authUrl =
    `https://${shop}/admin/oauth/authorize` +
    `?client_id=${SHOPIFY_CLIENT_ID}` +
    `&scope=${scopes}` +
    `&redirect_uri=${redirectUri}` +
    `&state=${state}`;

  res.redirect(authUrl);
});

// 2. Shopify redirige de vuelta con el código
app.get("/auth/callback", async (req, res) => {
  const { shop, code, state } = req.query;

  try {
    // Intercambiar código por token permanente
    const tokenRes = await fetch(`https://${shop}/admin/oauth/access_token`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_id: SHOPIFY_CLIENT_ID,
        client_secret: SHOPIFY_CLIENT_SECRET,
        code,
      }),
    });

    const { access_token } = await tokenRes.json();

    // Guardar tienda con config inicial
    stores.set(shop, {
      shop,
      accessToken: access_token,
      installedAt: new Date().toISOString(),
      config: {
        assistantName: "Sara",
        tone: "friendly",      // friendly | professional | technical | motivational
        language: "es",
        triggerDelay: 3,       // segundos antes de aparecer
        widgetPosition: "right",
        primaryColor: "#18181b",
        welcomeMessage: "Hola 👋 ¿En qué puedo ayudarte?",
        enableOrderTracking: true,
        enableUpsell: true,
        enableExitIntent: true,
      },
      catalog: null,           // se rellena en syncCatalog
      systemPrompt: null,      // se genera automáticamente
      lastSync: null,
    });

    // Sincronizar catálogo automáticamente al instalar
    await syncCatalog(shop);

    // Redirigir al panel de admin
    res.redirect(`${APP_URL}/admin?shop=${shop}&installed=true`);
  } catch (err) {
    console.error("OAuth error:", err);
    res.status(500).send("Error durante la instalación");
  }
});

// ─────────────────────────────────────────
// SHOPIFY SYNC — Lee toda la tienda
// ─────────────────────────────────────────

async function shopifyFetch(shop, accessToken, endpoint) {
  const res = await fetch(
    `https://${shop}/admin/api/2024-01/${endpoint}`,
    { headers: { "X-Shopify-Access-Token": accessToken } }
  );
  return res.json();
}

async function syncCatalog(shop) {
  const store = stores.get(shop);
  if (!store) return;

  const { accessToken } = store;

  console.log(`Syncing catalog for ${shop}...`);

  try {
    // Leer en paralelo todo lo que necesitamos
    const [
      productsData,
      collectionsData,
      pagesData,
      shippingData,
      shopData,
    ] = await Promise.all([
      shopifyFetch(shop, accessToken, "products.json?limit=250&fields=id,title,body_html,variants,images,tags,product_type"),
      shopifyFetch(shop, accessToken, "custom_collections.json?limit=100"),
      shopifyFetch(shop, accessToken, "pages.json?limit=50&fields=title,body_html"),
      shopifyFetch(shop, accessToken, "shipping_zones.json"),
      shopifyFetch(shop, accessToken, "shop.json"),
    ]);

    const catalog = {
      shop: shopData.shop,
      products: productsData.products || [],
      collections: collectionsData.custom_collections || [],
      pages: pagesData.pages || [],
      shipping: shippingData.shipping_zones || [],
      syncedAt: new Date().toISOString(),
    };

    store.catalog = catalog;
    store.systemPrompt = generateSystemPrompt(store);
    store.lastSync = new Date().toISOString();

    console.log(`✓ Synced ${catalog.products.length} products for ${shop}`);
  } catch (err) {
    console.error(`Sync error for ${shop}:`, err);
  }
}

// Genera el system prompt automáticamente del catálogo
function generateSystemPrompt(store) {
  const { config, catalog } = store;
  if (!catalog) return null;

  const { products, shop, pages, shipping } = catalog;

  // Extraer info de envíos
  const shippingInfo = shipping
    .flatMap(z => z.price_based_shipping_rates || [])
    .map(r => `${r.name}: ${r.price === "0.00" ? "Gratis" : `€${r.price}`}`)
    .slice(0, 3)
    .join(", ") || "Consultar en tienda";

  // Extraer FAQ de páginas
  const faqPage = pages.find(p =>
    p.title.toLowerCase().includes("faq") ||
    p.title.toLowerCase().includes("pregunta")
  );
  const faqContent = faqPage
    ? faqPage.body_html.replace(/<[^>]+>/g, " ").slice(0, 800)
    : "";

  // Construir catálogo resumido
  const productList = products.slice(0, 50).map(p => {
    const price = p.variants?.[0]?.price || "?";
    const variants = p.variants?.map(v => v.title).filter(t => t !== "Default Title").join(", ");
    return `- ${p.title} (€${price})${variants ? ` [${variants}]` : ""}: ${p.body_html?.replace(/<[^>]+>/g, " ").slice(0, 100) || ""}`;
  }).join("\n");

  const toneGuide = {
    friendly: "Habla como una amiga de confianza. Tutea siempre. Natural, cercano, con emojis ocasionales. Máximo 2-3 frases por mensaje.",
    professional: "Tono profesional y claro. Usted. Preciso y sin rodeos. Máximo 2-3 frases.",
    technical: "Orientado a datos y especificaciones. Responde con detalles técnicos cuando sea relevante.",
    motivational: "Energético y motivador. Entusiasta pero sin ser agresivo. Emojis con moderación.",
  }[config.tone] || "Habla de forma natural y cercana.";

  return `Eres ${config.assistantName}, asistente de ventas de ${shop.name || shop}. ${toneGuide}

TIENDA: ${shop.name || shop}
IDIOMA: ${config.language === "es" ? "Español" : config.language === "ca" ? "Catalán" : "Inglés"}

CATÁLOGO (${products.length} productos):
${productList}

ENVÍOS: ${shippingInfo}

${faqContent ? `INFORMACIÓN FRECUENTE:\n${faqContent}\n` : ""}

INSTRUCCIONES CLAVE:
- Responde SIEMPRE en ${config.language === "es" ? "español" : config.language === "ca" ? "catalán" : "inglés"}.
- Máximo 2-3 frases por mensaje. Nunca hagas listas largas.
- Si el cliente pregunta por su pedido, pide su email o número de pedido y usa la función check_order.
- Cuando detectes intención de compra clara, sugiere el producto o bundle más relevante.
- Si el cliente lleva tiempo sin responder o muestra señales de abandono, haz una pregunta concreta para reengancharlo.
- Nunca menciones a la competencia ni hagas promesas que no puedas cumplir.
- Si no sabes algo, sé honesto: "Déjame confirmarlo con el equipo" y ofrece contacto.

UPSELL NATURAL:
- Solo sugiere productos adicionales si son genuinamente relevantes para lo que busca el cliente.
- Nunca más de una sugerencia por conversación hasta que el cliente muestre interés.
- Enmarca siempre el upsell como un beneficio para el cliente, no como una venta.

TRACKING DE PEDIDOS:
- Si el cliente pregunta por un pedido, extrae el email o número de pedido de su mensaje.
- Llama a la función check_order con esos datos.
- Devuelve el estado de forma clara y humana.`;
}

// ─────────────────────────────────────────
// ORDER TRACKING
// ─────────────────────────────────────────

async function getOrderStatus(shop, query) {
  const store = stores.get(shop);
  if (!store) return null;

  try {
    // Buscar por email o número de pedido
    const isEmail = query.includes("@");
    const endpoint = isEmail
      ? `orders.json?email=${encodeURIComponent(query)}&limit=5&fields=id,name,fulfillment_status,financial_status,created_at,line_items`
      : `orders.json?name=${encodeURIComponent(query)}&limit=1&fields=id,name,fulfillment_status,financial_status,created_at,line_items`;

    const data = await shopifyFetch(shop, store.accessToken, endpoint);
    const orders = data.orders || [];

    if (!orders.length) return null;

    return orders.map(o => ({
      name: o.name,
      status: o.fulfillment_status || "pendiente",
      payment: o.financial_status,
      date: new Date(o.created_at).toLocaleDateString("es-ES"),
      items: o.line_items?.map(i => i.name).join(", "),
    }));
  } catch (err) {
    console.error("Order tracking error:", err);
    return null;
  }
}

// ─────────────────────────────────────────
// CHAT ENDPOINT — El núcleo del asistente
// ─────────────────────────────────────────

app.post("/chat", async (req, res) => {
  const { shop, sessionId, message, context } = req.body;

  if (!shop || !message) {
    return res.status(400).json({ error: "Missing shop or message" });
  }

  const store = stores.get(shop);
  if (!store) {
    return res.status(404).json({ error: "Store not found" });
  }

  // Inicializar historial de conversación
  if (!conversations.has(sessionId)) {
    conversations.set(sessionId, []);
  }
  const history = conversations.get(sessionId);

  // Detectar si pregunta por pedido
  const orderQuery = extractOrderQuery(message);
  let orderData = null;
  if (orderQuery && store.config.enableOrderTracking) {
    orderData = await getOrderStatus(shop, orderQuery);
  }

  // Construir mensajes para Claude
  const userContent = orderData
    ? `${message}\n\n[DATOS DEL PEDIDO: ${JSON.stringify(orderData)}]`
    : message;

  history.push({ role: "user", content: userContent });

  // Contexto adicional del cliente (producto viendo, carrito, etc.)
  const contextInfo = context
    ? `\n[CONTEXTO: El cliente está viendo "${context.productTitle || ""}", lleva ${context.timeOnPage || 0}s en la página, carrito: ${context.cartItems || 0} items]`
    : "";

  try {
    const claudeRes = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-20250514",
        max_tokens: 500,
        system: (store.systemPrompt || "Eres un asistente de tienda.") + contextInfo,
        messages: history.slice(-10), // últimos 10 mensajes para no pasarnos de tokens
      }),
    });

    const claudeData = await claudeRes.json();
    const reply = claudeData.content?.[0]?.text || "Lo siento, ha habido un error.";

    // Guardar respuesta en historial
    history.push({ role: "assistant", content: reply });

    // Guardar analytics
    trackEvent(shop, {
      type: "message",
      sessionId,
      message,
      reply,
      context,
      orderQuery: !!orderQuery,
      timestamp: new Date().toISOString(),
    });

    res.json({
      reply,
      hasOrderData: !!orderData,
      sessionId,
    });

  } catch (err) {
    console.error("Claude error:", err);
    res.status(500).json({ error: "Error del asistente" });
  }
});

// Detecta si el mensaje contiene una query de pedido
function extractOrderQuery(message) {
  const emailMatch = message.match(/[\w.-]+@[\w.-]+\.\w+/);
  if (emailMatch) return emailMatch[0];

  const orderMatch = message.match(/#?(\d{4,})/);
  if (orderMatch) return `#${orderMatch[1]}`;

  const keywords = ["pedido", "orden", "compra", "envío", "paquete", "entrega"];
  const hasKeyword = keywords.some(k => message.toLowerCase().includes(k));
  return hasKeyword ? "NEEDS_EMAIL" : null;
}

// ─────────────────────────────────────────
// ANALYTICS TRACKING
// ─────────────────────────────────────────

function trackEvent(shop, event) {
  if (!analytics.has(shop)) analytics.set(shop, []);
  const events = analytics.get(shop);
  events.push(event);
  // Mantener solo últimos 10.000 eventos en memoria
  if (events.length > 10000) events.splice(0, events.length - 10000);
}

app.post("/analytics/event", (req, res) => {
  const { shop, event } = req.body;
  if (!shop || !event) return res.status(400).json({ error: "Missing data" });
  trackEvent(shop, { ...event, timestamp: new Date().toISOString() });
  res.json({ ok: true });
});

app.get("/analytics/:shop", (req, res) => {
  const { shop } = req.params;
  const events = analytics.get(shop) || [];

  const messages = events.filter(e => e.type === "message");
  const pageViews = events.filter(e => e.type === "pageview");
  const clicks = events.filter(e => e.type === "click");
  const conversions = events.filter(e => e.type === "conversion");
  const exits = events.filter(e => e.type === "exit_intent");

  // Preguntas más frecuentes
  const questionFreq = {};
  messages.forEach(e => {
    const q = e.message?.toLowerCase().slice(0, 60);
    if (q) questionFreq[q] = (questionFreq[q] || 0) + 1;
  });
  const topQuestions = Object.entries(questionFreq)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([q, count]) => ({ q, count }));

  // Productos más vistos
  const productViews = {};
  pageViews.forEach(e => {
    if (e.product) productViews[e.product] = (productViews[e.product] || 0) + 1;
  });

  // Tasa de conversión del chat
  const chatSessions = new Set(messages.map(e => e.sessionId)).size;
  const convertedSessions = new Set(conversions.map(e => e.sessionId)).size;

  res.json({
    period: "últimos 30 días",
    summary: {
      totalEvents: events.length,
      pageViews: pageViews.length,
      chatSessions,
      conversions: convertedSessions,
      conversionRate: chatSessions ? ((convertedSessions / chatSessions) * 100).toFixed(1) : 0,
      exitIntents: exits.length,
      exitRecovery: exits.filter(e => e.recovered).length,
    },
    topQuestions,
    productViews: Object.entries(productViews)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([product, views]) => ({ product, views })),
    clicks: clicks.reduce((acc, e) => {
      acc[e.zone] = (acc[e.zone] || 0) + 1;
      return acc;
    }, {}),
  });
});

// ─────────────────────────────────────────
// ADMIN API — Config del panel
// ─────────────────────────────────────────

// Obtener config de la tienda
app.get("/admin/config/:shop", (req, res) => {
  const store = stores.get(req.params.shop);
  if (!store) return res.status(404).json({ error: "Store not found" });
  res.json({
    config: store.config,
    lastSync: store.lastSync,
    productCount: store.catalog?.products?.length || 0,
  });
});

// Actualizar config
app.patch("/admin/config/:shop", (req, res) => {
  const store = stores.get(req.params.shop);
  if (!store) return res.status(404).json({ error: "Store not found" });

  store.config = { ...store.config, ...req.body };
  store.systemPrompt = generateSystemPrompt(store); // Regenerar prompt
  res.json({ ok: true, config: store.config });
});

// Forzar re-sync del catálogo
app.post("/admin/sync/:shop", async (req, res) => {
  const shop = req.params.shop;
  await syncCatalog(shop);
  const store = stores.get(shop);
  res.json({
    ok: true,
    productCount: store?.catalog?.products?.length || 0,
    lastSync: store?.lastSync,
  });
});

// Generar informe IA
app.post("/admin/report/:shop", async (req, res) => {
  const shop = req.params.shop;
  const analyticsData = analytics.get(shop) || [];

  if (!analyticsData.length) {
    return res.json({ report: "Sin datos suficientes para generar un informe." });
  }

  const summary = `Tienda: ${shop}\nEventos: ${analyticsData.length}\nConversaciones: ${analyticsData.filter(e => e.type === "message").length}`;

  try {
    const claudeRes = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-20250514",
        max_tokens: 1000,
        system: "Eres un analista de ecommerce. Genera informes concisos con insights accionables en español. Usa datos concretos.",
        messages: [{
          role: "user",
          content: `Analiza estos datos de comportamiento de una tienda Shopify y genera 5 insights accionables con recomendaciones concretas:\n\n${summary}\n\nPreguntas más frecuentes:\n${analyticsData.filter(e => e.type === "message").slice(0, 20).map(e => e.message).join("\n")}`,
        }],
      }),
    });

    const data = await claudeRes.json();
    res.json({ report: data.content?.[0]?.text });
  } catch (err) {
    res.status(500).json({ error: "Error generando informe" });
  }
});

// ─────────────────────────────────────────
// WIDGET CONFIG — Lo que sirve al widget JS
// ─────────────────────────────────────────

app.get("/widget/config/:shop", (req, res) => {
  const store = stores.get(req.params.shop);
  if (!store) return res.status(404).json({ error: "Store not configured" });

  // Solo devuelve lo que necesita el widget público
  res.json({
    assistantName: store.config.assistantName,
    welcomeMessage: store.config.welcomeMessage,
    primaryColor: store.config.primaryColor,
    widgetPosition: store.config.widgetPosition,
    triggerDelay: store.config.triggerDelay,
    enableExitIntent: store.config.enableExitIntent,
    language: store.config.language,
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Shopi Advisor backend running on :${PORT}`));
