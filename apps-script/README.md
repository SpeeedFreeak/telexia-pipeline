# Apps Script – brevlådan för bokningsmodulen

Scriptet är den enda komponent som läser CJ:s kalendrar och Outlook-ICS, räknar restid, tar emot bokningar,
skriver i kalendern "Bokningar" och i brevlådefilerna i Drive. Det körs som CJ ("Kör som: Jag") och nås
anonymt av bokningssidan och Pipeline-appen via `BOK_SCRIPT_URL`. Specifikationen är sanningen:
`02 Projects/Pipeline/[C] Bokningsmodul - specifikation steg 1.md` (avsnitt 4, 5 och 9).

## Filer

| Fil | Innehåll |
|---|---|
| `appsscript.json` | Manifest: tidszon Europe/Stockholm, V8, explicita OAuth-scopes (sex st: `drive`, `calendar`, `script.external_request`, `script.send_mail`, `script.scriptapp`, `userinfo.email` – den sista krävs för `Session.getEffectiveUser().getEmail()` i filkontrollen, spec 4.2), Calendar advanced service v3, webapp "kör som den som distribuerar" + åtkomst "Alla" (`ANYONE_ANONYMOUS`). Ändras scopes måste CJ godkänna om scriptet. |
| `Code.gs` | Kärnan: Script Properties, filhantering (exakt tre fil-id:n), `doPost`/`doGet` med JSON-kuvert och felkoder, autentisering (bokarkod via SHA-256, adminnyckel i konstant tid), anrops- och handlingsgränser, reservationer (CacheService), `book` med idempotens och kompenserande borttagning, kalenderskrivning, notismejl, `hello`/`ping`/`geocode`/`release`, admin-stubbar (`E_NOT_IMPLEMENTED` tills M3/M5), `install()` och `dailyMaintenance()`. |
| `Calendar.gs` | Kalenderläsning: `readBusy(fran, till)`, ICS-parser, `mergeBusy`, `applyIgnore`, `buildBusyList(from, to)`. |
| `Availability.gs` | Tillgänglighet och restid: `computeAvailability(req)`, `dayPlan`, `placeTravel`, `geocodeAddress(adress)`, restid via Distance Matrix med cache, svenska röda dagar. |

Alla tre `.gs`-filer klistras in i samma Apps Script-projekt (filnamn spelar ingen roll för Apps Script, men behåll dem för läsbarhet). Inga hemligheter finns i koden – Maps-nyckel, adminnyckel och fil-id:n ligger enbart i Script Properties.

## Script Properties (Projektinställningar › Script Properties)

| Nyckel | Sätts av | Betydelse |
|---|---|---|
| `ADMIN_KEY` | CJ (klistras in från Anslut-guiden i appen) | Adminnyckeln som appen skickar i admin-anrop. Saknas den svarar admin-anrop `E_SETUP`. |
| `CONFIG_FILE_ID` | `setup` (M3) – eller manuellt vid test | Drive-id för `telexia-bokning-config.json` (skrivs av appen, läses av scriptet, cache 10 min). |
| `INBOX_FILE_ID` | `setup` (M3) – eller manuellt vid test | Drive-id för `telexia-bokning-inbox.json` (skrivs bara av scriptet, under lås). |
| `CACHE_FILE_ID` | `setup` (M3) – eller manuellt vid test | Drive-id för `telexia-bokning-cache.json` (geokodning, restid, ICS-reserv). |
| `MAPS_API_KEY` | CJ (valfri) | Google Maps-nyckel. **API-begränsning:** bara Geocoding API och Distance Matrix API. **Applikationsbegränsning: Ingen** – referrer-/IP-begränsning fungerar inte från Apps Script (UrlFetchApp skickar ingen referrer och Googles IP-pool går inte att vitlista; resultatet blir `REQUEST_DENIED`, `ping.mapsVarning` "Nyckeln avvisad" och schablonrestid överallt). Saknas nyckeln → schablonrestid. |
| `MAPS_DAILY_CAP` | CJ (valfri) | Dagstak för Maps-element, default 1000. |
| `maps_elements_<YYYYMMDD>` | scriptet | Räknare för Maps-element per dag (gallras efter 7 dagar). |
| `book_count_<YYYYMMDD>` | scriptet | Global bokningsräknare per dag (`MAX_BOOK_GLOBAL_D`, gallras efter 7 dagar). |

