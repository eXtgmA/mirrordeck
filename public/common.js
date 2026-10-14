// Shared helpers for presenter and viewer pages.

const BASE_W = 1920;
const BASE_H = 1080;

/**
 * Mounts a sandboxed deck iframe into `container`.
 * Returns a controller to send bridge commands and switch the fit mode.
 */
export function mountDeck(container, { id, role, interactive, onMessage }) {
  const stage = document.createElement("div");
  stage.className = "stage";
  const iframe = document.createElement("iframe");
  iframe.setAttribute("sandbox", "allow-scripts allow-popups allow-popups-to-escape-sandbox");
  iframe.setAttribute("title", "Präsentation");
  iframe.src = `/raw/${encodeURIComponent(id)}?role=${role}`;
  stage.append(iframe);
  if (!interactive) {
    const shield = document.createElement("div");
    shield.className = "shield";
    stage.append(shield);
  }
  container.append(stage);

  let fit = "fit";
  const layout = () => {
    const { clientWidth: w, clientHeight: h } = container;
    if (fit === "fill") {
      Object.assign(iframe.style, { width: `${w}px`, height: `${h}px`, transform: "none" });
      Object.assign(stage.style, { width: `${w}px`, height: `${h}px`, left: "0px", top: "0px" });
      return;
    }
    const scale = Math.min(w / BASE_W, h / BASE_H);
    const sw = BASE_W * scale;
    const sh = BASE_H * scale;
    Object.assign(iframe.style, { width: `${BASE_W}px`, height: `${BASE_H}px`, transform: `scale(${scale})` });
    Object.assign(stage.style, { width: `${sw}px`, height: `${sh}px`, left: `${(w - sw) / 2}px`, top: `${(h - sh) / 2}px` });
  };
  new ResizeObserver(layout).observe(container);

  window.addEventListener("message", (e) => {
    if (e.source !== iframe.contentWindow || !e.data || !e.data.md) return;
    onMessage?.(e.data);
  });

  return {
    iframe,
    send(msg) {
      iframe.contentWindow?.postMessage({ md: true, ...msg }, "*");
    },
    setFit(mode) {
      fit = mode === "fill" ? "fill" : "fit";
      layout();
    },
    reload() {
      iframe.src = iframe.src;
    },
  };
}

/** Reconnecting WebSocket. `onStatus(true|false)` reports connectivity. */
export function connect(id, key, { onMessage, onStatus, onFatal }) {
  let ws = null;
  let delay = 500;
  let stopped = false;

  const open = () => {
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    const qs = key ? `?key=${encodeURIComponent(key)}` : "";
    ws = new WebSocket(`${proto}//${location.host}/ws/${encodeURIComponent(id)}${qs}`);
    let opened = false;
    ws.onopen = () => {
      opened = true;
      delay = 500;
      onStatus?.(true);
    };
    ws.onmessage = (e) => onMessage(JSON.parse(e.data));
    ws.onclose = (e) => {
      onStatus?.(false);
      if (stopped) return;
      if (!opened && onFatal && delay > 4000) {
        onFatal?.();
        return;
      }
      setTimeout(open, delay);
      delay = Math.min(delay * 2, 10000);
    };
  };
  open();

  return {
    send(msg) {
      if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
    },
    stop() {
      stopped = true;
      ws?.close();
    },
  };
}

export function deckId() {
  return decodeURIComponent(location.pathname.split("/")[2] || "");
}
