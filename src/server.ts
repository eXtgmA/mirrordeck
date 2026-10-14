import type { ServerWebSocket } from "bun";
import { join } from "node:path";
import { Store, type FitMode, type Session } from "./store.ts";

const PORT = Number(process.env.PORT ?? 3000);
const DATA_DIR = process.env.DATA_DIR ?? join(import.meta.dir, "..", "data");
const ADMIN_TOKEN = process.env.ADMIN_TOKEN ?? "";
const PUBLIC_DIR = join(import.meta.dir, "..", "public");
const MAX_UPLOAD = 50 * 1024 * 1024;

if (!ADMIN_TOKEN) {
  console.error("ADMIN_TOKEN is not set – refusing to start.");
  process.exit(1);
}

const store = new Store(DATA_DIR);

type Role = "presenter" | "viewer";
interface WsData {
  id: string;
  role: Role;
}

const viewerCounts = new Map<string, number>();

const viewerTopic = (id: string) => `v:${id}`;
const presenterTopic = (id: string) => `p:${id}`;

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}

function isAdmin(req: Request): boolean {
  return req.headers.get("authorization") === `Bearer ${ADMIN_TOKEN}`;
}

function publicMeta(s: Session) {
  return { id: s.id, title: s.title, mode: s.mode, createdAt: s.createdAt };
}

function adminMeta(s: Session) {
  return { ...publicMeta(s), key: s.key, viewers: viewerCounts.get(s.id) ?? 0 };
}

const NO_CACHE = { "cache-control": "no-cache" };

// Content hash appended to asset URLs, so no browser or proxy cache can pair new pages with old assets.
const ASSET_VERSION = Bun.hash(
  (await Promise.all(["common.js", "style.css"].map((f) => Bun.file(join(PUBLIC_DIR, f)).text()))).join(""),
).toString(36);

async function page(name: string): Promise<Response> {
  const html = (await Bun.file(join(PUBLIC_DIR, name)).text())
    .replaceAll('"/common.js"', `"/common.js?v=${ASSET_VERSION}"`)
    .replaceAll('"/style.css"', `"/style.css?v=${ASSET_VERSION}"`);
  return new Response(html, { headers: { ...NO_CACHE, "content-type": "text/html; charset=utf-8" } });
}

function extractTitle(html: string, fallback: string): string {
  const m = /<title[^>]*>([^<]*)<\/title>/i.exec(html);
  return m?.[1]?.trim() || fallback;
}

// Inlined (not <script src>) so a cached old bridge can never be combined with a newer app.
const BRIDGE_JS = await Bun.file(join(PUBLIC_DIR, "bridge.js")).text();

function injectBridge(html: string, role: string): string {
  const tag = `<script data-role="${role}">${BRIDGE_JS}</script>`;
  // Inject as early as possible so the bridge's capture listeners run before the deck's own.
  const head = /<head[^>]*>/i.exec(html);
  if (head) return html.slice(0, head.index + head[0].length) + tag + html.slice(head.index + head[0].length);
  const htmlTag = /<html[^>]*>/i.exec(html);
  if (htmlTag) return html.slice(0, htmlTag.index + htmlTag[0].length) + tag + html.slice(htmlTag.index + htmlTag[0].length);
  return tag + html;
}

function broadcastViewerCount(id: string): void {
  server.publish(presenterTopic(id), JSON.stringify({ type: "viewers", count: viewerCounts.get(id) ?? 0 }));
}

