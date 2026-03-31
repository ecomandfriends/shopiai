/**
 * SHOPI ADVISOR — Widget v6
 * Fixes: links clicables, nombre asistente, doble orbe, 
 * idioma automático, historial sesión, envío gratis como mensaje,
 * product cards con imagen + añadir al carrito
 */
(function () {
  "use strict";

  const BACKEND = "https://shopiai-production.up.railway.app";
  const script = document.currentScript;
  const SHOP = script?.getAttribute("data-shop") || window.Shopify?.shop;
  const SESSION_KEY = "sa_session_" + (SHOP || "").replace(/\./g, "_");
  const SESSION_ID = (() => {
    let id = sessionStorage.getItem(SESSION_KEY + "_id");
    if (!id) { id = "sa_" + Math.random().toString(36).slice(2) + Date.now().toString(36); sessionStorage.setItem(SESSION_KEY + "_id", id); }
    return id;
  })();

  if (!SHOP) return;

  const IS_HELP_PAGE = window.location.pathname.includes("/pages/ayuda") ||
                       window.location.pathname.includes("/pages/help") ||
                       window.location.pathname.includes("/pages/asistente");

  // Detectar idioma del navegador
  const BROWSER_LANG = navigator.language?.slice(0, 2) || "es";
  const LANG_MAP = {
    es: { open: "Hablar ahora", dismiss: "Ahora no", online: "En línea ahora", typing: "Escribiendo...", placeholder: "Escribe un mensaje...", addCart: "Añadir", viewProduct: "Ver", brand: "Shopi Advisor" },
    ca: { open: "Parlar ara", dismiss: "Ara no", online: "En línia ara", typing: "Escrivint...", placeholder: "Escriu un missatge...", addCart: "Afegir", viewProduct: "Veure", brand: "Shopi Advisor" },
    en: { open: "Talk now", dismiss: "Not now", online: "Online now", typing: "Typing...", placeholder: "Write a message...", addCart: "Add", viewProduct: "View", brand: "Shopi Advisor" },
    fr: { open: "Parler maintenant", dismiss: "Pas maintenant", online: "En ligne", typing: "En train d'écrire...", placeholder: "Écrire un message...", addCart: "Ajouter", viewProduct: "Voir", brand: "Shopi Advisor" },
    de: { open: "Jetzt sprechen", dismiss: "Nicht jetzt", online: "Online", typing: "Schreibt...", placeholder: "Nachricht schreiben...", addCart: "Hinzufügen", viewProduct: "Ansehen", brand: "Shopi Advisor" },
    pt: { open: "Falar agora", dismiss: "Agora não", online: "Online agora", typing: "A escrever...", placeholder: "Escreve uma mensagem...", addCart: "Adicionar", viewProduct: "Ver", brand: "Shopi Advisor" },
  };
  const T = LANG_MAP[BROWSER_LANG] || LANG_MAP.es;

  let widgetConfig = null;
  let isOpen = IS_HELP_PAGE;
  let isLoading = false;
  let nudgeShown = false;
  let exitListenerAdded = false;
  let cartState = { items: [], total: 0, count: 0 };
  let pageVisits = JSON.parse(sessionStorage.getItem("sa_visits") || "{}");
  let currentProduct = null;
  let pageEntryTime = Date.now();
  let triggerTimer = null;
  let lastCartCount = 0;

  // ── Historial de conversación persistente en sesión
  let messages = (() => {
    try {
      const saved = sessionStorage.getItem(SESSION_KEY + "_msgs");
      return saved ? JSON.parse(saved) : [];
    } catch { return []; }
  })();

  function saveMessages() {
    try { sessionStorage.setItem(SESSION_KEY + "_msgs", JSON.stringify(messages.slice(-20))); } catch {}
  }

  // ── Carrito: flag para evitar mostrar pill fija
  let freeShippingMessageShown = false;

  init();

  async function init() {
    try {
      const res = await fetch(`${BACKEND}/widget/config/${SHOP}`);
      widgetConfig = await res.json();
    } catch {
      widgetConfig = { assistantName: "Sara", welcomeMessage: "¿En qué puedo ayudarte?", primaryColor: "#1c1c18", widgetPosition: "right", triggerDelay: 4, enableExitIntent: true, freeShippingThreshold: 50 };
    }

    currentProduct = detectProduct();
    trackPageVisit();
    injectStyles();
    createWidget();
    monitorCart();
    if (!IS_HELP_PAGE) setupTriggers();
    trackBehavior();

    if (IS_HELP_PAGE) setTimeout(() => openChat(true), 400);
  }

  function detectProduct() {
    const meta = window.ShopifyAnalytics?.meta?.product;
    if (meta) return { id: meta.id, title: meta.title, price: meta.variants?.[0]?.price, type: "product" };
    const title = document.querySelector(".product__title, .product-title, h1.title")?.textContent?.trim();
    if (title) return { title, type: "product" };
    if (window.location.pathname.includes("/cart")) return { type: "cart" };
    if (window.location.pathname.includes("/collections")) return { type: "collection" };
    if (window.location.pathname.includes("/blogs")) return { type: "blog" };
    return { type: "general" };
  }

  function trackPageVisit() {
    const key = window.location.pathname;
    pageVisits[key] = (pageVisits[key] || 0) + 1;
    sessionStorage.setItem("sa_visits", JSON.stringify(pageVisits));
  }

  function isReturning() { return (pageVisits[window.location.pathname] || 0) > 1; }

  // ── CARRITO — sin pill fija, solo mensajes contextuales
  async function monitorCart() {
    const update = async () => {
      try {
        const res = await fetch("/cart.js");
        const cart = await res.json();
        const newCount = cart.item_count;
        const newTotal = cart.total_price / 100;
        const threshold = widgetConfig?.freeShippingThreshold || 50;
        const remaining = threshold - newTotal;

        // Producto añadido
        if (newCount > lastCartCount && lastCartCount > 0) {
          if (remaining > 0 && remaining < threshold * 0.4 && !freeShippingMessageShown) {
            freeShippingMessageShown = true;
            const msg = remaining <= 5
              ? `Casi tienes envío gratis — solo te faltan €${remaining.toFixed(2)}.`
              : `Con €${remaining.toFixed(2)} más tienes envío gratis.`;
            if (isOpen) {
              addAIBubble(msg, true);
            } else {
              showGlassNudge(widgetConfig?.assistantName || "Sara", msg);
            }
          } else if (remaining <= 0 && !freeShippingMessageShown) {
            freeShippingMessageShown = true;
            if (isOpen) addAIBubble("¡Tienes envío gratis en este pedido!", true);
          }
        }

        lastCartCount = newCount;
        cartState = { items: cart.items || [], total: newTotal, count: newCount };
      } catch {}
    };

    await update();
    setInterval(update, 3000);
  }

  function setupTriggers() {
    const delay = (widgetConfig?.triggerDelay || 4) * 1000;

    if (currentProduct?.type === "product") {
      triggerTimer = setTimeout(() => {
        if (!isOpen && !nudgeShown) {
          pulseOrb();
          setTimeout(() => {
            if (!isOpen && !nudgeShown) {
              showGlassNudge(
                widgetConfig?.assistantName || "Sara",
                isReturning() ? `¿Tienes alguna duda sobre ${currentProduct.title}?` : `¿Puedo ayudarte con algo?`
              );
            }
          }, 700);
        }
      }, delay);
    }

    if (["collection", "general", "blog"].includes(currentProduct?.type)) {
      setTimeout(() => {
        if (!isOpen && !nudgeShown) showGlassNudge(widgetConfig?.assistantName || "Sara", "¿En qué puedo ayudarte?");
      }, delay * 1.8);
    }

    if (widgetConfig?.enableExitIntent && !exitListenerAdded) {
      exitListenerAdded = true;
      document.addEventListener("mouseleave", (e) => {
        if (e.clientY <= 0 && cartState.count > 0 && !nudgeShown) {
          showGlassNudge(widgetConfig?.assistantName || "Sara", `Tienes ${cartState.count} producto${cartState.count > 1 ? "s" : ""} en el carrito. ¿Te ayudo?`);
          trackEvent("exit_intent", { cartTotal: cartState.total });
        }
      });
    }
  }

  function pulseOrb() {
    const orb = document.getElementById("sa-fab-orb-el");
    if (orb) { orb.style.transform = "scale(1.15)"; setTimeout(() => orb.style.transform = "", 600); }
  }

  function trackBehavior() {
    trackEvent("pageview", { product: currentProduct?.title, type: currentProduct?.type, url: window.location.href, lang: BROWSER_LANG });
    window.addEventListener("beforeunload", () => trackEvent("pageleave", { timeOnPage: Math.round((Date.now() - pageEntryTime) / 1000), cartTotal: cartState.total, chatOpened: isOpen }));
  }

  function trackEvent(type, data) {
    fetch(`${BACKEND}/analytics/event`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ shop: SHOP, event: { type, sessionId: SESSION_ID, ...data } }) }).catch(() => {});
  }

  // ── ORB CSS
  const ORB_CSS = `
    .sa-orb { position:relative; border-radius:50%; overflow:hidden; flex-shrink:0; transition:transform 0.3s; }
    .sa-orb::before,.sa-orb::after,.sa-orb-inner { content:''; position:absolute; inset:-30%; border-radius:40%; }
    .sa-orb::before { background:radial-gradient(ellipse 90% 80% at 45% 28%,#cc2200 0%,#ee4400 20%,#ff6600 42%,#ff9500 65%,#ffcc00 100%); animation:saOrbR 8s linear infinite; }
    .sa-orb::after { background:radial-gradient(circle 50% at 50% 70%,rgba(255,240,60,.95) 0%,rgba(255,200,0,.70) 25%,rgba(255,150,0,.30) 60%,transparent 100%); animation:saOrbH 5s ease-in-out infinite; }
    .sa-orb-inner { background:radial-gradient(ellipse 75% 55% at 40% 18%,rgba(140,10,0,.65) 0%,rgba(180,30,0,.35) 45%,transparent 100%); animation:saOrbD 7s ease-in-out infinite alternate; }
    @keyframes saOrbR { from{transform:rotate(0deg)} to{transform:rotate(360deg)} }
    @keyframes saOrbH { 0%{transform:rotate(0deg) scale(1)} 33%{transform:rotate(120deg) scale(1.1)} 66%{transform:rotate(240deg) scale(.95)} 100%{transform:rotate(360deg) scale(1)} }
    @keyframes saOrbD { 0%{transform:rotate(0deg);opacity:.8} 50%{transform:rotate(30deg);opacity:1} 100%{transform:rotate(-15deg);opacity:.7} }
  `;

  function makeOrb(size) {
    const d = document.createElement("div");
    d.className = "sa-orb";
    d.style.cssText = `width:${size}px;height:${size}px`;
    const i = document.createElement("div");
    i.className = "sa-orb-inner";
    d.appendChild(i);
    return d;
  }

  function injectStyles() {
    const pos = widgetConfig?.widgetPosition || "right";
    const s = document.createElement("style");
    s.textContent = `
      @import url('https://fonts.googleapis.com/css2?family=DM+Sans:wght@300;400;500;600&display=swap');
      #sa-root * { box-sizing:border-box; font-family:'DM Sans',-apple-system,'Helvetica Neue',Arial,sans-serif; }
      #sa-root { position:fixed; bottom:24px; ${pos}:20px; z-index:2147483647; display:flex; flex-direction:column; align-items:flex-end; gap:12px; }
      ${ORB_CSS}

      @keyframes saUp { from{transform:translateY(16px);opacity:0} to{transform:translateY(0);opacity:1} }
      @keyframes saIn { from{transform:scale(0.92) translateY(12px);opacity:0} to{transform:scale(1) translateY(0);opacity:1} }
      @keyframes saDot { 0%,60%,100%{transform:translateY(0);opacity:.4} 30%{transform:translateY(-4px);opacity:1} }
      @keyframes saGlow { 0%,100%{opacity:1} 50%{opacity:.5} }
      @keyframes saFabIn { from{transform:scale(0) rotate(-90deg);opacity:0} to{transform:scale(1) rotate(0deg);opacity:1} }

      /* ── GLASS NUDGE */
      #sa-nudge { display:none; max-width:290px; animation:saUp 0.45s cubic-bezier(0.34,1.2,0.64,1); }
      .sa-ng {
        background:rgba(255,255,255,0.75);
        backdrop-filter:blur(28px) saturate(180%);
        -webkit-backdrop-filter:blur(28px) saturate(180%);
        border:1px solid rgba(255,255,255,0.92);
        border-radius:20px; padding:14px 16px;
        box-shadow:0 8px 32px rgba(0,0,0,0.09),0 2px 8px rgba(0,0,0,0.04),inset 0 1px 0 rgba(255,255,255,0.95);
        position:relative; overflow:hidden;
      }
      .sa-ng::before { content:''; position:absolute; top:-20px; left:-20px; width:80px; height:80px; background:radial-gradient(circle,rgba(255,120,0,.12) 0%,transparent 70%); pointer-events:none; }
      .sa-ng-inner { display:flex; align-items:flex-start; gap:11px; position:relative; }
      .sa-ng-text { flex:1; padding-right:20px; }
      .sa-ng-title { font-size:13px; font-weight:600; color:#1c1c18; letter-spacing:-.01em; margin-bottom:2px; }
      .sa-ng-desc { font-size:12px; color:rgba(28,28,24,.5); line-height:1.45; }
      .sa-ng-close {
        position:absolute; top:10px; right:12px;
        width:22px; height:22px; background:rgba(0,0,0,.06);
        border:none; border-radius:50%; color:rgba(0,0,0,.35);
        cursor:pointer; font-size:13px; display:flex;
        align-items:center; justify-content:center; transition:background .15s;
        line-height:1;
      }
      .sa-ng-close:hover { background:rgba(0,0,0,.12); color:rgba(0,0,0,.6); }
      .sa-ng-actions { display:flex; gap:7px; margin-top:12px; }
      .sa-ng-cta { flex:1; background:#1c1c18; color:#fff; border:none; border-radius:10px; padding:9px 14px; font-size:12.5px; font-weight:600; cursor:pointer; font-family:inherit; letter-spacing:-.01em; transition:opacity .15s; }
      .sa-ng-cta:hover { opacity:.85; }
      .sa-ng-skip { background:transparent; border:1px solid rgba(0,0,0,.1); border-radius:10px; padding:9px 12px; font-size:12.5px; color:rgba(28,28,24,.4); cursor:pointer; font-family:inherit; transition:all .15s; }
      .sa-ng-skip:hover { border-color:rgba(0,0,0,.2); color:rgba(28,28,24,.65); }

      /* ── FAB */
      #sa-fab { width:56px; height:56px; border:none; cursor:pointer; position:relative; flex-shrink:0; background:transparent; padding:0; animation:saFabIn 0.5s cubic-bezier(0.34,1.2,0.64,1); transition:transform 0.25s cubic-bezier(0.34,1.4,0.64,1); }
      #sa-fab:hover { transform:scale(1.06); }
      #sa-fab:active { transform:scale(0.96); }
      #sa-fab-x { position:absolute; inset:0; display:none; align-items:center; justify-content:center; background:#1c1c18; border-radius:50%; color:#fff; font-size:20px; font-weight:300; }
      #sa-fab-x.v { display:flex; }
      #sa-unread { position:absolute; top:-3px; right:-3px; width:18px; height:18px; background:#ef4444; border-radius:50%; border:2.5px solid white; display:none; align-items:center; justify-content:center; font-size:9px; font-weight:700; color:#fff; animation:saUp 0.3s ease; }
      #sa-unread.v { display:flex; }

      /* ── CHAT */
      #sa-chat { width:350px; background:#fff; border:1px solid rgba(0,0,0,.07); border-radius:22px; box-shadow:0 20px 60px rgba(0,0,0,.12),0 4px 16px rgba(0,0,0,.06); display:none; flex-direction:column; max-height:560px; overflow:hidden; animation:saIn 0.38s cubic-bezier(0.34,1.2,0.64,1); }
      #sa-chat.open { display:flex; }

      /* Header */
      #sa-hdr { padding:14px 16px 12px; border-bottom:1px solid rgba(0,0,0,.06); display:flex; align-items:center; gap:12px; flex-shrink:0; background:#fafaf9; }
      #sa-hdr-orb { position:relative; flex-shrink:0; }
      #sa-sdot { position:absolute; bottom:0; right:0; width:10px; height:10px; background:#22c55e; border-radius:50%; border:2px solid #fafaf9; animation:saGlow 2.5s ease-in-out infinite; z-index:10; }
      #sa-hdr-name { font-size:14px; font-weight:600; color:#1c1c18; letter-spacing:-.02em; }
      #sa-hdr-sub { font-size:11px; color:#a8a89e; margin-top:1px; display:flex; align-items:center; gap:4px; }
      #sa-hdr-sub::before { content:''; width:6px; height:6px; background:#22c55e; border-radius:50%; display:inline-block; animation:saGlow 2.5s ease-in-out infinite; }
      #sa-close { width:28px; height:28px; border-radius:8px; border:1px solid rgba(0,0,0,.08); background:rgba(0,0,0,.04); color:#a8a89e; cursor:pointer; font-size:16px; display:flex; align-items:center; justify-content:center; transition:all .15s; margin-left:auto; }
      #sa-close:hover { color:#1c1c18; background:rgba(0,0,0,.08); }

      /* Messages */
      #sa-msgs { flex:1; overflow-y:auto; padding:14px 14px 8px; display:flex; flex-direction:column; gap:10px; scrollbar-width:none; }
      #sa-msgs::-webkit-scrollbar { display:none; }

      .sa-user { align-self:flex-end; background:#1c1c18; color:#fff; border-radius:16px 16px 4px 16px; padding:10px 14px; max-width:80%; font-size:13.5px; line-height:1.5; animation:saUp 0.22s ease; letter-spacing:-.01em; }
      .sa-ai-row { display:flex; gap:9px; align-items:flex-start; animation:saUp 0.22s ease; }
      .sa-ai-av { flex-shrink:0; margin-top:2px; }

      .sa-bubble { background:#f4f4f2; border-radius:16px 16px 16px 4px; padding:10px 14px; font-size:13.5px; color:#1c1c18; line-height:1.55; max-width:84%; display:inline-block; letter-spacing:-.01em; }
      .sa-bubble.pro { background:rgba(255,180,30,.08); border:1px solid rgba(255,180,30,.2); }

      /* Links dentro de burbujas */
      .sa-bubble a { color:#e85000; text-decoration:underline; word-break:break-all; }
      .sa-bubble a:hover { color:#cc3300; }

      /* ── PRODUCT CARDS */
      .sa-cards { display:flex; flex-direction:column; gap:8px; max-width:300px; animation:saUp 0.3s ease; }

      .sa-card { background:#fff; border:1px solid rgba(0,0,0,.08); border-radius:14px; overflow:hidden; display:flex; align-items:center; text-decoration:none; color:inherit; transition:border-color .15s,box-shadow .15s,transform .15s; }
      .sa-card:hover { border-color:rgba(0,0,0,.14); box-shadow:0 4px 16px rgba(0,0,0,.08); transform:translateY(-1px); }

      .sa-card-img { width:72px; height:72px; background:#f4f4f2; flex-shrink:0; overflow:hidden; display:flex; align-items:center; justify-content:center; }
      .sa-card-img img { width:100%; height:100%; object-fit:cover; display:block; }
      .sa-card-img-ph { font-size:24px; color:#d8d8d2; }

      .sa-card-info { flex:1; padding:10px 10px 10px 12px; display:flex; flex-direction:column; gap:3px; }
      .sa-card-name { font-size:12.5px; font-weight:600; color:#1c1c18; line-height:1.3; letter-spacing:-.01em; display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical; overflow:hidden; }
      .sa-card-price-row { display:flex; align-items:baseline; gap:5px; }
      .sa-card-price { font-size:13px; font-weight:700; color:#1c1c18; letter-spacing:-.02em; }
      .sa-card-compare { font-size:11px; color:#c0bbb4; text-decoration:line-through; }

      .sa-card-btn {
        margin:0 10px 0 0;
        background:#1c1c18; color:#fff;
        border:none; border-radius:8px;
        padding:6px 11px; font-size:11.5px;
        font-weight:600; cursor:pointer;
        font-family:inherit; flex-shrink:0;
        transition:opacity .15s;
        white-space:nowrap;
      }
      .sa-card-btn:hover { opacity:.85; }
      .sa-card-btn.added { background:#16a34a; }

      /* Typing */
      .sa-typing-row { display:flex; gap:9px; align-items:center; }
      .sa-typing { display:flex; gap:5px; padding:11px 14px; background:#f4f4f2; border-radius:16px 16px 16px 4px; }
      .sa-typing span { width:6px; height:6px; border-radius:50%; background:#c0bbb4; animation:saDot 1.2s ease-in-out infinite; }
      .sa-typing span:nth-child(2) { animation-delay:.15s; }
      .sa-typing span:nth-child(3) { animation-delay:.3s; }

      /* Quick replies */
      #sa-qr { padding:8px 14px 4px; display:flex; gap:6px; overflow-x:auto; flex-shrink:0; scrollbar-width:none; }
      #sa-qr::-webkit-scrollbar { display:none; }
      .sa-qr-btn { background:transparent; border:1px solid rgba(0,0,0,.1); border-radius:8px; padding:6px 12px; font-size:12px; color:#6b6b63; cursor:pointer; white-space:nowrap; flex-shrink:0; font-family:inherit; font-weight:500; transition:all .12s; letter-spacing:-.01em; }
      .sa-qr-btn:hover { border-color:#1c1c18; color:#1c1c18; }

      /* Input */
      #sa-inp-row { padding:8px 14px 14px; display:flex; gap:8px; align-items:center; flex-shrink:0; }
      #sa-inp { flex:1; background:#f4f4f2; border:1px solid transparent; border-radius:12px; padding:10px 14px; font-size:13.5px; color:#1c1c18; outline:none; font-family:inherit; transition:all .15s; letter-spacing:-.01em; }
      #sa-inp:focus { border-color:rgba(0,0,0,.12); background:#fff; }
      #sa-inp::placeholder { color:#c0bbb4; }
      #sa-send { width:36px; height:36px; border-radius:11px; border:none; display:flex; align-items:center; justify-content:center; cursor:pointer; flex-shrink:0; transition:all .15s; background:#f0f0ee; color:#c0bbb4; }
      #sa-send.on { background:#1c1c18; color:#fff; }
      #sa-send svg { width:14px; height:14px; }
      #sa-brand { text-align:center; padding:0 0 12px; font-size:10px; color:#d8d8d2; letter-spacing:.06em; text-transform:uppercase; flex-shrink:0; }

      /* Help page mode */
      #sa-root.help-mode { position:fixed; inset:0; bottom:unset; right:unset; left:unset; display:flex; align-items:center; justify-content:center; background:rgba(248,248,246,.96); backdrop-filter:blur(20px); pointer-events:none; }
      #sa-root.help-mode #sa-chat { pointer-events:all; width:min(420px,92vw); max-height:min(680px,88vh); border-radius:24px; box-shadow:0 32px 80px rgba(0,0,0,.15); animation:saIn 0.5s cubic-bezier(0.34,1.2,0.64,1); }
      #sa-root.help-mode #sa-fab, #sa-root.help-mode #sa-nudge { display:none !important; }
    `;
    document.head.appendChild(s);
  }

  function createWidget() {
    const root = document.createElement("div");
    root.id = "sa-root";
    if (IS_HELP_PAGE) root.classList.add("help-mode");
    document.body.appendChild(root);

    // Glass nudge
    const nudge = document.createElement("div");
    nudge.id = "sa-nudge";
    nudge.innerHTML = `
      <div class="sa-ng">
        <button class="sa-ng-close" id="sa-ng-x">×</button>
        <div class="sa-ng-inner">
          <div class="sa-nudge-orb-wrap" id="sa-nudge-orb-wrap"></div>
          <div class="sa-ng-text">
            <div class="sa-ng-title" id="sa-ng-title">${widgetConfig?.assistantName || "Sara"}</div>
            <div class="sa-ng-desc" id="sa-ng-desc">¿En qué puedo ayudarte?</div>
          </div>
        </div>
        <div class="sa-ng-actions">
          <button class="sa-ng-cta" id="sa-n-open">${T.open}</button>
          <button class="sa-ng-skip" id="sa-n-close">${T.dismiss}</button>
        </div>
      </div>`;
    root.appendChild(nudge);

    // Orb inside nudge — FIX: solo uno
    const nudgeOrbWrap = document.getElementById("sa-nudge-orb-wrap");
    if (nudgeOrbWrap) nudgeOrbWrap.appendChild(makeOrb(32));

    // Chat
    const chat = document.createElement("div");
    chat.id = "sa-chat";
    root.appendChild(chat);

    // Header
    const hdr = document.createElement("div");
    hdr.id = "sa-hdr";

    const hdrOrb = document.createElement("div");
    hdrOrb.id = "sa-hdr-orb";
    const hdrOrbEl = makeOrb(38);
    hdrOrbEl.id = "sa-hdr-orb-el";
    hdrOrb.appendChild(hdrOrbEl);
    const sdot = document.createElement("div");
    sdot.id = "sa-sdot";
    hdrOrb.appendChild(sdot);
    hdr.appendChild(hdrOrb);

    const hdrInfo = document.createElement("div");
    hdrInfo.style.flex = "1";
    // FIX: Usar assistantName del config, NO el shop name
    const assistantName = widgetConfig?.assistantName || "Sara";
    hdrInfo.innerHTML = `<div id="sa-hdr-name">${assistantName}</div><div id="sa-hdr-sub">${T.online}</div>`;
    hdr.appendChild(hdrInfo);

    const closeBtn = document.createElement("button");
    closeBtn.id = "sa-close";
    closeBtn.innerHTML = "×";
    hdr.appendChild(closeBtn);
    chat.appendChild(hdr);

    // Messages
    const msgs = document.createElement("div");
    msgs.id = "sa-msgs";
    chat.appendChild(msgs);

    // Quick replies
    const qr = document.createElement("div");
    qr.id = "sa-qr";
    chat.appendChild(qr);

    // Input
    const inpRow = document.createElement("div");
    inpRow.id = "sa-inp-row";
    inpRow.innerHTML = `
      <input id="sa-inp" type="text" placeholder="${T.placeholder}" />
      <button id="sa-send">
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/>
        </svg>
      </button>`;
    chat.appendChild(inpRow);

    const brand = document.createElement("div");
    brand.id = "sa-brand";
    brand.textContent = T.brand;
    chat.appendChild(brand);

    // FAB
    const fab = document.createElement("button");
    fab.id = "sa-fab";
    const fabOrbEl = makeOrb(56);
    fabOrbEl.id = "sa-fab-orb-el";
    fab.appendChild(fabOrbEl);
    const fabX = document.createElement("div");
    fabX.id = "sa-fab-x";
    fabX.textContent = "×";
    fab.appendChild(fabX);
    const unread = document.createElement("div");
    unread.id = "sa-unread";
    fab.appendChild(unread);
    root.appendChild(fab);

    // Events
    fab.addEventListener("click", toggleChat);
    closeBtn.addEventListener("click", closeChat);
    document.getElementById("sa-n-open").addEventListener("click", () => { hideNudge(); openChat(); });
    // FIX: botón X de la burbuja funciona
    document.getElementById("sa-n-close").addEventListener("click", hideNudge);
    document.getElementById("sa-ng-x").addEventListener("click", (e) => { e.stopPropagation(); hideNudge(); });

    const inp = document.getElementById("sa-inp");
    const send = document.getElementById("sa-send");
    inp.addEventListener("input", () => { const ok = inp.value.trim().length > 0 && !isLoading; send.disabled = !ok; send.classList.toggle("on", ok); });
    inp.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey && inp.value.trim()) { e.preventDefault(); sendMsg(inp.value.trim()); } });
    send.addEventListener("click", () => { if (inp.value.trim()) sendMsg(inp.value.trim()); });
  }

  function toggleChat() { isOpen ? closeChat() : openChat(); }

  function openChat(silent = false) {
    isOpen = true;
    hideNudge();
    clearTimeout(triggerTimer);
    document.getElementById("sa-chat").classList.add("open");
    document.getElementById("sa-fab-x").classList.add("v");
    const fabOrb = document.getElementById("sa-fab-orb-el");
    if (fabOrb) fabOrb.style.opacity = "0";
    document.getElementById("sa-unread").classList.remove("v");

    if (!silent) trackEvent("chat_open", { product: currentProduct?.title, cartTotal: cartState.total });

    // Restaurar historial o mostrar mensaje inicial
    if (messages.length > 0) {
      renderSavedMessages();
    } else {
      sendInitialMessage();
      renderQR();
    }

    setTimeout(() => document.getElementById("sa-inp")?.focus(), 200);
  }

  function closeChat() {
    if (IS_HELP_PAGE) return;
    isOpen = false;
    document.getElementById("sa-chat").classList.remove("open");
    document.getElementById("sa-fab-x").classList.remove("v");
    const fabOrb = document.getElementById("sa-fab-orb-el");
    if (fabOrb) fabOrb.style.opacity = "1";
    trackEvent("chat_close", { messagesCount: messages.length });
  }

  // ── Restaurar mensajes guardados en sesión
  function renderSavedMessages() {
    const container = document.getElementById("sa-msgs");
    if (!container) return;
    container.innerHTML = "";
    messages.forEach(msg => {
      if (msg.role === "user") {
        const el = document.createElement("div");
        el.className = "sa-user";
        el.textContent = msg.content;
        container.appendChild(el);
      } else if (msg.role === "assistant" && msg.content) {
        addAIBubble(msg.content, false, false); // no push to messages again
      }
    });
    scrollBottom();
  }

  function sendInitialMessage() {
    let msg = "";
    const name = widgetConfig?.assistantName || "Sara";
    if (IS_HELP_PAGE) {
      msg = `Hola. Soy ${name}. Pregúntame lo que necesites — productos, pedidos, envíos o lo que sea.`;
    } else if (currentProduct?.type === "product" && isReturning()) {
      msg = `Veo que vuelves a mirar ${currentProduct.title}. ¿Tienes alguna duda?`;
    } else if (currentProduct?.type === "product") {
      msg = widgetConfig?.welcomeMessage || "¿En qué puedo ayudarte?";
    } else if (currentProduct?.type === "cart" && cartState.count > 0) {
      msg = `Tienes ${cartState.count} producto${cartState.count > 1 ? "s" : ""} en el carrito. ¿Te ayudo a finalizar?`;
    } else {
      msg = widgetConfig?.welcomeMessage || "¿En qué puedo ayudarte?";
    }
    addAIBubble(msg, false, true);
  }

  function renderQR() {
    const qr = document.getElementById("sa-qr");
    if (!qr) return;
    let replies = [];
    if (IS_HELP_PAGE) {
      replies = ["¿Dónde está mi pedido?", "¿Cómo devuelvo?", "Ver productos", "¿Cuánto tarda el envío?"];
    } else if (currentProduct?.type === "product") {
      replies = ["¿Cómo funciona?", "Recomiéndame algo", "¿Con qué lo combino?", "Quiero pedirlo"];
    } else if (currentProduct?.type === "cart") {
      replies = ["¿Cuánto tarda el envío?", "¿Cómo devuelvo?", "Tengo un código"];
    } else {
      replies = ["¿Dónde está mi pedido?", "Ver productos", "¿Cuánto tarda el envío?", "Necesito ayuda"];
    }
    qr.innerHTML = replies.map(r => `<button class="sa-qr-btn" onclick="window.__saQR('${r}')">${r}</button>`).join("");
    window.__saQR = (t) => { qr.innerHTML = ""; sendMsg(t); };
  }

  function showGlassNudge(title, desc) {
    nudgeShown = true;
    const nudge = document.getElementById("sa-nudge");
    const titleEl = document.getElementById("sa-ng-title");
    const descEl = document.getElementById("sa-ng-desc");
    if (!nudge || !titleEl || !descEl) return;
    titleEl.textContent = title;
    descEl.textContent = desc;
    nudge.style.display = "block";
    const u = document.getElementById("sa-unread");
    if (u) { u.textContent = "1"; u.classList.add("v"); }
    trackEvent("nudge_shown", { title, product: currentProduct?.title });
    setTimeout(() => { if (!isOpen) hideNudge(); }, 12000);
  }

  function hideNudge() {
    const n = document.getElementById("sa-nudge");
    if (n) n.style.display = "none";
    document.getElementById("sa-unread")?.classList.remove("v");
  }

  // ── RENDER BURBUJA IA con links clicables
  function addAIBubble(text, proactive = false, pushToHistory = true) {
    const c = document.getElementById("sa-msgs");
    if (!c) return;
    const row = document.createElement("div");
    row.className = "sa-ai-row";
    // FIX: solo un orbe por fila
    const av = document.createElement("div");
    av.className = "sa-ai-av";
    av.appendChild(makeOrb(26));
    row.appendChild(av);
    const bubble = document.createElement("div");
    bubble.className = "sa-bubble" + (proactive ? " pro" : "");
    // FIX: convertir URLs en links clicables
    bubble.innerHTML = linkify(escHtml(text));
    row.appendChild(bubble);
    c.appendChild(row);
    scrollBottom();
    if (pushToHistory) {
      messages.push({ role: "assistant", content: text });
      saveMessages();
    }
  }

  // Convierte URLs en texto a <a> clicables
  function linkify(text) {
    return text.replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" target="_blank" rel="noopener">$1</a>');
  }

  // ── PRODUCT CARDS con imagen y botón añadir al carrito
  function addProductCards(cards) {
    if (!cards?.length) return;
    const c = document.getElementById("sa-msgs");
    if (!c) return;
    const row = document.createElement("div");
    row.className = "sa-ai-row";
    // FIX: solo un orbe
    const av = document.createElement("div");
    av.className = "sa-ai-av";
    av.appendChild(makeOrb(26));
    row.appendChild(av);

    const wrap = document.createElement("div");
    wrap.className = "sa-cards";

    cards.forEach(card => {
      const cardEl = document.createElement("div");
      cardEl.className = "sa-card";

      // Imagen
      const imgWrap = document.createElement("div");
      imgWrap.className = "sa-card-img";
      if (card.image) {
        const img = document.createElement("img");
        img.src = card.image;
        img.alt = card.title;
        img.loading = "lazy";
        img.onerror = () => { imgWrap.innerHTML = `<span class="sa-card-img-ph">🛍</span>`; };
        imgWrap.appendChild(img);
      } else {
        imgWrap.innerHTML = `<span class="sa-card-img-ph">🛍</span>`;
      }
      cardEl.appendChild(imgWrap);

      // Info
      const info = document.createElement("div");
      info.className = "sa-card-info";
      const name = document.createElement("div");
      name.className = "sa-card-name";
      name.textContent = card.title;
      info.appendChild(name);
      const priceRow = document.createElement("div");
      priceRow.className = "sa-card-price-row";
      const price = document.createElement("span");
      price.className = "sa-card-price";
      price.textContent = `€${parseFloat(card.price).toFixed(2)}`;
      priceRow.appendChild(price);
      if (card.compareAtPrice && parseFloat(card.compareAtPrice) > parseFloat(card.price)) {
        const comp = document.createElement("span");
        comp.className = "sa-card-compare";
        comp.textContent = `€${parseFloat(card.compareAtPrice).toFixed(2)}`;
        priceRow.appendChild(comp);
      }
      info.appendChild(priceRow);
      cardEl.appendChild(info);

      // Botón añadir al carrito
      const btn = document.createElement("button");
      btn.className = "sa-card-btn";
      btn.textContent = T.addCart;
      btn.addEventListener("click", async (e) => {
        e.preventDefault();
        e.stopPropagation();
        btn.textContent = "...";
        btn.disabled = true;
        try {
          // Añadir al carrito de Shopify vía AJAX
          const variantId = card.variantId || card.id;
          await fetch("/cart/add.js", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ id: variantId, quantity: 1 }),
          });
          btn.textContent = "✓";
          btn.classList.add("added");
          // Trigger cart update
          document.dispatchEvent(new CustomEvent("cart:updated"));
          // Abrir el drawer de carrito si existe
          const cartBtn = document.querySelector("[data-cart-trigger], .cart-toggle, [data-open-cart]");
          if (cartBtn) cartBtn.click();
        } catch {
          btn.textContent = T.addCart;
          btn.disabled = false;
          // Si falla el add to cart, llevar al producto
          window.open(card.url, "_blank");
        }
      });
      cardEl.appendChild(btn);

      // Click en la card lleva al producto
      cardEl.addEventListener("click", () => window.open(card.url, "_blank"));
      cardEl.style.cursor = "pointer";

      wrap.appendChild(cardEl);
    });

    row.appendChild(wrap);
    c.appendChild(row);
    scrollBottom();
  }

  async function sendMsg(text) {
    if (!text.trim() || isLoading) return;
    const inp = document.getElementById("sa-inp");
    const send = document.getElementById("sa-send");
    if (inp) { inp.value = ""; inp.dispatchEvent(new Event("input")); }

    // User bubble
    const userEl = document.createElement("div");
    userEl.className = "sa-user";
    userEl.textContent = text;
    document.getElementById("sa-msgs")?.appendChild(userEl);
    scrollBottom();

    messages.push({ role: "user", content: text });
    saveMessages();
    isLoading = true;
    if (send) { send.disabled = true; send.classList.remove("on"); }

    // FIX typing: solo UN orbe
    const tRow = document.createElement("div");
    tRow.className = "sa-typing-row";
    tRow.id = "sa-typing";
    const tAv = document.createElement("div");
    tAv.className = "sa-ai-av";
    tAv.appendChild(makeOrb(26));
    const tDots = document.createElement("div");
    tDots.className = "sa-typing";
    tDots.innerHTML = "<span></span><span></span><span></span>";
    tRow.appendChild(tAv);
    tRow.appendChild(tDots);
    document.getElementById("sa-msgs")?.appendChild(tRow);
    scrollBottom();

    const threshold = widgetConfig?.freeShippingThreshold || 50;
    const context = {
      productTitle: currentProduct?.title,
      productPrice: currentProduct?.price,
      pageType: IS_HELP_PAGE ? "help" : currentProduct?.type,
      timeOnPage: Math.round((Date.now() - pageEntryTime) / 1000),
      cartTotal: cartState.total,
      cartCount: cartState.count,
      cartItems: cartState.items?.map(i => i.title).join(", "),
      freeShippingThreshold: threshold,
      remainingForFreeShipping: Math.max(0, threshold - cartState.total),
      isReturning: isReturning(),
      isHelpPage: IS_HELP_PAGE,
      browserLang: BROWSER_LANG,
    };

    try {
      const res = await fetch(`${BACKEND}/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ shop: SHOP, sessionId: SESSION_ID, message: text, context }),
      });
      const data = await res.json();
      document.getElementById("sa-typing")?.remove();
      const reply = data.reply || "Lo siento, ha habido un error.";
      addAIBubble(reply, false, true);
      if (data.productCards?.length) setTimeout(() => addProductCards(data.productCards), 180);
    } catch {
      document.getElementById("sa-typing")?.remove();
      addAIBubble("Ha habido un problema de conexión. Inténtalo de nuevo.", false, false);
    }

    isLoading = false;
    if (send) send.disabled = false;
  }

  function scrollBottom() {
    const el = document.getElementById("sa-msgs");
    if (el) el.scrollTop = el.scrollHeight;
  }

  function escHtml(str) {
    return (str || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

})();
