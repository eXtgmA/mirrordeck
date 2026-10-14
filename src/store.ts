import { mkdirSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export type FitMode = "fit" | "fill";

export interface Session {
  id: string;
  key: string;
  title: string;
  mode: FitMode;
  createdAt: string;
  /** Last state reported by the presenter bridge (opaque to the server). */
  state: unknown;
  /** Fallback mode only: recorded input events replayed for late joiners. */
  inputs: unknown[];
}

const MAX_INPUTS = 2000;

export class Store {
  private sessions = new Map<string, Session>();
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly indexFile: string;
  private readonly deckDir: string;

  constructor(dataDir: string) {
    this.deckDir = join(dataDir, "decks");
    this.indexFile = join(dataDir, "sessions.json");
    mkdirSync(this.deckDir, { recursive: true });
    if (existsSync(this.indexFile)) {
      const list = JSON.parse(readFileSync(this.indexFile, "utf8")) as Session[];
      for (const s of list) this.sessions.set(s.id, s);
    }
  }

  get(id: string): Session | undefined {
    return this.sessions.get(id);
  }

  list(): Session[] {
    return [...this.sessions.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  deckPath(id: string): string {
    return join(this.deckDir, `${id}.html`);
  }

  async create(html: string, title: string, mode: FitMode): Promise<Session> {
    const session: Session = {
      id: randomHex(6),
      key: randomHex(16),
      title,
      mode,
      createdAt: new Date().toISOString(),
      state: null,
      inputs: [],
    };
    await Bun.write(this.deckPath(session.id), html);
    this.sessions.set(session.id, session);
    this.scheduleSave(0);
    return session;
  }

  async remove(id: string): Promise<void> {
    this.sessions.delete(id);
    await Bun.file(this.deckPath(id)).delete().catch(() => undefined);
    this.scheduleSave(0);
  }

  setState(session: Session, state: unknown): void {
    session.state = state;
    this.scheduleSave(1000);
  }

  addInput(session: Session, input: unknown): void {
    session.inputs.push(input);
    if (session.inputs.length > MAX_INPUTS) session.inputs.splice(0, session.inputs.length - MAX_INPUTS);
    this.scheduleSave(1000);
  }

  resetInputs(session: Session): void {
    session.inputs = [];
    session.state = null;
    this.scheduleSave(0);
  }

  private scheduleSave(delay: number): void {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      void Bun.write(this.indexFile, JSON.stringify(this.list(), null, 2));
    }, delay);
  }
}

export function randomHex(bytes: number): string {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(bytes))).toString("hex");
}