Saknas något av de tre fil-id:na, eller misslyckas filkontrollen (filen i papperskorgen, fel namn, fel filtyp, annan ägare), svarar alla anrop som behöver filerna `E_SETUP`. `ping` svarar alltid (`konfigurerad:false`).

## Deploy (första gången)

1. script.google.com → Nytt projekt, döp det till "Pipeline bokning".
2. Projektinställningar: tidszon Europe/Stockholm, kryssa i "Visa manifestfilen appsscript.json i redigeraren".
3. Klistra in `appsscript.json`, `Code.gs`, `Calendar.gs` och `Availability.gs` (skapa filerna med + › Skript).
4. Tjänster (+) › Google Calendar API › v3 (identifierare `Calendar`) – manifestet innehåller redan posten, men kontrollera att den syns.
5. Kör `install()` en gång i redigeraren. Förväntat: "Google har inte verifierat den här appen" → Avancerat → Fortsätt. Godkänn Kalender, Drive, externa anrop, e-post och triggers. Byt **inte** till ett eget GCP-projekt.
6. Distribuera › Ny distribution › Webbapp: "Kör som: Jag", "Vem har åtkomst: **Alla**" (inte "Alla med Google-konto"). Kopiera URL:en som slutar på `/exec`.
7. Kontroll: öppna `<URL>?action=ping` i ett inkognitofönster – JSON ska visas (`ok:true`, `scriptVersion:1`), inte en inloggningssida.
8. Ge URL:en till Claude → `BOK_SCRIPT_URL` sätts i `index.html` och i sajtens `assets/js/bokning.js` (samma värde).

### Verifiera i redigeraren efter inklistring (en gång per deploy)

- `Logger.log(Session.getEffectiveUser().getEmail())` → CJ:s adress, **inte tom sträng**. Tom sträng = scopet `userinfo.email` saknas/är inte godkänt; då svarar all filhantering `E_SETUP` "Scriptet saknar behörighet userinfo.email".
- `Logger.log(Session.getScriptTimeZone())` → `Europe/Stockholm` (annars svarar allt `E_INTERNAL`).
- `Logger.log('Storgatan 1, Sverige!'.replace(/[^\p{L}\p{N}\s]/gu, ' '))` → `Storgatan 1  Sverige ` utan `SyntaxError` (Unicode property escapes i `normalizeAdressKey`, Availability.gs). Vid fel: byt regexen till `/[^a-z0-9åäöéü\s]/g` (strängen är redan i gemener).
- `runAvailabilityTests()` → "Alla N test OK" i loggen.
- `<URL>?action=ping` → `konfigurerad:true` när fil-id:n och `ADMIN_KEY` finns; `mapsVarning` tom när Maps-nyckeln är rätt begränsad.
- Med ICS: sätt `outlookIcsUrl` tillfälligt till en långsam https-endpoint, kör två `reserve` parallellt från konsolen – ingen ska ge `E_LOCK` (ICS hämtas före låset); loggradens `ms` för `reserve` ska ligga under ~5 s när ICS är cachad.

## Uppdatera scriptet (varje senare ändring)

Klistra in ny kod → Distribuera › **Hantera distributioner** → pennan → Version: **Ny version** → Distribuera.
**Aldrig "Ny distribution"** – det ger en ny URL och `BOK_SCRIPT_URL` skulle behöva ändras i både appen och sajten.
Höjs `SCRIPT_VERSION` i `Code.gs` ska `MIN_SCRIPT_VERSION` höjas i samma ordning: script (ny version) → sajten → appen.

