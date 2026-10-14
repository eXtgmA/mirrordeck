/*
 * mirrordeck bridge – injected into every uploaded deck.
 * Talks to the surrounding mirrordeck page via postMessage.
 *
 * Modes:
 *   "deck"   – the deck exposes window.deck (see PROMPT.md). Reliable.
 *   "events" – fallback for arbitrary HTML: hash + scroll are synced as state,
 *              keyboard input is forwarded and replayed.
 *
 * Roles: presenter (interactive, reports changes), viewer / preview (locked, follow only).
 */
(() => {
  const role = document.currentScript?.dataset.role || "viewer";
  const locked = role !== "presenter";
  const NAV_KEYS = new Set([
    "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", " ", "PageUp", "PageDown",
    "Home", "End", "Enter", "Backspace",
  ]);

  let mode = null;
  let replaying = false;

  const post = (msg) => parent.postMessage({ md: true, ...msg }, "*");

  // ---------- input handling ----------
  // Elements marked [data-interactive] stay usable for everyone (viewers act locally).
  // Their events are contained: they never bubble up to the deck's own navigation handlers.
  const INPUT_EVENTS = ["keydown", "keyup", "keypress", "click", "dblclick", "mousedown", "mouseup",
    "pointerdown", "pointerup", "touchstart", "touchend", "wheel", "contextmenu"];
  const interactiveOf = (e) => (e.target instanceof Element ? e.target.closest("[data-interactive]") : null);
  const stopAtBoundary = (e) => e.stopPropagation();
  const viewerLocal = role === "viewer";

  for (const type of INPUT_EVENTS) {
    window.addEventListener(type, (e) => {
      if (replaying) return;
      const zone = role !== "preview" && interactiveOf(e);
      if (zone) {
        zone.addEventListener(type, stopAtBoundary, { once: true });
        return;
      }
      if (locked) {
        e.stopImmediatePropagation();
        e.preventDefault();
      }
    }, { capture: true, passive: false });
  }

  if (viewerLocal) {
    // Let the viewer page show its controls on mouse movement (the iframe swallows those events).
    let last = 0;
    window.addEventListener("mousemove", () => {
      const now = Date.now();
      if (now - last > 500) { last = now; post({ type: "activity" }); }
    }, { passive: true });
  }

  if (locked) {
    const style = document.createElement("style");
    style.textContent = `html, body, body * { cursor: default !important; }
      [data-interactive] :is(a, button, summary, label, select, [role=button], input[type=checkbox], input[type=radio]),
      [data-interactive]:is(a, button, summary, label, [role=button]) { cursor: pointer !important; }
      [data-interactive] :is(input:not([type=checkbox]):not([type=radio]), textarea) { cursor: text !important; }`;
    document.documentElement.append(style);
  }

  // ---------- helpers ----------
  const scrollState = () => {
    const el = document.scrollingElement || document.documentElement;
    const maxX = el.scrollWidth - el.clientWidth;
    const maxY = el.scrollHeight - el.clientHeight;
    return { sx: maxX > 0 ? el.scrollLeft / maxX : 0, sy: maxY > 0 ? el.scrollTop / maxY : 0 };
  };

  const applyScroll = (s) => {
    const el = document.scrollingElement || document.documentElement;
    el.scrollTo({
      left: (s.sx || 0) * (el.scrollWidth - el.clientWidth),
      top: (s.sy || 0) * (el.scrollHeight - el.clientHeight),
      behavior: "instant",
    });
  };

  const deckState = () => {
    const s = window.deck.getState();
    return { kind: "deck", slide: s.slide, step: s.step ?? 0, total: window.deck.total ?? null };
  };

  const eventsState = () => ({ kind: "events", hash: location.hash, ...scrollState() });

  const currentState = () => (mode === "deck" ? deckState() : eventsState());

  const dispatchKey = (key) => {
    replaying = true;
    try {
      const target = document.activeElement && document.activeElement !== document.body ? document.activeElement : document;
      for (const type of ["keydown", "keyup"]) {
        target.dispatchEvent(new KeyboardEvent(type, { key, code: key === " " ? "Space" : key, bubbles: true, cancelable: true }));
      }
    } finally {
      replaying = false;
    }
  };

  // ---------- applying remote state ----------
  const apply = (state) => {
    if (!state) return;
    if (mode === "deck" && state.kind === "deck") {
      window.deck.goTo(state.slide, state.step ?? 0);
    } else if (mode === "events" && state.kind === "events") {
      if (state.hash !== location.hash) location.hash = state.hash;
      applyScroll(state);
    }
  };

  const next = () => (mode === "deck" ? window.deck.next() : dispatchKey("ArrowRight"));
  const prev = () => (mode === "deck" ? window.deck.prev() : dispatchKey("ArrowLeft"));

  window.addEventListener("message", (e) => {
    if (e.source !== parent) return;
    const msg = e.data;
    if (!msg || !msg.md || !mode) return;
    switch (msg.type) {
      case "apply": apply(msg.state); break;
      case "replay":
        for (const input of msg.inputs || []) if (input && input.key) dispatchKey(input.key);
        apply(msg.state);
        break;
      case "input": if (msg.input && msg.input.key) dispatchKey(msg.input.key); break;
      case "next": next(); break;
      case "prev": prev(); break;
      case "goto": if (mode === "deck") window.deck.goTo(msg.slide, msg.step ?? 0); break;
    }
  });

  // ---------- presenter: report changes ----------
  let lastSent = "";
  const report = () => {
    const state = currentState();
    const key = JSON.stringify(state);
    if (key === lastSent) return;
    lastSent = key;
    post({ type: "state", state });
  };

  const startPresenterReporting = () => {
    if (mode === "deck") {
      window.addEventListener("deckchange", report);
    } else {
      // Forward navigation keys typed inside the deck (fallback replay for viewers).
      window.addEventListener("keydown", (e) => {
        if (NAV_KEYS.has(e.key) && !e.repeat && !interactiveOf(e)) post({ type: "input", input: { key: e.key } });
      }, true);
      window.addEventListener("hashchange", report);
      let t = null;
      window.addEventListener("scroll", () => {
        clearTimeout(t);
        t = setTimeout(report, 80);
      }, { passive: true, capture: true });
    }
    // Keys pressed inside the iframe should also reach the presenter UI (e.g. shortcuts).
    window.addEventListener("keydown", (e) => {
      if (!e.repeat && !replaying) post({ type: "key", key: e.key });
    });
  };

  // ---------- detection ----------
  const isDeck = () => window.deck && typeof window.deck.goTo === "function" && typeof window.deck.getState === "function";

  const detect = () => {
    mode = isDeck() ? "deck" : "events";
    if (mode === "deck") {
      window.deck.next ||= () => {};
      window.deck.prev ||= () => {};
    }
    if (role === "presenter") startPresenterReporting();
    post({ type: "ready", mode, total: mode === "deck" ? window.deck.total ?? null : null, state: currentState() });
    if (role === "presenter") report();
  };

  const waitForDeck = (deadline) => {
    if (isDeck() || Date.now() > deadline) detect();
    else setTimeout(() => waitForDeck(deadline), 50);
  };

  if (document.readyState === "complete") waitForDeck(Date.now() + 300);
  else window.addEventListener("load", () => waitForDeck(Date.now() + 300));
})();
