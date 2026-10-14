# mirrordeck

HTML-Präsentation hochladen, selbst durchnavigieren – Zuschauer sehen über einen eigenen Link live dasselbe, ohne selbst navigieren zu können.

## Starten

```bash
# lokal
bun install
ADMIN_TOKEN=geheim bun run dev        # http://localhost:3000

# Container
ADMIN_TOKEN=geheim docker compose up -d --build
```

| Variable      | Default  | Bedeutung                                   |
|---------------|----------|---------------------------------------------|
| `ADMIN_TOKEN` | –        | Pflicht. Schützt Upload, Liste, Löschen.    |
| `PORT`        | `3000`   |                                             |
| `DATA_DIR`    | `./data` | Hochgeladene Decks + `sessions.json`        |

Hinter einem Reverse-Proxy muss WebSocket-Upgrade für `/ws/*` erlaubt sein.

## Ablauf

1. `/` öffnen, Token eingeben, HTML-Datei hochladen.
2. **Präsentieren** öffnet `/p/<id>?key=<geheim>` – nur mit diesem Link wird navigiert (Pfeiltasten, Leertaste, Klick, Buttons). Seitenleiste mit Vorschau der nächsten Folie, Zuschauerzahl und Zuschauer-Link. `S` blendet die Seitenleiste aus, `F` = Vollbild.
3. Den **Zuschauer-Link** `/v/<id>` verteilen. Zuschauer können zwischen „16:9 fest“ und „Vollfläche“ umschalten (Standard wird beim Upload gewählt).

## Präsentationen erzeugen

Die Prompt-Vorlage in [PROMPT.md](PROMPT.md) an den LLM-Prompt anhängen. Referenz: [examples/beispiel.html](examples/beispiel.html).

**Interaktive Elemente:** Mit `data-interactive` markierte Elemente können auch Zuschauer bedienen (z. B. Quiz, `<details>`, Links in neuem Tab). Die Interaktion bleibt lokal beim jeweiligen Zuschauer und löst keine Navigation aus; Folie und Schritt bleiben synchron.

**Zeigen:** Im Präsentator-Panel gibt es einen Laserpointer (`L`): deine Mausposition erscheint bei allen Zuschauern als roter Punkt (relativ zur Folie, daher unabhängig vom Seitenverhältnis). Mit „Hover & Klicks spiegeln“ sehen Zuschauer deine CSS-`:hover`-Effekte, und Klicks auf `data-interactive="shared"`-Elemente werden bei allen ausgelöst. Beides wird live weitergereicht, nicht gespeichert – Nachzügler sehen es erst ab der nächsten Geste.

**Sync-Modi** (automatisch erkannt):
- **mirrordeck-Format** (`window.deck` vorhanden): Folie + Schritt werden synchronisiert. Zuverlässig, inkl. Vorschau und Nachzüglern.
- **Fallback** (beliebige HTML): URL-Raute, Scrollposition und Navigationstasten werden übertragen und bei Zuschauern nachgespielt. Erzwingt 16:9, keine Vorschau. Ein Neuladen der Präsentator-Seite setzt alle Zuschauer zurück.

## Architektur

- `src/server.ts` – Bun-Server: Routen, Upload-API, WebSocket (Pub/Sub pro Präsentation; hunderte Zuschauer pro Container unproblematisch).
- `src/store.ts` – Sessions im Speicher, persistiert nach `DATA_DIR`.
- `public/bridge.js` – wird in jede Präsentation injiziert; erkennt den Modus, meldet/übernimmt Zustand per `postMessage`, sperrt Eingaben bei Zuschauern.
- Decks laufen in `<iframe sandbox="allow-scripts allow-popups">` plus `CSP: sandbox` (eigener, opaker Origin – kein Zugriff auf die App).

## Später (TODO)

- Sprechernotizen (`<aside class="notes">`)
- Mehrere Nutzer / Login
- Ablaufdatum für Sessions, Passwortschutz für Zuschauer-Links
- Video-Sync
- Horizontale Skalierung (Redis Pub/Sub)

## CI

`.github/workflows/docker.yml` baut bei jedem Push das Image (amd64 + arm64) und veröffentlicht es auf `main` bzw. bei Tags `v*` nach `ghcr.io/<owner>/<repo>` (`latest`, Version, `sha-…`). Pull Requests werden nur gebaut.