## Manuell testuppsättning inför M3

M3:s `setup`-endpoint fyller fil-id:na automatiskt. Fram till dess kan scriptet testas så här:

1. **Drive-filer.** Skapa tre filer i "Min enhet" med exakt dessa namn och MIME-typ `application/json` (enklast via Google Drive API Explorer, eller ladda upp `.json`-filer – kontrollera att Drive visar dem som JSON och inte som "Text"). Minimalt innehåll enligt spec 4.1:
   - `telexia-bokning-config.json`:
     ```json
     { "schemaVersion": 1, "rev": 1, "updatedAt": "2026-09-15T09:00:00+02:00", "updatedBy": "app",
       "bokare": [ { "id": "bokare_test", "namn": "Test Testsson", "organisation": "TEST", "epost": "",
                     "pipelineId": "p_test", "tillatnaMotestypIds": [], "aktiv": true, "arCj": false,
                     "kodHash": "<sha256 hex av testkoden>" } ],
       "motestyper": [ { "id": "mt_test_fysiskt", "titel": "Testmöte", "langdMin": 60, "cooldownMin": 30, "restid": true,
                         "farg": "", "sannolikhet": 50, "pipelineId": "p_test", "global": false,
                         "bekraftelseMall": "Hej {kontakt}!\nVi ses {datum} kl {tid}–{slut} på {adress}.\n/{bokare}", "aktiv": true },
                       { "id": "mt_test_teams", "titel": "Test Teams", "langdMin": 60, "cooldownMin": 0, "restid": false,
                         "farg": "", "sannolikhet": 50, "pipelineId": "p_test", "global": false,
                         "bekraftelseMall": "Hej {kontakt}!\nVi ses {datum} kl {tid}–{slut}.\n/{bokare}", "aktiv": true } ],
       "formular": { "version": 1, "karna": { "kundnamn": { "synlig": true, "obligatorisk": true }, "orgnr": { "synlig": true, "obligatorisk": true },
                     "adress": { "synlig": true, "obligatorisk": false }, "kontaktperson": { "synlig": true, "obligatorisk": true },
                     "telefon": { "synlig": true, "obligatorisk": true }, "epost": { "synlig": true, "obligatorisk": false },
                     "notering": { "synlig": true, "obligatorisk": false } }, "extrafalt": [] },
       "installningar": { "version": 1, "kalendrar": [ { "id": "<kalender-id för testkalendern>", "namn": "Bokningar TEST", "lage": "fullt" } ],
                          "telexiaEpost": "", "notisEpost": "<CJ:s e-post>", "basadress": "", "basLat": null, "basLng": null },
       "ignorerade": [],
       "pipelines": [ { "id": "p_test", "name": "TEST", "color": "#3b82f6" } ] }
     ```
     Fält som saknas i `installningar` fylls av scriptet med samma defaults som appen (`DEFAULT_BOKNINGSINSTALLNINGAR`).
   - `telexia-bokning-inbox.json`: `{ "schemaVersion": 1, "rev": 0, "updatedAt": "", "updatedBy": "script", "bokningar": [] }`
   - `telexia-bokning-cache.json`: `{ "schemaVersion": 1, "rev": 0, "updatedAt": "", "updatedBy": "script", "geokod": {}, "restid": {}, "icsReserv": null }`
