# Apps Script – brevlådan för bokningsmodulen

Scriptet är den enda komponent som läser CJ:s kalendrar och Outlook-ICS, räknar restid, tar emot bokningar,
skriver i kalendern "Bokningar" och i brevlådefilerna i Drive. Det körs som CJ ("Kör som: Jag") och nås
anonymt av bokningssidan och Pipeline-appen via `BOK_SCRIPT_URL`. Specifikationen är sanningen:
`02 Projects/Pipeline/[C] Bokningsmodul - specifikation steg 1.md` (avsnitt 4, 5 och 9).

## Filer

| Fil | Innehåll |
|---|---|
| `appsscript.json` | Manifest: tidszon Europe/Stockholm, V8, explicita OAuth-scopes (sex st: `drive`, `calendar`, `script.external_request`, `script.send_mail`, `script.scriptapp`, `userinfo.email` – den sista krävs för `Session.getEffectiveUser().getEmail()` i filkontrollen, spec 4.2), Calendar advanced service v3, webapp "kör som den som distribuerar" + åtkomst "Alla" (`ANYONE_ANONYMOUS`). Ändras scopes måste CJ godkänna om scriptet. |
| `Code.gs` | Kärnan: Script Properties, filhantering (exakt tre fil-id:n), `doPost`/`doGet` med JSON-kuvert och felkoder, autentisering (bokarkod via SHA-256, adminnyckel i konstant tid), anrops- och handlingsgränser, reservationer (CacheService), `book` med idempotens och kompenserande borttagning, kalenderskrivning, notismejl, `hello`/`ping`/`geocode`/`release`, admin-endpoints `setup`/`config-push`/`calendars-list`/`inbox-list`/`ack`/`reject` (M3) och `calendar-preview`/`rebook`/`cancel` (M4; se "Admin-endpoints" nedan), stub `purge` (`E_NOT_IMPLEMENTED` till M5), `install()` och `dailyMaintenance()`. |
| `Calendar.gs` | Kalenderläsning: `readBusy(fran, till)`, ICS-parser, `mergeBusy`, `applyIgnore`, `buildBusyList(from, to)` (ignorerade poster behålls med `ignorerad:true` – Kalenderkoll visar dem gråade; inkorgsposter får titeln `Bokning` utan kundnamn). |
| `Availability.gs` | Tillgänglighet och restid: `computeAvailability(req)`, `dayPlan`, `placeTravel`, `geocodeAddress(adress)`, restid via Distance Matrix med cache, svenska röda dagar. |

Alla tre `.gs`-filer klistras in i samma Apps Script-projekt (filnamn spelar ingen roll för Apps Script, men behåll dem för läsbarhet). Inga hemligheter finns i koden – Maps-nyckel, adminnyckel och fil-id:n ligger enbart i Script Properties.

## Script Properties (Projektinställningar › Script Properties)

| Nyckel | Sätts av | Betydelse |
|---|---|---|
| `ADMIN_KEY` | **CJ, för hand** – Anslut-guiden genererar nyckeln och visar den med "Kopiera"; klistra in här och klicka "Fortsätt" (spec 4.5, 10.1 steg 4b). Scriptet sätter aldrig nyckeln själv. | Adminnyckeln som appen skickar i admin-anrop, jämförs i konstant tid. Saknas den svarar alla admin-anrop (även `setup`) `E_SETUP` "Adminnyckel saknas i Script Properties". Rotation ("Ny nyckel" i appen): klistra in den nya nyckeln här och kör Anslut-guiden om. |
| `CONFIG_FILE_ID` | `setup` (Anslut-guiden) – manuellt bara som reserv | Drive-id för `telexia-bokning-config.json` (skrivs av appen, läses av scriptet, cache 10 min). |
| `INBOX_FILE_ID` | `setup` (Anslut-guiden) – manuellt bara som reserv | Drive-id för `telexia-bokning-inbox.json` (skrivs bara av scriptet, under lås). |
| `CACHE_FILE_ID` | `setup` (Anslut-guiden) – manuellt bara som reserv | Drive-id för `telexia-bokning-cache.json` (geokodning, restid, ICS-reserv). |
| `MAPS_API_KEY` | CJ (valfri) | Google Maps-nyckel. **API-begränsning:** bara Geocoding API och Distance Matrix API. **Applikationsbegränsning: Ingen** – referrer-/IP-begränsning fungerar inte från Apps Script (UrlFetchApp skickar ingen referrer och Googles IP-pool går inte att vitlista; resultatet blir `REQUEST_DENIED`, `ping.mapsVarning` "Nyckeln avvisad" och schablonrestid överallt). Saknas nyckeln → schablonrestid. |
| `MAPS_DAILY_CAP` | CJ (valfri) | Dagstak för Maps-element, default 1000. |
| `maps_elements_<YYYYMMDD>` | scriptet | Räknare för Maps-element per dag (gallras efter 7 dagar). |
| `book_count_<YYYYMMDD>` | scriptet | Global bokningsräknare per dag (`MAX_BOOK_GLOBAL_D`, gallras efter 7 dagar). |

