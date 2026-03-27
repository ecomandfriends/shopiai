/**
 * SHOPI ADVISOR — Widget v2
 * Proactive, contextual, cart-aware
 */
(function () {
  "use strict";

  const BACKEND = "https://shopiai-production.up.railway.app";
  const script = document.currentScript;
  const SHOP = script?.getAttribute("data-shop") || window.Shopify?.shop;
  const FREE_SHIPPING_THRESHOLD = parseFloat(script?.getAttribute("data-free-shipping") || "50");
  const SESSION_ID = "sa_" + Math.random().toString(36).slice(2) + Date.now().toString(36);

  if (!SHOP) return;

  // ── STATE
  let widgetConfig = null;
  let isOpen = false;
  let messages = [];
  let isLoading = false;
  let nudgeShown = false;
  let exitListenerAdded = false;
  let cartState = { items: [], total: 0, count: 0 };
  let pageVisits = JSON.parse(sessionStorage.getItem("sa_visits") || "{}");
  let currentProduct = null;
  let pageEntryTime = Date.now();
  let triggerTimer = null;
  let proactiveTimer = null;
  let lastCartTotal = 0;

  init();

  async function init() {
    try {
      const res = await fetch(`${BACKEND}/widget/config/${SHOP}`);
      widgetConfig = await res.json();
    } catch {
      widgetConfig = {
        assistantName: "Sara",
        welcomeMessage: "Hola, ¿en qué puedo ayudarte?",
        primaryColor: "#1c1c18",
        widgetPosition: "right",
        triggerDelay: 3,
        enableExitIntent: true,
        language: "es",
      };
    }

    currentProduct = detectProduct();
    trackPageVisit();
    injectStyles();
    createWidget();
    monitorCart();
    setupTriggers();
    trackBehavior();
  }

  // ── PRODUCT DETECTION
  function detectProduct() {
    const meta = window.ShopifyAnalytics?.meta?.product;
    if (meta) return { id: meta.id, title: meta.title, price: meta.variants?.[0]?.price, type: "product" };
    const title = document.querySelector(".product-title, h1.title, .product__title, [class*='product'][class*='title']")?.textContent?.trim();
    const priceEl = document.querySelector(".price, .product-price, .product__price, [class*='price']");
    const price = priceEl ? parseFloat(priceEl.textContent.replace(/[^0-9.,]/g, "").replace(",", ".")) : null;
    if (title) return { title, price, type: "product" };
    const path = window.location.pathname;
    if (path.includes("/cart")) return { type: "cart" };
    if (path.includes("/collections")) return { type: "collection" };
    return { type: "general" };
  }

  // ── PAGE VISITS (detects returning to same page)
  function trackPageVisit() {
    const key = window.location.pathname;
    pageVisits[key] = (pageVisits[key] || 0) + 1;
    sessionStorage.setItem("sa_visits", JSON.stringify(pageVisits));
  }

  function isReturningToPage() {
    return (pageVisits[window.location.pathname] || 0) > 1;
  }

  // ── CART MONITORING
  async function fetchCart() {
    try {
      const res = await fetch("/cart.js");
      return await res.json();
    } catch { return null; }
  }

  async function monitorCart() {
    const updateCart = async () => {
      const cart = await fetchCart();
      if (!cart) return;

      const newTotal = cart.total_price / 100;
      const newCount = cart.item_count;

      // Detect item added
      if (newCount > cartState.count && cartState.count > 0) {
        onItemAdded(cart);
      }

      // Detect approaching free shipping
      if (FREE_SHIPPING_THRESHOLD > 0) {
        const remaining = FREE_SHIPPING_THRESHOLD - newTotal;
        if (remaining > 0 && remaining <= FREE_SHIPPING_THRESHOLD * 0.25 && newTotal > lastCartTotal) {
          onNearFreeShipping(remaining, newTotal);
        }
      }

      cartState = { items: cart.items || [], total: newTotal, count: newCount };
      lastCartTotal = newTotal;
    };

    await updateCart();
    setInterval(updateCart, 3000);

    // Also hook into Shopify cart events
    document.addEventListener("cart:updated", updateCart);
    document.addEventListener("cart:add", updateCart);

    // MutationObserver for cart count changes in DOM
    const cartCountEl = document.querySelector(".cart-count, [data-cart-count], .cart__count");
    if (cartCountEl) {
      new MutationObserver(updateCart).observe(cartCountEl, { childList: true, subtree: true, characterData: true });
    }
  }

  function onItemAdded(cart) {
    if (!isOpen) {
      const addedItem = cart.items?.[0];
      if (!addedItem) return;

      const remaining = FREE_SHIPPING_THRESHOLD - (cart.total_price / 100);
      let msg = "";

      if (remaining > 0 && remaining < FREE_SHIPPING_THRESHOLD) {
        msg = `Te faltan solo €${remaining.toFixed(2)} para el envío gratis. ¿Quieres que te recomiende algo?`;
      } else if (remaining <= 0) {
        msg = `Tienes envío gratis. Buen momento para completar tu pedido.`;
      }

      if (msg) showProactiveNudge(msg);
    } else {
      // If chat is open, send a proactive message
      const remaining = FREE_SHIPPING_THRESHOLD - (cart.total_price / 100);
      if (remaining > 0 && remaining < FREE_SHIPPING_THRESHOLD * 0.3) {
        addProactiveMessage(`Por cierto, te faltan €${remaining.toFixed(2)} para el envío gratis.`);
      }
    }
  }

  function onNearFreeShipping(remaining, total) {
    if (!nudgeShown) {
      showProactiveNudge(`Casi tienes envío gratis. Solo te faltan €${remaining.toFixed(2)} más.`);
    } else if (isOpen) {
      addProactiveMessage(`Te faltan €${remaining.toFixed(2)} para el envío gratis.`);
    }
  }

  // ── TRIGGERS
  function setupTriggers() {
    const delay = (widgetConfig.triggerDelay || 3) * 1000;

    // Trigger 1: Time on product page
    if (currentProduct?.type === "product") {
      triggerTimer = setTimeout(() => {
        if (!isOpen && !nudgeShown) {
          const msg = isReturningToPage()
            ? `Veo que vuelves a mirar ${currentProduct.title}. ¿Tienes alguna duda?`
            : `¿Puedo ayudarte con ${currentProduct.title}?`;
          showProactiveNudge(msg);
        }
      }, delay);
    }

    // Trigger 2: Exit intent
    if (widgetConfig.enableExitIntent && !exitListenerAdded) {
      exitListenerAdded = true;
      document.addEventListener("mouseleave", (e) => {
        if (e.clientY <= 0 && cartState.count > 0 && !nudgeShown) {
          const msg = cartState.total > 0
            ? `Tienes ${cartState.count} producto${cartState.count > 1 ? "s" : ""} en el carrito (€${cartState.total.toFixed(2)}). ¿Completo el pedido?`
            : "¿Necesitas ayuda antes de irte?";
          showProactiveNudge(msg);
          trackEvent("exit_intent", { cartTotal: cartState.total });
        }
      });
    }

    // Trigger 3: Returning to same product page
    if (isReturningToPage() && currentProduct?.type === "product") {
      setTimeout(() => {
        if (!isOpen && !nudgeShown) {
          showProactiveNudge(`Hola de nuevo. ¿Puedo resolver alguna duda sobre ${currentProduct.title}?`);
        }
      }, 1500);
    }

    // Trigger 4: Scroll up on mobile (exit signal)
    let lastScrollY = window.scrollY;
    window.addEventListener("scroll", () => {
      const delta = window.scrollY - lastScrollY;
      if (delta < -80 && !isOpen && !nudgeShown && cartState.count > 0) {
        showProactiveNudge("¿Te ayudo a completar el pedido?");
      }
      lastScrollY = window.scrollY;
    }, { passive: true });
  }

  // ── BEHAVIOR TRACKING
  function trackBehavior() {
    trackEvent("pageview", {
      product: currentProduct?.title,
      type: currentProduct?.type,
      url: window.location.href,
      returning: isReturningToPage(),
    });

    window.addEventListener("beforeunload", () => {
      trackEvent("pageleave", {
        timeOnPage: Math.round((Date.now() - pageEntryTime) / 1000),
        cartTotal: cartState.total,
        chatOpened: isOpen,
        messagesCount: messages.length,
      });
    });

    // Track add to cart buttons
    document.addEventListener("click", (e) => {
      const btn = e.target.closest("[name='add'], .add-to-cart, .btn-cart, [data-add-to-cart]");
      if (btn) trackEvent("add_to_cart_click", { product: currentProduct?.title });
    });
  }

  function trackEvent(type, data) {
    fetch(`${BACKEND}/analytics/event`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ shop: SHOP, event: { type, sessionId: SESSION_ID, ...data } }),
    }).catch(() => {});
  }

  // ── STYLES
  function injectStyles() {
    const c = widgetConfig.primaryColor || "#1c1c18";
    const pos = widgetConfig.widgetPosition || "right";
    const s = document.createElement("style");
    s.textContent = `
      #sa-root * { box-sizing: border-box; font-family: -apple-system, 'Helvetica Neue', Arial, sans-serif; }
      #sa-root {
        position: fixed; bottom: 20px; ${pos}: 16px;
        z-index: 2147483647;
        display: flex; flex-direction: column; align-items: flex-end; gap: 10px;
      }

      @keyframes saUp { from { transform: translateY(12px); opacity: 0; } to { transform: translateY(0); opacity: 1; } }
      @keyframes saIn { from { transform: scale(0.94) translateY(8px); opacity: 0; } to { transform: scale(1) translateY(0); opacity: 1; } }
      @keyframes saDot { 0%,60%,100% { transform: translateY(0); opacity: .4; } 30% { transform: translateY(-4px); opacity: 1; } }
      @keyframes saPulse { 0%,100% { opacity: 1; } 50% { opacity: .4; } }

      /* Nudge bubble */
      #sa-nudge {
        background: #fff;
        border: 1px solid #e8e8e4;
        border-radius: 14px 14px 4px 14px;
        padding: 12px 16px;
        max-width: 240px;
        box-shadow: 0 4px 24px rgba(0,0,0,0.1);
        animation: saUp 0.35s cubic-bezier(0.34,1.2,0.64,1);
        display: none;
        cursor: pointer;
      }

      #sa-nudge-msg {
        font-size: 13.5px;
        font-weight: 500;
        color: #1c1c18;
        line-height: 1.45;
        display: block;
        margin-bottom: 8px;
      }

      .sa-nudge-actions { display: flex; gap: 6px; }

      .sa-nudge-cta {
        flex: 1; background: ${c}; color: #fff; border: none;
        border-radius: 8px; padding: 7px 12px;
        font-size: 12px; font-weight: 600; cursor: pointer;
        font-family: inherit;
      }

      .sa-nudge-dismiss {
        background: transparent; border: 1px solid #e8e8e4;
        border-radius: 8px; padding: 7px 10px;
        font-size: 12px; color: #a8a89e; cursor: pointer;
        font-family: inherit;
      }

      /* FAB */
      #sa-fab {
        width: 48px; height: 48px; border-radius: 50%;
        background: ${c}; border: none; cursor: pointer;
        display: flex; align-items: center; justify-content: center;
        box-shadow: 0 4px 20px rgba(0,0,0,0.18);
        position: relative; flex-shrink: 0;
        transition: transform 0.2s, box-shadow 0.2s;
      }
      #sa-fab:hover { transform: scale(1.05); box-shadow: 0 6px 24px rgba(0,0,0,0.22); }

      #sa-fab-icon { font-size: 20px; transition: all 0.2s; }
      #sa-fab-icon.open { font-size: 16px; }

      #sa-unread {
        position: absolute; top: -2px; right: -2px;
        width: 17px; height: 17px; background: #ef4444;
        border-radius: 50%; border: 2px solid #fff;
        display: flex; align-items: center; justify-content: center;
        font-size: 9px; font-weight: 700; color: #fff;
        display: none;
      }

      /* Chat window */
      #sa-chat {
        width: 330px; background: #fff;
        border: 1px solid #e8e8e4;
        border-radius: 18px;
        box-shadow: 0 8px 40px rgba(0,0,0,0.12);
        display: none; flex-direction: column;
        max-height: 500px; overflow: hidden;
        animation: saIn 0.32s cubic-bezier(0.34,1.2,0.64,1);
      }
      #sa-chat.open { display: flex; }

      /* Header */
      #sa-header {
        padding: 13px 15px;
        border-bottom: 1px solid #f3f3f1;
        display: flex; align-items: center; gap: 10px;
        flex-shrink: 0;
      }

      #sa-avatar {
        width: 34px; height: 34px; border-radius: 50%;
        background: ${c}; display: flex; align-items: center;
        justify-content: center; font-size: 16px;
        position: relative; flex-shrink: 0;
      }

      #sa-status-dot {
        position: absolute; bottom: 0; right: 0;
        width: 9px; height: 9px; background: #22c55e;
        border-radius: 50%; border: 2px solid #fff;
        animation: saPulse 2.5s ease-in-out infinite;
      }

      #sa-header-info { flex: 1; }
      #sa-header-name { font-size: 13.5px; font-weight: 600; color: #1c1c18; }
      #sa-header-sub { font-size: 11px; color: #a8a89e; margin-top: 1px; }

      #sa-close-btn {
        width: 28px; height: 28px; border-radius: 8px;
        border: 1px solid #e8e8e4; background: #f8f8f6;
        color: #a8a89e; cursor: pointer; font-size: 15px;
        display: flex; align-items: center; justify-content: center;
        transition: all 0.15s;
      }
      #sa-close-btn:hover { color: #1c1c18; border-color: #d8d8d2; }

      /* Cart pill */
      #sa-cart-pill {
        margin: 0 15px 8px;
        background: #f8f8f6; border: 1px solid #e8e8e4;
        border-radius: 8px; padding: 7px 11px;
        display: none; align-items: center; justify-content: space-between;
        flex-shrink: 0;
      }

      #sa-cart-pill.visible { display: flex; }

      .sa-cart-info { font-size: 11.5px; color: #6b6b63; }
      .sa-cart-info strong { color: #1c1c18; font-weight: 600; }

      .sa-cart-shipping {
        font-size: 11px; font-weight: 600;
        padding: 2px 8px; border-radius: 99px;
      }
      .sa-cart-shipping.free { background: #f0fdf4; color: #16a34a; }
      .sa-cart-shipping.near { background: #fffbeb; color: #d97706; }
      .sa-cart-shipping.default { background: #f3f3f1; color: #6b6b63; }

      /* Messages */
      #sa-messages {
        flex: 1; overflow-y: auto; padding: 14px 15px 6px;
        display: flex; flex-direction: column; gap: 10px;
        scrollbar-width: none;
      }
      #sa-messages::-webkit-scrollbar { display: none; }

      .sa-msg-user {
        align-self: flex-end;
        background: ${c}; color: #fff;
        border-radius: 14px 14px 3px 14px;
        padding: 9px 13px; max-width: 80%;
        font-size: 13.5px; line-height: 1.5;
        animation: saUp 0.22s ease;
      }

      .sa-msg-ai-row {
        display: flex; gap: 8px; align-items: flex-start;
        animation: saUp 0.22s ease;
      }

      .sa-msg-ai-avatar {
        width: 24px; height: 24px; border-radius: 50%;
        background: ${c}; display: flex; align-items: center;
        justify-content: center; font-size: 12px; flex-shrink: 0; margin-top: 2px;
      }

      .sa-msg-ai {
        background: #f3f3f1;
        border-radius: 14px 14px 14px 3px;
        padding: 9px 13px; font-size: 13.5px;
        color: #1c1c18; line-height: 1.55;
        max-width: 85%; display: inline-block;
      }

      .sa-msg-proactive {
        background: #fff8ed;
        border: 1px solid #fde68a;
        border-radius: 14px 14px 14px 3px;
        padding: 9px 13px; font-size: 13.5px;
        color: #1c1c18; line-height: 1.55;
        max-width: 85%; display: inline-block;
      }

      .sa-typing {
        display: flex; gap: 5px;
        padding: 10px 13px; background: #f3f3f1;
        border-radius: 14px 14px 14px 3px; width: fit-content;
      }

      .sa-typing span {
        width: 6px; height: 6px; border-radius: 50%;
        background: #a8a89e; animation: saDot 1.2s ease-in-out infinite;
      }
      .sa-typing span:nth-child(2) { animation-delay: 0.15s; }
      .sa-typing span:nth-child(3) { animation-delay: 0.3s; }

      /* Quick replies */
      #sa-qr {
        padding: 6px 15px 4px;
        display: flex; gap: 6px; overflow-x: auto; flex-shrink: 0;
        scrollbar-width: none;
      }
      #sa-qr::-webkit-scrollbar { display: none; }

      .sa-qr-btn {
        background: transparent; border: 1px solid #e8e8e4;
        border-radius: 8px; padding: 5px 11px;
        font-size: 12px; color: #6b6b63; cursor: pointer;
        white-space: nowrap; flex-shrink: 0; font-family: inherit;
        transition: all 0.12s;
      }
      .sa-qr-btn:hover { border-color: ${c}; color: ${c}; }
      .sa-qr-btn:disabled { opacity: 0.4; }

      /* Input */
      #sa-input-row {
        padding: 8px 13px 13px;
        display: flex; gap: 8px; align-items: center; flex-shrink: 0;
      }

      #sa-input {
        flex: 1; background: #f3f3f1; border: 1px solid transparent;
        border-radius: 10px; padding: 9px 12px;
        font-size: 13.5px; color: #1c1c18; outline: none;
        font-family: inherit; transition: border-color 0.15s;
      }
      #sa-input:focus { border-color: #d8d8d2; background: #fff; }

      #sa-send {
        width: 34px; height: 34px; border-radius: 10px; border: none;
        display: flex; align-items: center; justify-content: center;
        cursor: pointer; flex-shrink: 0; transition: all 0.15s;
        background: #e8e8e4; color: #a8a89e;
      }
      #sa-send.active { background: ${c}; color: #fff; }
      #sa-send svg { width: 15px; height: 15px; }

      #sa-branding {
        text-align: center; padding: 0 0 10px;
        font-size: 10px; color: #d8d8d2; letter-spacing: 0.04em;
        flex-shrink: 0;
      }
    `;
    document.head.appendChild(s);
  }

  // ── CREATE WIDGET
  function createWidget() {
    const el = document.createElement("div");
    el.id = "sa-root";
    el.innerHTML = `
      <div id="sa-nudge">
        <span id="sa-nudge-msg"></span>
        <div class="sa-nudge-actions">
          <button class="sa-nudge-cta" id="sa-nudge-open">Hablar con Sara</button>
          <button class="sa-nudge-dismiss" id="sa-nudge-close">Ahora no</button>
        </div>
      </div>

      <div id="sa-chat">
        <div id="sa-header">
          <div id="sa-avatar">
            🧑‍💼
            <div id="sa-status-dot"></div>
          </div>
          <div id="sa-header-info">
            <div id="sa-header-name">${widgetConfig.assistantName || "Sara"}</div>
            <div id="sa-header-sub" id="sa-context-label">Asistente de tienda</div>
          </div>
          <button id="sa-close-btn">×</button>
        </div>

        <div id="sa-cart-pill">
          <div class="sa-cart-info">
            Carrito: <strong id="sa-cart-total">€0</strong>
            (<span id="sa-cart-count">0</span> productos)
          </div>
          <span class="sa-cart-shipping default" id="sa-shipping-badge">Envío</span>
        </div>

        <div id="sa-messages"></div>
        <div id="sa-qr"></div>

        <div id="sa-input-row">
          <input id="sa-input" type="text" placeholder="Escribe un mensaje..." />
          <button id="sa-send" disabled>
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/>
            </svg>
          </button>
        </div>
        <div id="sa-branding">Shopi Advisor</div>
      </div>

      <button id="sa-fab">
        <span id="sa-fab-icon">🧑‍💼</span>
        <div id="sa-unread"></div>
      </button>
    `;
    document.body.appendChild(el);

    // Events
    document.getElementById("sa-fab").addEventListener("click", toggleChat);
    document.getElementById("sa-close-btn").addEventListener("click", closeChat);
    document.getElementById("sa-nudge-open").addEventListener("click", () => { hideNudge(); openChat(); });
    document.getElementById("sa-nudge-close").addEventListener("click", () => { hideNudge(); });

    const input = document.getElementById("sa-input");
    const send = document.getElementById("sa-send");

    input.addEventListener("input", () => {
      const hasText = input.value.trim().length > 0;
      send.disabled = !hasText || isLoading;
      send.classList.toggle("active", hasText && !isLoading);
    });

    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey && input.value.trim()) {
        e.preventDefault();
        sendMsg(input.value.trim());
      }
    });

    send.addEventListener("click", () => {
      if (input.value.trim()) sendMsg(input.value.trim());
    });

    updateCartUI();
  }

  // ── CART UI
  function updateCartUI() {
    setInterval(() => {
      const pill = document.getElementById("sa-cart-pill");
      const totalEl = document.getElementById("sa-cart-total");
      const countEl = document.getElementById("sa-cart-count");
      const badge = document.getElementById("sa-shipping-badge");

      if (!pill || !isOpen) return;

      if (cartState.count > 0) {
        pill.classList.add("visible");
        if (totalEl) totalEl.textContent = "€" + cartState.total.toFixed(2);
        if (countEl) countEl.textContent = cartState.count;

        if (badge) {
          const remaining = FREE_SHIPPING_THRESHOLD - cartState.total;
          if (remaining <= 0) {
            badge.textContent = "Envío gratis";
            badge.className = "sa-cart-shipping free";
          } else if (remaining <= FREE_SHIPPING_THRESHOLD * 0.3) {
            badge.textContent = `€${remaining.toFixed(2)} para gratis`;
            badge.className = "sa-cart-shipping near";
          } else {
            badge.textContent = `€${remaining.toFixed(2)} para gratis`;
            badge.className = "sa-cart-shipping default";
          }
        }
      } else {
        pill.classList.remove("visible");
      }
    }, 1000);
  }

  // ── CHAT OPEN/CLOSE
  function toggleChat() {
    isOpen ? closeChat() : openChat();
  }

  function openChat() {
    isOpen = true;
    hideNudge();
    clearTimeout(triggerTimer);

    document.getElementById("sa-chat").classList.add("open");
    document.getElementById("sa-fab-icon").textContent = "×";
    document.getElementById("sa-fab-icon").classList.add("open");
    document.getElementById("sa-unread").style.display = "none";

    trackEvent("chat_open", { product: currentProduct?.title, cartTotal: cartState.total });

    if (messages.length === 0) {
      sendInitialMessage();
      renderQuickReplies();
    }

    setTimeout(() => document.getElementById("sa-input")?.focus(), 150);
  }

  function closeChat() {
    isOpen = false;
    document.getElementById("sa-chat").classList.remove("open");
    document.getElementById("sa-fab-icon").textContent = "🧑‍💼";
    document.getElementById("sa-fab-icon").classList.remove("open");
    trackEvent("chat_close", { messagesCount: messages.length });
  }

  function sendInitialMessage() {
    let msg = "";

    if (currentProduct?.type === "product" && isReturningToPage()) {
      msg = `Veo que vuelves a mirar ${currentProduct.title}. ¿Tienes alguna duda?`;
    } else if (currentProduct?.type === "product") {
      msg = widgetConfig.welcomeMessage || `¿En qué puedo ayudarte con ${currentProduct.title}?`;
    } else if (currentProduct?.type === "cart") {
      msg = cartState.count > 0
        ? `Tienes ${cartState.count} producto${cartState.count > 1 ? "s" : ""} en el carrito. ¿Completo el pedido?`
        : "¿En qué puedo ayudarte?";
    } else {
      msg = widgetConfig.welcomeMessage || "¿En qué puedo ayudarte?";
    }

    addAIMessage(msg, false);
    messages.push({ role: "assistant", content: msg });
  }

  function renderQuickReplies() {
    const container = document.getElementById("sa-qr");
    if (!container) return;

    const replies = currentProduct?.type === "product"
      ? ["¿Cómo funciona?", "¿Tienes tallas?", "¿Con qué lo combino?", "Quiero pedirlo"]
      : currentProduct?.type === "cart"
      ? ["¿Cuánto tarda el envío?", "¿Cómo devuelvo?", "Tengo un código"]
      : ["¿Dónde está mi pedido?", "¿Cuánto tarda el envío?", "Necesito ayuda"];

    container.innerHTML = replies
      .map(r => `<button class="sa-qr-btn" onclick="window.__saQuickReply('${r}')">${r}</button>`)
      .join("");

    window.__saQuickReply = (text) => {
      container.innerHTML = "";
      sendMsg(text);
    };
  }

  // ── PROACTIVE NUDGE
  function showProactiveNudge(msg) {
    nudgeShown = true;
    const nudge = document.getElementById("sa-nudge");
    const msgEl = document.getElementById("sa-nudge-msg");
    if (!nudge || !msgEl) return;
    msgEl.textContent = msg;
    nudge.style.display = "block";

    // Show unread badge on FAB
    const unread = document.getElementById("sa-unread");
    if (unread) {
      unread.style.display = "flex";
      unread.textContent = "1";
    }

    trackEvent("nudge_shown", { msg, product: currentProduct?.title });

    setTimeout(() => { if (!isOpen) hideNudge(); }, 10000);
  }

  function hideNudge() {
    const nudge = document.getElementById("sa-nudge");
    if (nudge) nudge.style.display = "none";
    const unread = document.getElementById("sa-unread");
    if (unread) unread.style.display = "none";
  }

  // ── PROACTIVE MESSAGE IN CHAT
  function addProactiveMessage(text) {
    const container = document.getElementById("sa-messages");
    if (!container) return;
    const row = document.createElement("div");
    row.className = "sa-msg-ai-row";
    row.innerHTML = `
      <div class="sa-msg-ai-avatar">🧑‍💼</div>
      <div class="sa-msg-proactive">${escHtml(text)}</div>
    `;
    container.appendChild(row);
    scrollBottom();
    messages.push({ role: "assistant", content: text });
  }

  // ── SEND MESSAGE
  async function sendMsg(text) {
    if (!text.trim() || isLoading) return;

    const input = document.getElementById("sa-input");
    const send = document.getElementById("sa-send");
    if (input) { input.value = ""; input.dispatchEvent(new Event("input")); }

    addUserMessage(text);
    messages.push({ role: "user", content: text });
    isLoading = true;
    if (send) { send.disabled = true; send.classList.remove("active"); }

    showTyping();

    // Build context
    const context = {
      productTitle: currentProduct?.title,
      productPrice: currentProduct?.price,
      pageType: currentProduct?.type,
      timeOnPage: Math.round((Date.now() - pageEntryTime) / 1000),
      cartTotal: cartState.total,
      cartCount: cartState.count,
      cartItems: cartState.items?.map(i => i.title).join(", "),
      freeShippingThreshold: FREE_SHIPPING_THRESHOLD,
      remainingForFreeShipping: Math.max(0, FREE_SHIPPING_THRESHOLD - cartState.total),
      isReturning: isReturningToPage(),
    };

    try {
      const res = await fetch(`${BACKEND}/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          shop: SHOP,
          sessionId: SESSION_ID,
          message: text,
          context,
        }),
      });

      const data = await res.json();
      hideTyping();
      const reply = data.reply || "Lo siento, ha habido un error.";
      addAIMessage(reply, false);
      messages.push({ role: "assistant", content: reply });

    } catch {
      hideTyping();
      addAIMessage("Ha habido un problema de conexión. Inténtalo de nuevo.", false);
    }

    isLoading = false;
    if (send) send.disabled = false;
  }

  // ── DOM HELPERS
  function addUserMessage(text) {
    const container = document.getElementById("sa-messages");
    const el = document.createElement("div");
    el.className = "sa-msg-user";
    el.textContent = text;
    container.appendChild(el);
    scrollBottom();
  }

  function addAIMessage(text, isProactive) {
    const container = document.getElementById("sa-messages");
    const row = document.createElement("div");
    row.className = "sa-msg-ai-row";
    row.innerHTML = `
      <div class="sa-msg-ai-avatar">🧑‍💼</div>
      <div class="${isProactive ? "sa-msg-proactive" : "sa-msg-ai"}">${escHtml(text)}</div>
    `;
    container.appendChild(row);
    scrollBottom();
  }

  function showTyping() {
    const container = document.getElementById("sa-messages");
    const el = document.createElement("div");
    el.id = "sa-typing-el";
    el.className = "sa-msg-ai-row";
    el.innerHTML = `<div class="sa-msg-ai-avatar">🧑‍💼</div><div class="sa-typing"><span></span><span></span><span></span></div>`;
    container.appendChild(el);
    scrollBottom();
  }

  function hideTyping() {
    document.getElementById("sa-typing-el")?.remove();
  }

  function scrollBottom() {
    const el = document.getElementById("sa-messages");
    if (el) el.scrollTop = el.scrollHeight;
  }

  function escHtml(str) {
    return (str || "").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
  }

})();