2. **Testbokare.** Välj en testkod på exakt 24 tecken ur `[A-Za-z0-9_-]` (t.ex. `TESTkod_0123456789abcdEF`). Räkna SHA-256 (hex, gemener) av koden – i webbläsarkonsolen: `crypto.subtle.digest('SHA-256', new TextEncoder().encode('TESTkod_0123456789abcdEF')).then(b => console.log([...new Uint8Array(b)].map(x => x.toString(16).padStart(2,'0')).join('')))` – och lägg in värdet som `kodHash`. Klartextkoden ska aldrig in i config-filen.
3. **Testkalender.** Skapa kalendern "Bokningar TEST" i Google Kalender (tidszon Stockholm), kopiera dess kalender-id (Inställningar › Integrera kalender) och lägg in det som `id` i `installningar.kalendrar` med `lage:"fullt"`. Sätt `telexiaEpost` tomt under test (ingen inbjudan skickas) eller till en egen testadress.
4. **Script Properties.** `CONFIG_FILE_ID`, `INBOX_FILE_ID`, `CACHE_FILE_ID` = filernas id (ur Drive-URL:en), `ADMIN_KEY` = valfri teststräng (används först i M3). Ev. `MAPS_API_KEY`.
5. **Prova.** `<URL>?action=ping` ska ge `konfigurerad:true`. Därefter från bokningssidan (`https://redneckengineering.se/bokning?k=<testkod>`) eller från en webbläsarkonsol:
   ```js
   fetch('<URL>', { method:'POST', headers:{ 'Content-Type':'text/plain;charset=utf-8' },
     body: JSON.stringify({ action:'hello', k:'TESTkod_0123456789abcdEF' }) }).then(r => r.json()).then(console.log)
   ```
   Kontrollera efter en testbokning: händelsen i "Bokningar TEST", posten i `telexia-bokning-inbox.json` (`rev` +1) och notismejlet till `notisEpost`. Töm inkorgsfilen och radera testhändelserna efteråt.
6. **Konfigändring under test.** Scriptet cachar config-filen i 10 minuter. Ändras filen manuellt: vänta, eller kör `clearConfigCache()` i redigeraren.

## Felkoder (kortform, spec 4.3)

`E_SETUP` (fil-id/adminnyckel saknas eller filkontroll misslyckas), `E_KEY` (okänd/inaktiv/felformaterad kod – alltid samma svar), `E_ADMIN`, `E_RATE` (`details.typ`: `anrop`, `reservation`, `bokningar`, `adresser`, `geocode`), `E_PAUSED`, `E_VALIDATION` (`details.falt`), `E_SLOT_TAKEN`, `E_RESERVATION_EXPIRED`, `E_NOT_FOUND`, `E_STATE`, `E_CALENDAR`, `E_LOCK`, `E_INTERNAL`, `E_NOT_IMPLEMENTED` (admin-endpoints i M2).

## Handlingsgränser (konstanter överst i `Code.gs`)

`MAX_RES_PER_KOD` 1 · `MAX_BOOK_PER_KOD_H` 5 · `MAX_BOOK_PER_KOD_D` 15 · `MAX_BOOK_GLOBAL_D` 40 · `MAX_GEOCODE_PER_KOD_H` 20 · `MAX_ADRESSER_PER_KOD_D` 20. Anropsgränser ~30/min och ~300/h per kod, okända koder 20 per 10 min, admin ~60/min.

## Loggning

Scriptet loggar en rad per anrop: `{ action, bokareId, ok, code, ms }` – aldrig indata, koder, nycklar eller kundfält. Vid okontrollerade fel (`E_INTERNAL`) läggs `fel` till: felets namn + en hårt avskalad text (e-postmönster ersatta med `<epost>`, bara ord/siffror/`:.-`, max 80 tecken) – aldrig hela meddelandet, eftersom Calendar/Drive kan eka fältvärden i sina fel. Loggarna finns under Körningar / Cloud Logging i 30 dagar.

## Lås (4.8)

`withScriptLock` (LockService, 10 s) hålls i `reserve`/`book`/`release` och vid `mejlfel`-historik. All nätverks-I/O (ICS-hämtning, Geocoding, Distance Matrix) görs **före** låset genom att geokoda adressen och köra dagsberäkningen utan färsk kalenderläsning (`warmSlotCaches`); under låset återstår `Calendar.Events.list` (färsk) + Drive-läsning/skrivning. `updateCacheFile` i Availability.gs tar **inget** lås – nästla aldrig `withScriptLock` (reentrans i LockService är inte dokumenterad).
