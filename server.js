import express from "express";
import cors from "cors";
import crypto from "crypto";
import fetch from "node-fetch";
import { createClient } from "@supabase/supabase-js";

const app = express();
app.use(express.json());
app.use(cors({ origin: "*" }));

const {
  SHOPIFY_CLIENT_ID,
  SHOPIFY_CLIENT_SECRET,
  ANTHROPIC_API_KEY,
  APP_URL,
  SUPABASE_URL,
  SUPABASE_KEY,
} = process.env;

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

const analytics = new Map();
const conversations = new Map();

async function getStore(shop) {
  const { data, error } = await supabase
    .from("stores")
    .select("*")
    .eq("shop", shop)
    .single();
  if (error) return null;
  return data;
}

async function saveStore(shop, data) {
  const { error } = await supabase
    .from("stores")
    .upsert({ shop, ...data }, { onConflict: "shop" });
  if (error) console.error("Supabase save error:", error.message);
  else console.log("Saved store:", shop);
}

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
    "read_content",
    "read_price_rules",
  ].join(",");

  const state = crypto.randomBytes(16).toString("hex");
  const redirectUri = `${APP_URL}/auth/callback`;

  const authUrl =
    `https://${shop}/admin/oauth/authorize` +
    `?client_id=${SHOPIFY_CLIENT_ID}` +
    `&scope=${scopes}` +
    `&redirect_uri=${encodeURIComponent(redirectUri)}` +
    `&state=${state}`;

  res.redirect(authUrl);
});

app.get("/auth/callback", async (req, res) => {
  const { shop, code } = req.query;

  try {
    const tokenRes = await fetch(`https://${shop}/admin/oauth/access_token`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_id: SHOPIFY_CLIENT_ID,
        client_secret: SHOPIFY_CLIENT_SECRET,
        code,
      }),
    });

    const tokenData = await tokenRes.json();
    const access_token = tokenData.access_token;

    console.log("Token received:", access_token ? "YES" : "NO");

    if (!access_token) {
      return res.status(400).send("No access token: " + JSON.stringify(tokenData));
    }

    const defaultConfig = {
      assistantName: "Sara",
      tone: "friendly",
      language: "es",
      triggerDelay: 3,
      widgetPosition: "right",
      primaryColor: "#18181b",
      welcomeMessage: "Hola 👋 ¿En qué puedo ayudarte?",
      enableOrderTracking: true,
      enableUpsell: true,
      enableExitIntent: true,
    };

    await saveStore(shop, {
      access_token,
      config: defaultConfig,
      installed_at: new Date().toISOString(),
    });

    console.log("Store saved, starting sync for:", shop);
    syncCatalog(shop).catch(console.error);

    res.send(`
      <html><body style="font-family:sans-serif;text-align:center;padding:60px">
        <h2>✓ Shopi Advisor instalado</h2>
        <p>Sara está sincronizando tu catálogo...</p>
        <p style="color:#666;font-size:13px">${shop}</p>
      </body></html>
    `);
  } catch (err) {
    console.error("OAuth error:", err);
    res.status(500).send("Error: " + err.message);
  }
});

async function shopifyFetch(shop, accessToken, endpoint) {
  const res = await fetch(
    `https://${shop}/admin/api/2024-01/${endpoint}`,
    { headers: { "X-Shopify-Access-Token": accessToken } }
  );
  if (!res.ok) throw new Error(`Shopify API error: ${res.status}`);
  return res.json();
}

async function syncCatalog(shop) {
  const store = await getStore(shop);
  if (!store?.access_token) {
    console.error("No access token for:", shop);
    return 0;
  }

  console.log("Syncing catalog for:", shop);

  try {
    const [productsData, pagesData, shopData] = await Promise.all([
      shopifyFetch(shop, store.access_token, "products.json?limit=250&fields=id,title,body_html,variants,tags,product_type"),
      shopifyFetch(shop, store.access_token, "pages.json?limit=50&fields=title,body_html"),
      shopifyFetch(shop, store.access_token, "shop.json"),
    ]);

    const catalog = {
      shop: shopData.shop,
      products: productsData.products || [],
      pages: pagesData.pages || [],
      syncedAt: new Date().toISOString(),
    };

    const systemPrompt = generateSystemPrompt(store.config, catalog);

    await saveStore(shop, {
      access_token: store.access_token,
      config: store.config,
      catalog,
      system_prompt: systemPrompt,
      last_sync: new Date().toISOString(),
    });

    console.log("Synced products:", catalog.products.length, "for:", shop);
    return catalog.products.length;
  } catch (err) {
    console.error("Sync error:", err.message);
    return 0;
  }
}