Saknas något av de tre fil-id:na, eller misslyckas filkontrollen (filen i papperskorgen, fel namn, fel filtyp, annan ägare), svarar alla anrop som behöver filerna `E_SETUP`. `ping` svarar alltid: `konfigurerad:false` med `orsak` (t.ex. `"cache: Filen ligger i papperskorgen"`, `"Fil-id saknas i Script Properties: config, inbox, cache"`, `"Adminnyckel saknas i Script Properties"`) – `ping` kontrollerar alla tre filerna (namn, filtyp, ägare, papperskorg), inte bara att id:na finns; kontrollen är cachad 10 min per fil (ping är oautentiserat och får inte kunna driva Drive-kvoten), färsk kontroll görs i `setup`.

## Deploy (första gången)

1. script.google.com → Nytt projekt, döp det till "Pipeline bokning".
2. Projektinställningar: tidszon Europe/Stockholm, kryssa i "Visa manifestfilen appsscript.json i redigeraren".
3. Klistra in `appsscript.json`, `Code.gs`, `Calendar.gs` och `Availability.gs` (skapa filerna med + › Skript).
4. Tjänster (+) › Google Calendar API › v3 (identifierare `Calendar`) – manifestet innehåller redan posten, men kontrollera att den syns.
5. Kör `install()` en gång i redigeraren. Förväntat: "Google har inte verifierat den här appen" → Avancerat → Fortsätt. Godkänn Kalender, Drive, externa anrop, e-post och triggers. Byt **inte** till ett eget GCP-projekt.
6. Distribuera › Ny distribution › Webbapp: "Kör som: Jag", "Vem har åtkomst: **Alla**" (inte "Alla med Google-konto"). Kopiera URL:en som slutar på `/exec`.
7. Kontroll: öppna `<URL>?action=ping` i ett inkognitofönster – JSON ska visas (`ok:true`, `scriptVersion:1`), inte en inloggningssida.
8. Ge URL:en till Claude → `BOK_SCRIPT_URL` sätts i `index.html` och i sajtens `assets/js/bokning.js` (samma värde).
9. **Anslut brevlådan från appen** (Bokningar → Inställningar → Anslut brevlåda, spec 10.1 steg 4): appen kör `ping`, skapar de tre Drive-filerna i "Min enhet", genererar adminnyckeln och visar den – **klistra in den som `ADMIN_KEY` i Projektinställningar → Script Properties** och klicka "Fortsätt". Appen anropar då `setup` med fil-id:na: `setup` kräver att `ADMIN_KEY` finns och stämmer (annars `E_SETUP`/`E_ADMIN`), verifierar filerna (namn `telexia-bokning-*.json`, JSON, ägare = kontot scriptet körs som, inte i papperskorgen), sparar `CONFIG_FILE_ID`/`INBOX_FILE_ID`/`CACHE_FILE_ID`, seedar tomma filer, skapar triggern `dailyMaintenance` idempotent och svarar med `ownerEmail` + kalenderlistan. Det enda som klistras in för hand är `ADMIN_KEY` (och `MAPS_API_KEY` om Maps ska användas); fil-id:na sätter `setup`. Kontroll: `<URL>?action=ping` → `konfigurerad:true`, `orsak:""`.