const server = Bun.serve({
  port: PORT,
  maxRequestBodySize: MAX_UPLOAD + 1024 * 1024,

  routes: {
    "/": () => page("index.html"),
    "/p/:id": (req) => (store.get(req.params.id) ? page("presenter.html") : new Response("Not found", { status: 404 })),
    "/v/:id": (req) => (store.get(req.params.id) ? page("viewer.html") : new Response("Not found", { status: 404 })),

    "/raw/:id": async (req) => {
      const session = store.get(req.params.id);
      if (!session) return new Response("Not found", { status: 404 });
      const role = new URL(req.url).searchParams.get("role");
      const safeRole = role === "presenter" || role === "preview" ? role : "viewer";
      const html = await Bun.file(store.deckPath(session.id)).text();
      return new Response(injectBridge(html, safeRole), {
        headers: {
          "content-type": "text/html; charset=utf-8",
          // Even if opened directly, the deck runs in an opaque origin without access to the app.
          "content-security-policy": "sandbox allow-scripts allow-popups allow-popups-to-escape-sandbox",
          "cache-control": "no-store",
        },
      });
    },

    "/api/decks": {
      GET: (req) => (isAdmin(req) ? json(store.list().map(adminMeta)) : json({ error: "unauthorized" }, 401)),
      POST: async (req) => {
        if (!isAdmin(req)) return json({ error: "unauthorized" }, 401);
        const form = await req.formData();
        const file = form.get("file");
        if (!(file instanceof File)) return json({ error: "file missing" }, 400);
        if (file.size > MAX_UPLOAD) return json({ error: "file too large" }, 413);
        const html = await file.text();
        const mode: FitMode = form.get("mode") === "fill" ? "fill" : "fit";
        const title = String(form.get("title") || "").trim() || extractTitle(html, file.name.replace(/\.html?$/i, ""));
        const session = await store.create(html, title, mode);
        return json(adminMeta(session), 201);
      },
    },

    "/api/decks/:id": {
      GET: (req) => {
        const session = store.get(req.params.id);
        return session ? json(publicMeta(session)) : json({ error: "not found" }, 404);
      },
      DELETE: async (req) => {
        if (!isAdmin(req)) return json({ error: "unauthorized" }, 401);
        if (!store.get(req.params.id)) return json({ error: "not found" }, 404);
        server.publish(viewerTopic(req.params.id), JSON.stringify({ type: "ended" }));
        await store.remove(req.params.id);
        return new Response(null, { status: 204 });
      },
    },

    "/ws/:id": (req, srv) => {
      const session = store.get(req.params.id);
      if (!session) return new Response("Not found", { status: 404 });
      const key = new URL(req.url).searchParams.get("key");
      const role: Role = key === session.key ? "presenter" : "viewer";
      if (key && role === "viewer") return new Response("Forbidden", { status: 403 });
      return srv.upgrade(req, { data: { id: session.id, role } })
        ? undefined
        : new Response("Upgrade failed", { status: 400 });
    },

    "/healthz": () => new Response("ok"),
  },

  async fetch(req) {
    const path = new URL(req.url).pathname;
    // Static assets (flat directory, no traversal).
    if (/^\/[\w.-]+\.(js|css|svg|ico)$/.test(path)) {
      const file = Bun.file(join(PUBLIC_DIR, path.slice(1)));
      if (await file.exists()) return new Response(file, { headers: NO_CACHE });
    }
    return new Response("Not found", { status: 404 });
  },

  websocket: {
    data: {} as WsData,
    idleTimeout: 120,
    sendPings: true,
    maxPayloadLength: 64 * 1024,

    open(ws: ServerWebSocket<WsData>) {
      const { id, role } = ws.data;
      const session = store.get(id);
      if (!session) return ws.close(4404, "not found");
      ws.subscribe(role === "presenter" ? presenterTopic(id) : viewerTopic(id));
      if (role === "viewer") viewerCounts.set(id, (viewerCounts.get(id) ?? 0) + 1);
      ws.send(JSON.stringify({ type: "init", role, state: session.state, inputs: session.inputs, mode: session.mode }));
      broadcastViewerCount(id);
    },

    message(ws: ServerWebSocket<WsData>, raw) {
      if (ws.data.role !== "presenter") return; // viewers are read-only
      const session = store.get(ws.data.id);
      if (!session || typeof raw !== "string") return;
      let msg: { type?: string; state?: unknown; input?: unknown; data?: unknown };
      try {
        msg = JSON.parse(raw);
      } catch {
        return;
      }
      switch (msg.type) {
        case "state":
          store.setState(session, msg.state);
          server.publish(viewerTopic(session.id), JSON.stringify({ type: "state", state: msg.state }));
          break;
        case "input":
          store.addInput(session, msg.input);
          server.publish(viewerTopic(session.id), JSON.stringify({ type: "input", input: msg.input }));
          break;
        case "pointer":
        case "hover":
        case "click":
          // Transient presenter gestures: relayed live, never stored.
          server.publish(viewerTopic(session.id), JSON.stringify({ type: msg.type, data: msg.data }));
          break;
        case "reset":
          store.resetInputs(session);
          server.publish(viewerTopic(session.id), JSON.stringify({ type: "reload" }));
          break;
      }
    },

    close(ws: ServerWebSocket<WsData>) {
      const { id, role } = ws.data;
      if (role === "viewer") {
        viewerCounts.set(id, Math.max(0, (viewerCounts.get(id) ?? 1) - 1));
        broadcastViewerCount(id);
      }
    },
  },
});

console.log(`mirrordeck listening on http://localhost:${server.port}`);