function generateSystemPrompt(config, catalog) {
  const { products, shop } = catalog;

  const productList = products.slice(0, 50).map(p => {
    const price = p.variants?.[0]?.price || "?";
    const variants = p.variants?.map(v => v.title).filter(t => t !== "Default Title").join(", ");
    const desc = p.body_html?.replace(/<[^>]+>/g, " ").slice(0, 100) || "";
    return `- ${p.title} (€${price})${variants ? ` [${variants}]` : ""}: ${desc}`;
  }).join("\n");

  const toneGuide = {
    friendly: "Habla como una amiga de confianza. Tutea siempre. Natural, cercano, con emojis ocasionales. Máximo 2-3 frases por mensaje.",
    professional: "Tono profesional y claro. Preciso y sin rodeos.",
    technical: "Orientado a datos y especificaciones técnicas.",
    motivational: "Energético y motivador.",
  }[config?.tone] || "Habla de forma natural y cercana.";

  return `Eres ${config?.assistantName || "Sara"}, asistente de ventas de ${shop?.name || shop}. ${toneGuide}

CATÁLOGO (${products.length} productos):
${productList || "Sin productos disponibles"}

INSTRUCCIONES:
- Responde SIEMPRE en español.
- Máximo 2-3 frases por mensaje.
- Si el cliente pregunta por su pedido, pide su email o número de pedido.
- Cuando detectes intención de compra, sugiere el producto más relevante.
- Si el cliente duda, haz una pregunta concreta para reengancharlo.`;
}

app.post("/chat", async (req, res) => {
  const { shop, sessionId, message, context } = req.body;
  if (!shop || !message) return res.status(400).json({ error: "Missing data" });

  const store = await getStore(shop);
  if (!store) return res.status(404).json({ error: "Store not found" });

  if (!conversations.has(sessionId)) conversations.set(sessionId, []);
  const history = conversations.get(sessionId);
  history.push({ role: "user", content: message });

  const contextInfo = context?.productTitle
    ? `\n[Cliente mirando: "${context.productTitle}"]`
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
        system: (store.system_prompt || "Eres un asistente de tienda.") + contextInfo,
        messages: history.slice(-10),
      }),
    });

    const claudeData = await claudeRes.json();
    const reply = claudeData.content?.[0]?.text || "Lo siento, ha habido un error.";
    history.push({ role: "assistant", content: reply });

    res.json({ reply, sessionId });
  } catch (err) {
    console.error("Claude error:", err);
    res.status(500).json({ error: "Error del asistente" });
  }
});

app.get("/admin/config/:shop", async (req, res) => {
  const store = await getStore(req.params.shop);
  if (!store) return res.status(404).json({ error: "Store not found" });
  res.json({
    config: store.config,
    lastSync: store.last_sync,
    productCount: store.catalog?.products?.length || 0,
  });
});

app.patch("/admin/config/:shop", async (req, res) => {
  const store = await getStore(req.params.shop);
  if (!store) return res.status(404).json({ error: "Store not found" });
  const newConfig = { ...store.config, ...req.body };
  await saveStore(req.params.shop, {
    access_token: store.access_token,
    config: newConfig,
    catalog: store.catalog,
    system_prompt: store.system_prompt,
    last_sync: store.last_sync,
  });
  res.json({ ok: true, config: newConfig });
});

app.post("/admin/sync/:shop", async (req, res) => {
  const shop = req.params.shop;
  const productCount = await syncCatalog(shop);
  const store = await getStore(shop);
  res.json({ ok: true, productCount: productCount || 0, lastSync: store?.last_sync });
});

app.post("/analytics/event", (req, res) => {
  const { shop, event } = req.body;
  if (shop && event) {
    if (!analytics.has(shop)) analytics.set(shop, []);
    analytics.get(shop).push({ ...event, timestamp: new Date().toISOString() });
  }
  res.json({ ok: true });
});

app.get("/analytics/:shop", (req, res) => {
  const events = analytics.get(req.params.shop) || [];
  res.json({ events: events.length });
});

app.get("/widget/config/:shop", async (req, res) => {
  const store = await getStore(req.params.shop);
  if (!store) return res.status(404).json({ error: "Store not configured" });
  res.json({
    assistantName: store.config?.assistantName,
    welcomeMessage: store.config?.welcomeMessage,
    primaryColor: store.config?.primaryColor,
    widgetPosition: store.config?.widgetPosition,
    triggerDelay: store.config?.triggerDelay,
    enableExitIntent: store.config?.enableExitIntent,
    language: store.config?.language,
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Shopi Advisor backend running on :${PORT}`));