### Verifiera i redigeraren efter inklistring (en gång per deploy)

- `Logger.log(Session.getEffectiveUser().getEmail())` → CJ:s adress, **inte tom sträng**. Tom sträng = scopet `userinfo.email` saknas/är inte godkänt; då svarar all filhantering `E_SETUP` "Scriptet saknar behörighet userinfo.email".
- `Logger.log(Session.getScriptTimeZone())` → `Europe/Stockholm` eller en zon med samma regler (Googles meny ger ofta `Europe/Berlin`; godtas av `tidszonOk()`). En zon med andra regler ger `E_INTERNAL` på alla anrop.
- `Logger.log('Storgatan 1, Sverige!'.replace(/[^\p{L}\p{N}\s]/gu, ' '))` → `Storgatan 1  Sverige ` utan `SyntaxError` (Unicode property escapes i `normalizeAdressKey`, Availability.gs). Vid fel: byt regexen till `/[^a-z0-9åäöéü\s]/g` (strängen är redan i gemener).
- `runAvailabilityTests()` → "Alla N test OK" i loggen.
- `<URL>?action=ping` → `konfigurerad:true` och `orsak:""` när Anslut-guiden körts (fil-id:n + `ADMIN_KEY` finns och alla tre filerna klarar kontrollen); `mapsVarning` tom när Maps-nyckeln är rätt begränsad.
- Med ICS: sätt `outlookIcsUrl` tillfälligt till en långsam https-endpoint, kör två `reserve` parallellt från konsolen – ingen ska ge `E_LOCK` (ICS hämtas före låset); loggradens `ms` för `reserve` ska ligga under ~5 s när ICS är cachad.

## Uppdatera scriptet (varje senare ändring)

Klistra in ny kod → Distribuera › **Hantera distributioner** → pennan → Version: **Ny version** → Distribuera.
**Aldrig "Ny distribution"** – det ger en ny URL och `BOK_SCRIPT_URL` skulle behöva ändras i både appen och sajten.
Höjs `SCRIPT_VERSION` i `Code.gs` ska `MIN_SCRIPT_VERSION` höjas i samma ordning: script (ny version) → sajten → appen.

## Admin-endpoints (M3/M4, spec 4.4) – anropas av appen med `adminKey`

Alla admin-anrop går genom `bokAdminApi(action, payload)` i `index.html` (adminnyckeln läggs på automatiskt), ~60 anrop/min, konstanttidsjämförelse. Svar i det vanliga kuvertet (`ok`, `data`, `scriptVersion`, `configRev`, `serverTime`).

