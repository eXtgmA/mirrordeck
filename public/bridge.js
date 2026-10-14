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
      const zone = role !== "preview" && interactiveOf(e);
      if (zone) {
        zone.addEventListener(type, stopAtBoundary, { once: true });
        return;
      }
      if (replaying) return;
      if (locked) {
        e.stopImmediatePropagation();
        e.preventDefault();
      }
    }, { capture: true, passive: false });
  }

  if (viewerLocal) {
    // Let the viewer page show its controls on mouse movement (the iframe swallows those events).
    let last = 0;
    window.addEventListener("mousemove", (e) => {
      const now = Date.now();
      if (now - last > 100) { last = now; post({ type: "activity", x: e.clientX, y: e.clientY }); }
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

  // ---------- presenter mirroring: laser pointer, hover, shared clicks ----------
  // Elements are addressed by their child-index path from <body>; every client runs the same deck markup.
  // (Not from <html>: the bridge adds role-specific nodes there.)
  const pathOf = (el) => {
    if (!document.body.contains(el)) return null;
    const path = [];
    for (let n = el; n !== document.body; n = n.parentElement) {
      if (!n.parentElement) return null;
      path.unshift(Array.prototype.indexOf.call(n.parentElement.children, n));
    }
    return path;
  };
  const elementAt = (path) => {
    let n = document.body;
    for (const i of path || []) { n = n.children[i]; if (!n) return null; }
    return n;
  };
  // Pointer coordinates are relative to the visible slide so they survive different aspect ratios.
  const pointerFrame = () => {
    const slide = document.querySelector(".slide.active");
    return slide ? slide.getBoundingClientRect() : { left: 0, top: 0, width: innerWidth, height: innerHeight };
  };

  let dot = null;
  const showPointer = (p) => {
    if (!dot) {
      dot = document.createElement("div");
      dot.style.cssText = "position:fixed;z-index:2147483647;pointer-events:none;width:22px;height:22px;margin:-11px 0 0 -11px;" +
        "border-radius:50%;background:rgba(255,30,60,.95);box-shadow:0 0 14px 6px rgba(255,30,60,.55);" +
        "transition:left .06s linear,top .06s linear;display:none";
      document.documentElement.append(dot);
    }
    if (!p || p.hidden) { dot.style.display = "none"; return; }
    const r = pointerFrame();
    dot.style.left = `${r.left + p.x * r.width}px`;
    dot.style.top = `${r.top + p.y * r.height}px`;
    dot.style.display = "block";
  };

  // :hover cannot be triggered from script, so every :hover rule is duplicated as a .md-hover rule.
  const hoverCss = (rules) => {
    let out = "";
    for (const r of rules) {
      if (r instanceof CSSStyleRule && r.selectorText.includes(":hover")) {
        out += `${r.selectorText.replace(/:hover\b/g, ".md-hover")}{${r.style.cssText}}\n`;
      } else if (r instanceof CSSMediaRule || r instanceof CSSSupportsRule) {
        const inner = hoverCss(r.cssRules);
        if (inner) out += `@${r instanceof CSSMediaRule ? "media" : "supports"} ${r.conditionText}{${inner}}\n`;
      }
    }
    return out;
  };
  const installHoverMirror = () => {
    let css = "";
    for (const sheet of document.styleSheets) {
      try { css += hoverCss(sheet.cssRules); } catch { /* cross-origin stylesheet: rules are not readable */ }
    }
    const style = document.createElement("style");
    style.textContent = css;
    document.documentElement.append(style);
  };

  let hoverChain = [];
  const setHover = (data) => {
    const target = data && elementAt(data.path);
    const previous = hoverChain[0];
    if (target === previous) return;
    for (const n of hoverChain) n.classList.remove("md-hover");
    hoverChain = [];
    for (let n = target; n && n.nodeType === 1; n = n.parentElement) {
      n.classList.add("md-hover");
      hoverChain.push(n);
    }
    replaying = true;
    try {
      previous?.dispatchEvent(new MouseEvent("mouseout", { bubbles: true, relatedTarget: target }));
      target?.dispatchEvent(new MouseEvent("mouseover", { bubbles: true, relatedTarget: previous }));
    } finally {
      replaying = false;
    }
  };

  const mirrorClick = (data) => {
    const target = data && elementAt(data.path);
    if (!target) return;
    replaying = true;
    try {
      target.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
    } finally {
      replaying = false;
    }
  };

  let lastHover = null;
  const startPresenterMirroring = () => {
    let lastMove = 0;
    let trailing = null;
    window.addEventListener("mousemove", (e) => {
      const now = Date.now();
      const send = () => {
        lastMove = Date.now();
        const r = pointerFrame();
        post({ type: "pointer", data: { x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height } });
      };
      clearTimeout(trailing);
      if (now - lastMove >= 33) send();
      else trailing = setTimeout(send, 33 - (now - lastMove));
    }, { passive: true });
    document.addEventListener("mouseout", (e) => {
      if (e.relatedTarget) return; // still inside the deck
      lastHover = null;
      clearTimeout(trailing);
      post({ type: "pointer", data: { hidden: true } });
      post({ type: "hover", data: null });
    });
    // mousemove as well as mouseover: re-entering the iframe onto the same element fires no mouseover.
    const reportHover = (e) => {
      if (replaying || e.target === lastHover || !(e.target instanceof Element)) return;
      lastHover = e.target;
      const path = pathOf(e.target);
      if (path) post({ type: "hover", data: { path } });
    };
    window.addEventListener("mouseover", reportHover, true);
    window.addEventListener("mousemove", reportHover, { capture: true, passive: true });
    window.addEventListener("click", (e) => {
      if (replaying || !(e.target instanceof Element) || !e.target.closest('[data-interactive="shared"]')) return;
      const path = pathOf(e.target);
      if (path) post({ type: "click", data: { path } });
    }, true);
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
      case "pointer":
        showPointer(msg.data);
        if (msg.data?.hidden) lastHover = null; // pointer left the deck: next hover must be reported again
        break;
      case "hover": if (role === "viewer") setHover(msg.data); break;
      case "click": if (role === "viewer") mirrorClick(msg.data); break;
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
    if (role === "presenter") {
      startPresenterReporting();
      startPresenterMirroring();
    }
    if (role === "viewer") installHoverMirror();
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
