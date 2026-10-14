# Prompt-Vorlage für mirrordeck-Präsentationen

Diesen Block an den eigentlichen Inhalts-Prompt anhängen.

---

Erstelle die Präsentation als **eine einzige, eigenständige HTML-Datei** und halte dich exakt an folgende technische Vorgaben (sie wird in „mirrordeck“ abgespielt und live an Zuschauer gespiegelt):

1. **Alles inline**: CSS und JavaScript direkt in der Datei. Keine externen Ressourcen (keine CDNs, keine Webfonts aus dem Netz, keine externen Bilder). Bilder nur als inline-SVG oder `data:`-URI.
2. **Folien**: Jede Folie ist ein `<section class="slide">`. Genau eine Folie ist sichtbar (Klasse `active`).
3. **Schritte**: Elemente, die nacheinander erscheinen sollen, bekommen `data-step="1"`, `data-step="2"`, … (pro Folie ab 1). Schritt 0 = keine dieser Elemente sichtbar.
4. **API**: Stelle global bereit:
   ```js
   window.deck = {
     goTo(slide, step),   // 0-basierte Folie, Schritt >= 0; Werte begrenzen
     next(),              // nächster Schritt, sonst nächste Folie
     prev(),              // vorheriger Schritt, sonst vorherige Folie (mit allen Schritten)
     getState(),          // -> { slide, step }
     total,               // Anzahl Folien
   };
   ```
5. **Event**: Nach *jeder* Zustandsänderung (auch beim initialen Rendern):
   `window.dispatchEvent(new CustomEvent("deckchange", { detail: { slide, step } }))`.
6. **Steuerung**: Pfeiltasten, Leertaste, PageUp/PageDown, Home/End und Klick (= weiter). Alle Navigation läuft über `goTo/next/prev`.
7. **Zustand nur aus `slide`/`step`**: Die Darstellung muss sich vollständig aus diesen beiden Werten ergeben (keine Zufallswerte, kein Zustand, der nur durch Klickfolgen entsteht). Animationen dürfen beim Wechsel abspielen.
8. **Responsiv**: Gestaltet für 16:9 (1920×1080), aber ohne feste Pixelmaße für das Layout: `vw`/`vh`/`vmin` und `clamp()` für Schriften und Abstände, flexible Grids. Kein Scrollen innerhalb der Seite (`overflow: hidden` auf `body`).
9. **Kein** `alert`, `localStorage`, `fetch`, Popups oder Navigation zu anderen Seiten (die Datei läuft in einer Sandbox).
10. Die URL-Raute darf optional `#/slide/step` spiegeln; `history.replaceState` dann in `try/catch` kapseln.
11. **Interaktive Elemente für Zuschauer**: Elemente, die jeder Zuschauer selbst bedienen darf (Quiz, `<details>`, Tabs, Tooltips, Links), mit dem Attribut `data-interactive` markieren. Alles andere ist für Zuschauer gesperrt. Regeln:
    - Interaktionen darin wirken nur lokal und dürfen **nie** `goTo/next/prev` auslösen oder Folie/Schritt ändern.
    - Klicks und Tasten darin erreichen die globale Navigation nicht (mirrordeck stoppt sie am Element) – trotzdem keine Navigation darauf aufbauen.
    - Links mit `target="_blank" rel="noopener"`. Keine `<form>`-Submits (Eingabefelder sind ok, Auswertung per JavaScript).
    - `data-interactive="shared"`: Klicks des Präsentators auf dieses Element werden bei allen Zuschauern ausgelöst (z. B. Erklär-Popups, Aufklapper). Zuschauer können trotzdem selbst klicken. Die Klick-Handler müssen deshalb ohne echte Mauskoordinaten auskommen.
12. **Hover-Effekte** nur per CSS `:hover` umsetzen (keine JS-Hover-Logik): mirrordeck spiegelt den Hover des Präsentators zu den Zuschauern, indem es `:hover`-Regeln dupliziert.

Eine Referenzimplementierung liegt in `examples/beispiel.html`.
