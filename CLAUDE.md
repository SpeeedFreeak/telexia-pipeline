# Pipeline by Redneck Engineering

Säljpipeline-verktyg (webbapp/PWA) för CJ. Live på **https://speeedfreeak.github.io/telexia-pipeline/** via GitHub Pages — varje push till `main` deployas automatiskt (10–30 s).

## Arkitektur

- **Hela appen är EN fil: `index.html`** (HTML + CSS + JS, inga byggsteg, inga ramverk). Håll det så — skapa inte separata .js/.css-filer.
- `manifest.json` + `sw.js` + `icon-*.png` + `logo.png` = PWA-installation (ikon/namn "Pipeline").
- Data lagras i **localStorage** och synkas till användarens **Google Drive** (`telexia-pipeline-data.json`) via OAuth (implicit flow, klient-id i koden är OK — det är publikt per design).
- OCR för skärmdumpar: **Tesseract.js lazy-laddas från CDN**, körs helt lokalt i webbläsaren.

## Datamodell (huvuddrag)

- `PIPELINES` — flera parallella pipelines (id, namn, färg). Aktiv pipeline styr Pipeline-fliken.
- `STAGES` (kategorier), `TAGS`, `leads` (processer), `questions` — allt stämplat med `pipelineId`. Taggar kan vara `global: true`.
- `customers` — kundregistret är **delat** mellan alla pipelines; kundens pipelines härleds från dess processer.
- Migreringar körs vid load och är idempotenta (`migrateLeads`, `migrateToCustomers`, `migratePipelines`).

## FÅR ALDRIG ÄNDRAS (bryter användarens data)

- localStorage-nycklarna med `telexia_`-prefix (t.ex. `telexia_pipeline_leads_v1`) — de heter så av historiska skäl trots att appen numera heter Pipeline.
- Drive-filnamnet `DRIVE_FILE_NAME = 'telexia-pipeline-data.json'`.
- Repots namn / Pages-URL:en (inlagd som PWA på användarens enheter).
- Lägg **aldrig** API-nycklar eller hemligheter i koden — repot är publikt. Kräver en funktion hemligheter: föreslå en Cloudflare Worker-proxy.

## Innan varje commit (sanity-checks)

1. Extrahera `<script>`-blocket och kör `node --check` på det (syntaxkontroll).
2. `grep` att lagringsnycklarna ovan är orörda.
3. Kontrollera att filen inte fått trailing NUL-bytes (har hänt med vissa filverktyg): filen ska sluta med `</html>` + radbrytning.
4. Vid ändringar i `manifest.json`: validera JSON.

## Deploy + verifiering

`git add -A && git commit -m "..." && git push` → vänta på GitHub Pages-deployment → öppna livesajten och verifiera ändringen i webbläsaren (inloggningsgaten: "Logga in med Google", befintlig session). Testa aldrig genom att spara testdata i användarens riktiga pipelines utan att ta bort den efteråt.

## Konventioner

- Språk i UI och commit-meddelanden: **svenska**.
- Mörkt tema (bakgrund `#0f1115`, paneler `#161922`) — följ befintliga CSS-mönster.
- Mobilanpassning sker i `@media (max-width: 720px)`-blocket — nya UI-element ska fungera på mobil.
- Pipeline-färgen är den pedagogiska bäraren: badges/chips/prickar återanvänder `plBadge()` / `renderPlChips()`.
- Flerpipeline-UI (chips, badges, kolumner) visas bara när fler än en pipeline finns.

## Backlog (öppna problem)

1. **Import från företagsregister (pausad):** sök på namn/orgnr, hämta uppgifter via Bolagsverkets avgiftsfria API för värdefulla datamängder + Cloudflare Worker-proxy (nycklar kan inte ligga i publik kod).
2. **Orgnr som eget fält** på kundkortet (idag bara logganteckning från OCR) — blir nyckel för registerimporten.
3. **OCR-kvalitet på röriga skärmdumpar** — ev. uppgradera till Claude API via samma proxy.