| Action | Request (utöver `adminKey`) | `data` vid `ok:true` | Fel |
|---|---|---|---|
| `setup` | `{ fileIds:{ config, inbox, cache } }` (även `configFileId`/`inboxFileId`/`cacheFileId`) | `{ version, scriptVersion, konfigurerad:true, ownerEmail, kalendrar:[…] }` | `E_SETUP` "Adminnyckel saknas i Script Properties" (ingen `details.fil`) när `ADMIN_KEY` inte lagts in, `E_ADMIN` när nyckeln avviker, `E_VALIDATION` (`falt.config/inbox/cache/fileIds`), `E_SETUP` med `details.fil` (`'config'|'inbox'|'cache'`) |
| `config-push` | `{ rev }` | `{ ok:true, rev, configRev, varningar:[] }` – cachen töms och filen läses färskt | `E_STATE` med `details.configRev` när filens `rev` < begärd (spec 4.3/4.4; appen försöker om efter 2 s, max 3 ggr); nyare fil är ok |
| `calendars-list` | – | `{ kalendrar:[{ id, summary, namn, primary, primar, accessRole }] }` (primär först, sedan namn) | `E_CALENDAR` |
| `inbox-list` | `{ status?: 'ny' \| ['ny','importerad','avvisad','avbokad'], limit?: 1–500 }` | `{ bokningar:[…nyaste först], antal, totalt, rev }` (default 200) | `E_VALIDATION`, `E_SETUP` |
| `ack` | `{ enhetId, bokningIds:[…] }` (även `{ deviceId, bokningar:[{ bokningId, leadId, eventId, kundId, kontaktId, nyProcess, nyKund, mojligDubblett }] }` – planen sparas på posten) | `{ resultat:[{ bokningId, claimed, status, importeradAv, importeradTs, saknad?, plan? }], claimed:[id], alreadyClaimed:[{ bokningId, importeradAv, importeradTs, plan }], missing:[id] }` – under lås, `ny → importerad`, en inkorgsskrivning | `E_VALIDATION`, `E_LOCK` |
| `reject` | `{ bokningId, orsak? }` (orsak ≤ 500 tecken) | `{ ok:true, bokningId, status:'avvisad', kalenderBorttagen, kalenderFel, mejlSkickat, bokning }` – från `ny`/`importerad`; `Calendar.Events.remove` (`sendUpdates:'all'`, 404/410 = redan borta = ok; annat API-fel → status sätts ändå + historik `kalenderfel` + `kalenderFel:true` i svaret, enligt spec 4.7 – appen ska visa varningen; `mejlSkickat:false` när bokaren saknar giltig e-post); plain text-mejl till `bokare.epost` | `E_NOT_FOUND`, `E_STATE` (`details.status`), `E_VALIDATION`, `E_LOCK`, `E_SETUP` |
| `calendar-preview` | `{ from, to }` (`YYYY-MM-DD`, inklusive; även `{ fran, till }`), högst 8 veckor (56 dagar), inom `[idag−7, horisont+7]` | `{ from, to, idag, horisontTom, genererad, handelser:[…], icsStatus:{ ok, hamtadTs, antal, medPlats, preliminara }, obesvarade, varningar:[] }` – exakt det scriptet ser efter sammanslagning, ALLA källor (Google `tider`/`fullt`, Outlook-ICS, inkorgens bokningar, aktiva reservationer); ignorerade poster är MED (`ignorerad:true`), preliminära ICS-poster är med (`preliminar:true`, `raknad` enligt config); en händelse över midnatt ger ett segment per dag. Post: `{ id, ignoreraId, matchIds, kalla:'bokningar'\|'privat'\|'ics'\|'reservation', datum, start, slut, heldag, titel, plats, hasPlace, restid, cooldownMin, preliminar, raknad, ignorerad, bokningId, bokareId, motestypId, sammanslagenMed:[], varning, varningar:[] }` – `titel`/`plats` bara för läge `fullt`, ICS och reservationer (`'Reservation'`), **aldrig** för läge `tider` (`kalla:'privat'` → alltid `''`; `hasPlace`/`restid` bara boolska); inga kundnamn ur inkorgen (matcha på `bokningId`); `id` = intern busy-id (används i `sammanslagenMed`), `ignoreraId` = det id `KALENDER_IGNORERA` ska lagra (Google event-id / ICS UID / bokningens kalenderhändelse-id), `matchIds` = alla id:n posten matchas på. `varningar`: ICS-fel ("Outlook-flödet kunde inte läsas kl HH:MM"), "Många obesvarade Outlook-inbjudningar (N)", "Maps: …", "Kalenderhändelser som saknas i inkorgen: N" (4.11, CacheService `avstamning:saknas` – fylls av `dailyMaintenance` i M5; berörda poster får `varning:'saknas i inkorgen'`). "N avbokade/avvisade möten ligger kvar i kalendern – ta bort dem manuellt" (4.7: händelse vars `bokningId` är `avbokad`/`avvisad` i inkorgen, t.ex. efter misslyckad `Calendar.Events.remove`; posten får `varning:'Avbokad i inkorgen men händelsen finns kvar i kalendern – ta bort den manuellt'` resp. `Avvisad …`). `obesvarade` = antal preliminära i fönstret | `E_VALIDATION` (`falt.from/to`), `E_CALENDAR`, `E_SETUP` |
| `rebook` | `{ bokningId, start, adress?, reservationId?, motestypId?, orsak? }` – `start` = ISO med offset eller `{ datum, tid }`, samma regler som `book` (raster, öppen dag, framförhållning per mötestyp, horisont); `adress` = ny adress (typ med restid; utelämnad → befintlig); `motestypId` = bokningens egen (default) eller en aktiv typ bokaren får boka; `reservationId` undantas bara om reservationen tillhör bokningens bokare eller en CJ-bokare | `{ bokningId, start, slut, adress, geo, restid, motestypId, kalenderEventId, kalenderNyHandelse, rev, mejlSkickat, bokning }` – från `ny`/`importerad`; bokningens mötestyp tillåts även om den är inaktiv/inte längre i `tillatnaMotestypIds`; nätverks-I/O (ICS, geokodning, Distance Matrix) före låset; under lås: färsk kalenderläsning med `computeAvailability(undantaBokningId = bokningId)` → `E_SLOT_TAKEN`, `Calendar.Events.patch(start/end/location[/summary], sendUpdates:'all')` (händelsen borta, 404/410 → ny händelse skapas: `kalenderNyHandelse:true`, nytt id; annat fel → `E_CALENDAR`, inget ändrat), posten `start/slut/adress/geo/restid`, `rev+1`, `andradAt`, historik `{ typ:'ombokad', av:'cj', fran, till[, orsak, motestypFran] }` – **status oförändrad** (appen speglar via `rev > bokningRev`, 8.3); misslyckas inkorgsskrivningen flyttas händelsen tillbaka (best effort) → `E_INTERNAL`; busy-cachen töms för gamla och nya dagen; plain text-mejl till `bokare.epost` med gammal och ny tid | `E_NOT_FOUND`, `E_STATE` (`details.status`), `E_SLOT_TAKEN`, `E_VALIDATION` (`falt.bokningId/start/adress/orsak/motestypId`), `E_CALENDAR`, `E_LOCK`, `E_SETUP` |
| `cancel` | `{ bokningId, orsak? }` (orsak ≤ 500 tecken; även `{ kalenderEventId, orsak? }` utan `bokningId` – spec 4.4: avbokning efter gallring; finns ingen inkorgspost med det händelse-id:t tas bara kalenderhändelsen bort, `postSaknas:true`) | `{ ok:true, bokningId, status:'avbokad', kalenderBorttagen, kalenderFel, mejlSkickat, rev, postSaknas, bokning }` – från `ny`/`importerad`; under lås: `Calendar.Events.remove` (`sendUpdates:'all'`, 404/410 = redan borta = ok; annat fel → status sätts ändå + historik `kalenderfel` + `kalenderFel:true`, 4.7), status `avbokad`, `avbokadTs`/`avbokadOrsak`/`andradAt`, historik `{ typ:'avbokad', av:'cj', orsak }`, inkorgen skrivs (`rev+1`), busy-cachen töms – posten raderas aldrig (8.3); plain text-mejl till `bokare.epost` | `E_NOT_FOUND`, `E_STATE` (`details.status`, t.ex. redan `avbokad`/`avvisad`), `E_VALIDATION`, `E_LOCK`, `E_SETUP` |
| `purge` | – | – | `E_NOT_IMPLEMENTED` (M5) |

## Manuell reservrutin (bara om Anslut-guiden inte kan köras)

Anslut-guiden i appen gör allt nedan automatiskt via `setup`. Rutinen finns kvar som reserv för test direkt mot scriptet:

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
4. **Script Properties.** `CONFIG_FILE_ID`, `INBOX_FILE_ID`, `CACHE_FILE_ID` = filernas id (ur Drive-URL:en), `ADMIN_KEY` = en teststräng (t.ex. 32+ tecken `[A-Za-z0-9_-]`). Ev. `MAPS_API_KEY`. (Alternativ: sätt bara `ADMIN_KEY` och anropa `setup` med fil-id:na – då verifieras filerna och triggern skapas på samma gång; utan `ADMIN_KEY` svarar `setup` `E_SETUP`.)
5. **Prova.** `<URL>?action=ping` ska ge `konfigurerad:true`. Därefter från bokningssidan (`https://redneckengineering.se/bokning?k=<testkod>`) eller från en webbläsarkonsol:
   ```js
   fetch('<URL>', { method:'POST', headers:{ 'Content-Type':'text/plain;charset=utf-8' },
     body: JSON.stringify({ action:'hello', k:'TESTkod_0123456789abcdEF' }) }).then(r => r.json()).then(console.log)
   ```
   Kontrollera efter en testbokning: händelsen i "Bokningar TEST", posten i `telexia-bokning-inbox.json` (`rev` +1) och notismejlet till `notisEpost`. Töm inkorgsfilen och radera testhändelserna efteråt.
6. **Konfigändring under test.** Scriptet cachar config-filen i 10 minuter. Ändras filen manuellt: vänta, eller kör `clearConfigCache()` i redigeraren.

## Felkoder (kortform, spec 4.3)

`E_SETUP` (fil-id/adminnyckel saknas eller filkontroll misslyckas; `details.fil` från `setup`), `E_KEY` (okänd/inaktiv/felformaterad kod – alltid samma svar), `E_ADMIN`, `E_RATE` (`details.typ`: `anrop`, `reservation`, `bokningar`, `adresser`, `geocode`), `E_PAUSED`, `E_VALIDATION` (`details.falt`; okänt extrafält rapporteras som `falt.extrafalt` – fältets id ekas aldrig), `E_SLOT_TAKEN`, `E_RESERVATION_EXPIRED`, `E_NOT_FOUND`, `E_STATE` (`details.status`; från `config-push` i stället `details.configRev` när filens rev är äldre än begärd), `E_CALENDAR`, `E_LOCK`, `E_INTERNAL`, `E_NOT_IMPLEMENTED` (`purge` till M5).

## Handlingsgränser (konstanter överst i `Code.gs`)

`MAX_RES_PER_KOD` 1 · `MAX_BOOK_PER_KOD_H` 5 · `MAX_BOOK_PER_KOD_D` 15 · `MAX_BOOK_GLOBAL_D` 40 · `MAX_GEOCODE_PER_KOD_H` 20 · `MAX_ADRESSER_PER_KOD_D` 20. Anropsgränser ~30/min och ~300/h per kod, okända koder 20 per 10 min, admin ~60/min.

## Loggning

Scriptet loggar en rad per anrop: `{ action, bokareId, ok, code, ms }` – aldrig indata, koder, nycklar eller kundfält. Vid okontrollerade fel (`E_INTERNAL`) läggs `fel` till: felets namn + en hårt avskalad text (e-postmönster ersatta med `<epost>`, bara ord/siffror/`:.-`, max 80 tecken) – aldrig hela meddelandet, eftersom Calendar/Drive kan eka fältvärden i sina fel. Loggarna finns under Körningar / Cloud Logging i 30 dagar.

## Lås (4.8)

`withScriptLock` (LockService, 10 s) hålls i `reserve`/`book`/`release`/`ack`/`reject`/`rebook`/`cancel`, i `setup` (seedning av tomma filer) och vid `mejlfel`-historik. `calendar-preview` tar inget lås (bara läsning, `busy:<datum>`-cache 60 s). All nätverks-I/O (ICS-hämtning, Geocoding, Distance Matrix) görs **före** låset genom att läsa ICS uttryckligen, geokoda adressen och köra dagsberäkningen utan färsk kalenderläsning (`warmSlotCaches`); ICS-resultatet memoiseras per körning (`KAL_ICS_MEMO`, nollställs i `doPost`) så att den färska läsningen under låset aldrig gör `UrlFetchApp` – även när flödet är > 90 KB och inte ryms i CacheService. Under låset återstår `Calendar.Events.list` (färsk) + Drive-läsning/skrivning; `book` och `rebook` läser inkorgsfilen exakt en gång under låset (samma objekt skickas vidare till `computeAvailability`/`buildBusyList`). `icsReserv` i cache-filen skrivs högst var 15:e minut. `updateCacheFile` i Availability.gs tar **inget** lås – nästla aldrig `withScriptLock` (reentrans i LockService är inte dokumenterad).
