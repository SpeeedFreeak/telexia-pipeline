/**
 * Pipeline by Redneck Engineering – bokningsmodul, Apps Script-kärna (Code.gs).
 *
 * Milstolpe M5. Specifikation: "[C] Bokningsmodul - specifikation steg 1.md", avsnitt 4 (brevlåda, transport,
 * endpoints, säkerhet), 5 (tillgänglighet – anropas i Availability.gs) och 9 (säkerhet/GDPR).
 *
 * Projektet består av tre filer:
 *   Code.gs          – denna fil: Script Properties, filhantering, doPost/doGet, autentisering, gränser,
 *                      reservation, book, kalenderskrivning, notismejl, hello/ping/geocode/release,
 *                      admin-endpoints setup/config-push/calendars-list/inbox-list/ack/reject (M3),
 *                      calendar-preview/rebook/cancel (M4), purge + dailyMaintenance på riktigt (M5).
 *   Calendar.gs      – readBusy(fran, till), parseIcs, mergeBusy, applyIgnore, buildBusyList(from, to).
 *   Availability.gs  – computeAvailability(req), dayPlan, placeTravel, geocodeAddress(adress), travelMinutes,
 *                      swedishHolidays.
 *
 * Regler som gäller hela filen (spec 4.1, 4.3, 9):
 *   - Inga hemligheter i koden. MAPS_API_KEY, ADMIN_KEY och fil-id:n finns bara i Script Properties.
 *   - Inga Drive-anrop utöver DriveApp.getFileById(<de tre id:na>) + getBlob/setContent/getName/getMimeType/getOwner/isTrashed.
 *   - Loggning bara via den strukturerade raden i doPost: aldrig indata, koder, nycklar eller kund-/kontaktfält.
 *   - Alla svar är JSON-kuvert (ContentService) – även vid okontrollerade fel (yttersta try/catch i doPost).
 *   - Allt som skrivs till kalender/mejl får < och > strippade; mejl är alltid plain text.
 */

// ============================================================
// Konstanter
// ============================================================

const SCRIPT_VERSION = 3;                       // MIN_SCRIPT_VERSION i index.html/bokning.js jämförs mot denna (4.12); 3 = M5 (purge, dailyMaintenance, nya ping-fält)
const TZ = 'Europe/Stockholm';
const APP_URL = 'https://speeedfreeak.github.io/telexia-pipeline/';   // länk i notismejlet (4.9)
const MAX_BODY_BYTES = 16384;                   // body kontrolleras före JSON.parse (4.3)
const LOCK_WAIT_MS = 10000;                     // LockService – timeout → E_LOCK (4.8)

const KOD_RE = /^[A-Za-z0-9_-]{24}$/;           // bokarkod (4.5)
const CLIENT_BOKNING_ID_RE = /^[0-9a-f-]{36}$/; // idempotensnyckel från bokningssidan (4.4)
const BOKNING_ID_RE = /^[0-9a-f-]{36}$/;
const KUND_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;     // extrafalt._kundId (CJ-bokare, A27)
const FIL_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;     // Drive-fil-id (setup/Script Properties) – bara teckenklass, ingen längdgissning
const ENHET_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;    // enhetId i ack (appens telexia_pipeline_device_v1)
const PLAN_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;     // id:n i ack-planen (leadId/eventId/kundId/kontaktId)
const INBOX_STATUSAR = ['ny', 'importerad', 'avvisad', 'avbokad'];
const INBOX_LIST_DEFAULT = 200;
const INBOX_LIST_MAX = 500;
const ACK_MAX_IDS = 200;
const ORSAK_MAX = 500;                          // reject/cancel/rebook-orsak (mejlas till bokaren)
const PREVIEW_MAX_DAGAR = 56;                   // calendar-preview: högst 8 veckor per förfrågan (M4)
const AVSTAMNING_CACHE_KEY = 'avstamning:saknas'; // CacheService (≤ 6 h): JSON-lista av bokningId som saknas i inkorgen (4.11) – läses även av calendar-preview
const AVSTAMNING_PROP = 'avstamning_saknas';      // Script Property { ts, ids } – dailyMaintenance skriver, calendar-preview läser (24 h-fönstret, A48)
const AVSTAMNING_GILTIG_MS = 36 * 3600000;        // avstämningens varning gäller tills nästa körning; efter 36 h utan körning tystnar den
const AVSTAMNING_MAX_IDS = 100;
const MAINT_PROP_SENAST = 'maintenance_senast';   // ISO för senaste lyckade dailyMaintenance (ping.underhallSenast, sanity check V1)
const PURGE_MAX_IDS = 100;                        // purge: högst 100 bokningId + 100 kalenderEventId per anrop
const PURGE_MAX_ADRESSER = 20;                    // purge: högst 20 adresser per anrop (M5-brief; kundradering behöver 1–3)
const PURGE_ANONYM_TITEL = 'Möte (borttaget)';    // A19: titel på anonymiserad passerad händelse – räknas aldrig som föräldralös igen
const PURGE_EVENT_ID_RE = /^[A-Za-z0-9_@.-]{1,256}$/;  // Google event-id (base32hex, ev. _<ts> för instanser)
const GALLRING_IMPORTERAD_DAGAR = 30;             // 4.11: importerad/avvisad/avbokad – 30 dagar efter import/ändring OCH mötet passerat
const GALLRING_NY_DAGAR = 90;                     // 4.11: ny – 90 dagar efter mötets slut ("gallrad utan import")
const GALLRING_CACHE_DAGAR = 180;                 // 4.11: geokod-/restidsposter äldre än 180 dagar
const GALLRING_GEOKOD_GALLRAD_DAGAR = 90;         // 4.11: geokodpost vars adress hör till en gallrad bokning – efter 90 dagar
const MAINT_LOCK_WAIT_MS = 20000;                 // 4.8: triggern väntar 20 s på låset
const EPOST_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DATUM_RE = /^\d{4}-\d{2}-\d{2}$/;
const ISO_START_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/;

// Handlingsgränser (4.5) – skyddar kalendern och CJ, inte bara scriptet. Listas i Inställningar › Script.
const MAX_RES_PER_KOD = 1;          // nytt reserve släpper föregående reservation
const MAX_BOOK_PER_KOD_H = 5;       // E_RATE typ 'bokningar'
const MAX_BOOK_PER_KOD_D = 15;      // dito per dag
const MAX_BOOK_GLOBAL_D = 40;       // dito globalt per dag (Script Property book_count_<YYYYMMDD>)
const MAX_GEOCODE_PER_KOD_H = 20;   // E_RATE typ 'geocode' (bara nya adresser räknas, aldrig cache-träffar)
const MAX_ADRESSER_PER_KOD_D = 20;  // unika adresser per kod och dag, E_RATE typ 'adresser'

// Anropsgränser (4.5) – ungefärliga, CacheService utan lås.
const RL_PER_MIN = 30;
const RL_PER_H = 300;
const RL_BAD_PER_10MIN = 20;        // okända koder: över 20 träffar svarar alla okända koder E_RATE i 10 min
const RL_ADMIN_PER_MIN = 60;
const RL_PING_PER_MIN = 60;         // ping är oautentiserat och läser Drive – enkel spärr

// TTL i CacheService (sekunder). Max är 21 600 (6 h).
const CONFIG_CACHE_S = 600;
const SETUP_CACHE_S = 600;
const RES_TTL_S = 300;              // reservation 5 min (4.8)
const TTL_H_S = 3900;
const TTL_D_S = 21600;
const CACHE_MAX_BYTES = 95000;      // CacheService tar max 100 KB per värde – större hoppas över

// Script Properties (4.2)
const PROP = {
  ADMIN_KEY: 'ADMIN_KEY',
  CONFIG_FILE_ID: 'CONFIG_FILE_ID',
  INBOX_FILE_ID: 'INBOX_FILE_ID',
  CACHE_FILE_ID: 'CACHE_FILE_ID',
  MAPS_API_KEY: 'MAPS_API_KEY',
  MAPS_DAILY_CAP: 'MAPS_DAILY_CAP'
};
const MAPS_DAILY_CAP_DEFAULT = 1000;

// Maxlängder (3.5) – samma som bokningssidans maxlength och importens klippning.
const MAXLEN = { kundnamn: 120, orgnr: 13, adress: 200, kontaktperson: 120, telefon: 30, epost: 120, notering: 2000, kort: 200, fritext: 2000 };

// Statiska feltexter per felkod (4.3). E_VALIDATION-texter ekar aldrig indata.
const FEL_TEXT = {
  E_SETUP: 'Bokningsmodulen är inte färdiginstallerad',
  E_KEY: 'Koden är ogiltig eller avstängd',
  E_ADMIN: 'Fel adminnyckel',
  E_RATE: 'För många försök – vänta en stund',
  E_PAUSED: 'Bokningar är pausade',
  E_VALIDATION: 'Ogiltiga uppgifter',
  E_SLOT_TAKEN: 'Tiden hann bli upptagen. Välj en ny tid.',
  E_RESERVATION_EXPIRED: 'Reservationen har gått ut och tiden är tagen. Välj en ny tid.',
  E_NOT_FOUND: 'Bokningen finns inte',
  E_STATE: 'Otillåten ändring',
  E_CALENDAR: 'Kalendern kunde inte uppdateras – inget har bokats',
  E_LOCK: 'Tjänsten är upptagen – försök igen',
  E_INTERNAL: 'Internt fel i tjänsten',
  E_NOT_IMPLEMENTED: 'Funktionen är inte tillgänglig i den här versionen'
};

// ============================================================
// Defaults – ORDAGRANNA kopior av index.html (spec 3.5). Config-filen fylls på med dessa fält för fält
// så att scriptet tål en äldre eller ofullständig config.
// ============================================================

const DEFAULT_BOKNINGSFORMULAR = {
  version: 1,
  karna: {
    kundnamn: { synlig: true, obligatorisk: true }, orgnr: { synlig: true, obligatorisk: true },
    adress: { synlig: true, obligatorisk: false }, kontaktperson: { synlig: true, obligatorisk: true },
    telefon: { synlig: true, obligatorisk: true }, epost: { synlig: true, obligatorisk: false },
    notering: { synlig: true, obligatorisk: false }
  },
  extrafalt: []
};

const DEFAULT_BOKNINGSINSTALLNINGAR = {
  version: 1,
  adminNyckel: '', brevladaFiler: { config: '', inbox: '', cache: '' },
  senastSyncTs: '', senastSyncRev: 0, senasteKonfigAndringTs: '',
  bokningSidaUrl: 'https://redneckengineering.se/bokning',
  arbetstider: { '1': { start: '08:00', slut: '17:00' }, '2': { start: '08:00', slut: '17:00' }, '3': { start: '08:00', slut: '17:00' },
                 '4': { start: '08:00', slut: '17:00' }, '5': { start: '08:00', slut: '17:00' }, '6': null, '0': null },
  lunch: { start: '12:00', slut: '13:00' },
  basadress: '', basLat: null, basLng: null, restidTillForsta: true, restidEfterSista: true,
  framforhallningFysiskDagar: 2, framforhallningTeamsDagar: 1, horisontVeckor: 6,
  startintervallMin: 30, maxFysiskaPerDag: 3, maxEnkelResaMin: 90,
  schablonRestidMin: 45, marginalMinstMin: 15, marginalProcent: 25,
  rodaDagar: true, rodaDagarExtra: [], rodaDagarUndantag: [],
  paus: { aktiv: false, tom: '', meddelande: '' },
  // Tom tills Anslut-guiden (M3, calendars-list) fyller listan – inga kalender-id:n/e-postadresser i källkoden (publikt repo).
  kalendrar: [],
  outlookIcsUrl: '', raknaPreliminaraOutlook: false,
  telexiaEpost: '', notisEpost: '', kontaktuppgifterIKalender: false,
  integritetstext: 'Uppgifterna lagras av Redneck Engineering för att genomföra det bokade mötet och raderas ur bokningssystemet 30 dagar efter mötet. Frågor: {notisEpost}',
  kontaktTextBokare: 'Blev något fel? Mejla CJ på {notisEpost} och ange bokningsnumret {bokningId}.',
  gallringDagar: 30
};

function isPlainObject(v) { return !!v && typeof v === 'object' && !Array.isArray(v); }
function deepClone(v) { return v === undefined ? undefined : JSON.parse(JSON.stringify(v)); }
// Djup default-fyllning fält för fält: befintliga värden behålls, saknade fält tas från def (idempotent).
// Rekurserar bara när både sparat värde och default är plain objects – ett sparat null (t.ex. arbetstider['1'] = stängd dag,
// spec 3.5) eller annan typ lämnas orört.
function fillDefaults(obj, def) {
  if (!isPlainObject(obj)) obj = {};
  Object.keys(def).forEach(k => {
    if (obj[k] === undefined) obj[k] = deepClone(def[k]);
    else if (isPlainObject(def[k]) && isPlainObject(obj[k])) fillDefaults(obj[k], def[k]);
  });
  return obj;
}

// ============================================================
// Orgnr och normalisering – ORDAGRANNA kopior av index.html (spec 3.3)
// ============================================================

function luhnOk(d) {                  // svenska orgnr/personnummer: 10 siffror, kontrollsiffra sist
  let s = 0;
  for (let i = 0; i < d.length; i++) { let n = +d[i]; if ((d.length - i) % 2 === 0) { n *= 2; if (n > 9) n -= 9; } s += n; }
  return s % 10 === 0;
}
function normalizeOrgnr(s) {          // '5560160680', '556016-0680', '165560160680' → '556016-0680'; ogiltigt/fel kontrollsiffra → ''
  let d = String(s || '').replace(/\D/g, '');
  if (d.length === 12 && d.startsWith('16')) d = d.slice(2);
  if (d.length !== 10 || !luhnOk(d)) return '';
  return d.slice(0, 6) + '-' + d.slice(6);
}
function normalizePhone(s) { let d = String(s || '').replace(/\D/g, ''); if (d.startsWith('0046')) d = d.slice(4); if (d.startsWith('46')) d = '0' + d.slice(2); return d; }
function normalizeEmail(s) { return String(s || '').trim().toLowerCase(); }

// ============================================================
// Tidshjälp (Europe/Stockholm) – portad från index.html (spec 3.4, 5.9). Samma namn och returformat som i appen.
// tzParts använder Utilities.formatDate (Apps Scripts garanterade tidszonsformatering) i stället för Intl;
// utdata är identisk: { datum:'YYYY-MM-DD', tid:'HH:MM' }.
// ============================================================

const APP_TZ = TZ;
const SV_WEEKDAYS = ['Söndag','Måndag','Tisdag','Onsdag','Torsdag','Fredag','Lördag'];
const SV_MONTHS = ['januari','februari','mars','april','maj','juni','juli','augusti','september','oktober','november','december'];

// Memoisering per körning (varje request är en ny V8-kontext): Utilities.formatDate går över Java-bryggan (~1–3 ms)
// och anropas per slot/dag-segment/ICS-instans. Nycklar: d.getTime() resp. lokal väggtid (offset beror bara på den).
const TZ_PARTS_CACHE = new Map();
const TZ_OFFSET_CACHE = new Map();
// Snabbväg (M5, A47): Stockholms offset räknas i ren JS enligt EU-regeln (sommartid från sista söndagen i mars 01:00 UTC till
// sista söndagen i oktober 01:00 UTC; +02:00 resp. +01:00). Aktiveras först när tzSnabbOk_() verifierat mot Utilities.formatDate
// att scriptets zon ger exakt samma väggtid för sex kontrollinstanter (vinter, sommar, båda omställningarna) – annars används
// Java-bryggan som förut. Sparar ~1 ms per unik tidpunkt: ett ICS-flöde med hundratals händelser och serier ger tusentals anrop.
let TZ_SNABB = null;
function tzSistaSondagUtcMs_(ar, manad) {          // sista söndagen i månaden (0-baserad) kl 00:00 UTC
  const sista = new Date(Date.UTC(ar, manad + 1, 0));
  return sista.getTime() - sista.getUTCDay() * 86400000;
}
function tzStockholmOffsetMin_(ms) {
  const ar = new Date(ms).getUTCFullYear();
  const start = tzSistaSondagUtcMs_(ar, 2) + 3600000, slut = tzSistaSondagUtcMs_(ar, 9) + 3600000;
  return ms >= start && ms < slut ? 120 : 60;
}
function tzPartsJs_(d) {
  const s = new Date(d.getTime() + tzStockholmOffsetMin_(d.getTime()) * 60000).toISOString();
  return { datum: s.slice(0, 10), tid: s.slice(11, 16) };
}
function tzSnabbOk_() {
  if (TZ_SNABB !== null) return TZ_SNABB;
  try {
    const prov = [Date.UTC(2026, 0, 15, 12), Date.UTC(2026, 6, 15, 12), Date.UTC(2026, 2, 29, 0, 30), Date.UTC(2026, 2, 29, 1, 30), Date.UTC(2026, 9, 25, 0, 30), Date.UTC(2026, 9, 25, 1, 30)];
    TZ_SNABB = prov.every(ms => { const d = new Date(ms), p = tzPartsJs_(d); return Utilities.formatDate(d, APP_TZ, 'yyyy-MM-dd HH:mm') === p.datum + ' ' + p.tid; });
  } catch (e) { TZ_SNABB = false; }
  return TZ_SNABB;
}
function tzParts(d) {
  // Ogiltigt Date (t.ex. trasig ISO-sträng i en inkorgspost) ger tomma fält i stället för Java-undantag → E_INTERNAL.
  if (!(d instanceof Date) || isNaN(d.getTime())) return { datum: '', tid: '' };
  const k = d.getTime();
  let p = TZ_PARTS_CACHE.get(k);
  if (!p) {
    if (tzSnabbOk_()) p = tzPartsJs_(d);
    else { const s = Utilities.formatDate(d, APP_TZ, 'yyyy-MM-dd HH:mm'); p = { datum: s.slice(0, 10), tid: s.slice(11, 16) }; }
    TZ_PARTS_CACHE.set(k, p);
  }
  return { datum: p.datum, tid: p.tid };
}
function todayStr() { return tzParts(new Date()).datum; }
function nowTimeStr() { return tzParts(new Date()).tid; }
function addDays(dateStr, n) { const d = new Date(dateStr + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
function weekdayOf(dateStr) { return new Date(dateStr + 'T12:00:00Z').getUTCDay(); }   // 0 = söndag
function tzOffsetMinutes(dateStr, tid) {
  const k = dateStr + 'T' + tid;
  const hit = TZ_OFFSET_CACHE.get(k);
  if (hit !== undefined) return hit;
  const guess = new Date(`${dateStr}T${tid}:00Z`);
  const p = tzParts(guess);
  const asUtc = Date.UTC(+p.datum.slice(0,4), +p.datum.slice(5,7)-1, +p.datum.slice(8,10), +p.tid.slice(0,2), +p.tid.slice(3,5));
  const off = Math.round((asUtc - guess.getTime()) / 60000);
  TZ_OFFSET_CACHE.set(k, off);
  return off;
}
function toIsoWithOffset(dateStr, tid) {
  const off = tzOffsetMinutes(dateStr, tid), s = off < 0 ? '-' : '+', a = Math.abs(off);
  return `${dateStr}T${tid}:00${s}${String(Math.floor(a/60)).padStart(2,'0')}:${String(a%60).padStart(2,'0')}`;
}
function fromIso(iso) { return tzParts(new Date(iso)); }
function longDateLabel(dateStr) {   // 'torsdag 24 september 2026'
  const d = new Date(dateStr + 'T12:00:00Z');
  return `${SV_WEEKDAYS[d.getUTCDay()]} ${d.getUTCDate()} ${SV_MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`.toLowerCase();
}
function isoWithOffset(d) { return Utilities.formatDate(d, TZ, "yyyy-MM-dd'T'HH:mm:ssXXX"); }   // 5.9
function nowIso() { return isoWithOffset(new Date()); }
function tidToMin(tid) { const m = /^(\d{2}):(\d{2})$/.exec(String(tid || '')); return m ? (+m[1]) * 60 + (+m[2]) : NaN; }
function minToTid(min) { const m = Math.max(0, Math.min(1439, min)); return String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0'); }
function daysBetween(a, b) { return Math.round((new Date(b + 'T12:00:00Z').getTime() - new Date(a + 'T12:00:00Z').getTime()) / 86400000); }
function ymdCompact(dateStr) { return String(dateStr || '').replace(/-/g, ''); }
function horisontTomDatum(inst) { return addDays(todayStr(), (Number(inst.horisontVeckor) || 6) * 7); }   // = sistaDag i 5.12

// ============================================================
// Fel och kuvert (4.3)
// ============================================================

class ApiError extends Error {
  constructor(code, message, details) {
    super(message || FEL_TEXT[code] || code);
    this.name = 'ApiError';
    this.code = code;
    this.details = details || {};
  }
}
function apiError(code, message, details) { return new ApiError(code, message, details); }
function fel(code, message, details) { throw apiError(code, message, details); }
function valideringsfel(falt) { throw apiError('E_VALIDATION', undefined, { falt: falt }); }

// Tolkar fel från alla filer: ApiError, objekt med code 'E_*' eller Error vars message börjar med 'E_*'.
function errorCode(err) {
  if (!err) return '';
  if (err instanceof ApiError) return err.code;
  if (typeof err.code === 'string' && /^E_[A-Z_]+$/.test(err.code)) return err.code;
  const m = /^(E_[A-Z_]+)/.exec(String(err.message || ''));
  return m ? m[1] : '';
}

function respond(obj) { return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON); }
function okEnvelope(data, ctx) {
  return { ok: true, data: data === undefined ? {} : data, scriptVersion: SCRIPT_VERSION, configRev: ctx && ctx.configRev !== undefined ? ctx.configRev : null, serverTime: nowIso() };
}
function errEnvelope(code, message, details) {
  return { ok: false, error: { code: code, message: message || FEL_TEXT[code] || code, details: isPlainObject(details) ? details : {} } };
}

// ============================================================
// Inträde: doPost / doGet (4.3). Yttersta try/catch svarar alltid JSON.
// ============================================================

function doPost(e) {
  try { return doPostInner_(e); }
  finally { if (typeof availFlushGeokod_ === 'function') availFlushGeokod_(); }   // körningens nya geokodposter → cache-filen, en skrivning (A51)
}
function doPostInner_(e) {
  const t0 = Date.now(); let action = '?', bokareId = '';
  try {
    if (typeof kalResetMemo_ === 'function') kalResetMemo_();   // per-anrop-memo (ICS) – varje request är en ny körning
    if (typeof availResetMemo_ === 'function') availResetMemo_();   // per-anrop-memo (cache-filen, A51)

    if (!e || !e.postData || typeof e.postData.contents !== 'string' || e.postData.contents.length > MAX_BODY_BYTES)
      return respond(errEnvelope('E_VALIDATION', 'Ogiltig eller för stor förfrågan'));
    let req = null;
    try { req = JSON.parse(e.postData.contents); } catch (pe) { req = null; }
    if (!isPlainObject(req)) return respond(errEnvelope('E_VALIDATION', 'Ogiltig eller för stor förfrågan'));
    action = String(req.action || '');
    const out = route(req, ctx => { bokareId = ctx.bokareId || ''; });
    console.log(JSON.stringify({ action, bokareId, ok: out.ok, code: out.ok ? '' : out.error.code, ms: Date.now() - t0 }));
    return respond(out);
  } catch (err) {
    console.error(JSON.stringify({ action, bokareId, ok: false, code: 'E_INTERNAL', ms: Date.now() - t0, fel: felKlass(err) }));
    return respond(errEnvelope('E_INTERNAL'));
  }
}
// Klassificering av okontrollerade fel för loggraden (4.3/9: loggen får aldrig innehålla kund-/kontaktfält).
// Calendar/Drive ekar ibland fältvärden (e-post, filnamn) i felmeddelandet – därför bara namn + en hårt
// avskalad text (e-postmönster ersatta, bara ord/siffror/:.-, max 80 tecken). Fullständig stack finns i
// Körningar-vyn i redigeraren (exceptionLogging STACKDRIVER) – ingen extra loggning här.
function felKlass(err) {
  const namn = String(err && err.name || 'Error').slice(0, 40);
  const text = String(err && err.message || '').replace(/\S+@\S+/g, '<epost>').replace(/[^\w\s:.\-<>åäöÅÄÖ]/g, '').replace(/\s+/g, ' ').trim().slice(0, 80);
  return namn + (text ? ': ' + text : '');
}

// doGet svarar bara på ?action=ping (4.3) – går genom doPost så att loggraden är gemensam.
function doGet(e) {
  const action = e && e.parameter ? String(e.parameter.action || '') : '';
  if (action !== 'ping') return respond(errEnvelope('E_VALIDATION', 'Okänd åtgärd', { falt: { action: 'Bara ping via GET' } }));
  return doPost({ postData: { contents: JSON.stringify({ action: 'ping' }) } });
}

// Tidszonskontroll (5.9): Googles inställningsmeny kan ge t.ex. Europe/Berlin även när Stockholm väljs.
// Godta varje tidszon med samma vinter- och sommartid som Stockholm (offset jämförs för januari och juli).
function tidszonOk() {
  const tz = Session.getScriptTimeZone();
  if (tz === TZ) return true;
  try {
    const prov = [new Date(Date.UTC(2026, 0, 15, 12)), new Date(Date.UTC(2026, 6, 15, 12))];
    return prov.every(d => Utilities.formatDate(d, tz, 'XXX') === Utilities.formatDate(d, TZ, 'XXX'));
  } catch (e) { return false; }
}

// Routing: kör handlern, översätter kända fel till kuvert. Okända fel bubblar till doPost (E_INTERNAL).
function route(req, setCtx) {
  const ctx = { action: String(req.action || ''), bokareId: '', kodKey: '', configRev: null };
  try {
    if (!tidszonOk()) throw new Error('Scriptets tidszon (' + Session.getScriptTimeZone() + ') har andra regler än ' + TZ + ' – sätt den i Projektinställningar');
    const handler = Object.prototype.hasOwnProperty.call(HANDLERS, ctx.action) ? HANDLERS[ctx.action] : null;
    if (!handler) return errEnvelope('E_VALIDATION', 'Okänd åtgärd', { falt: { action: 'Okänd åtgärd' } });
    const data = handler(req, ctx);
    // Kuvertet bär alltid configRev (4.3). Admin-anrop som inte själva läser config (setup, calendars-list, inbox-list,
    // ack) får den härifrån – cache-träff i normalfallet; okonfigurerat script → null.
    if (ctx.configRev === null) { try { loadConfig(ctx); } catch (e) { /* okonfigurerad – configRev förblir null */ } }
    return okEnvelope(data, ctx);
  } catch (err) {
    const code = errorCode(err);
    if (!code) throw err;
    return errEnvelope(code, err instanceof ApiError ? err.message : FEL_TEXT[code], err.details);
  } finally {
    setCtx(ctx);
  }
}

// ============================================================
// Script Properties (4.2)
// ============================================================

function getProp(name) { return PropertiesService.getScriptProperties().getProperty(name) || ''; }
function setProp(name, value) { PropertiesService.getScriptProperties().setProperty(name, String(value)); }
function deleteProp(name) { PropertiesService.getScriptProperties().deleteProperty(name); }

// De tre fil-id:na. Saknas något → E_SETUP (M3:s setup fyller dem).
function getFileIds() {
  const ids = { config: getProp(PROP.CONFIG_FILE_ID), inbox: getProp(PROP.INBOX_FILE_ID), cache: getProp(PROP.CACHE_FILE_ID) };
  if (!ids.config || !ids.inbox || !ids.cache) fel('E_SETUP', 'Brevlådans filer är inte anslutna');
  return ids;
}
function mapsDailyCap() { const n = parseInt(getProp(PROP.MAPS_DAILY_CAP), 10); return n > 0 ? n : MAPS_DAILY_CAP_DEFAULT; }
function mapsElementsToday() { return parseInt(getProp('maps_elements_' + ymdCompact(todayStr())), 10) || 0; }
// Räknar Maps-element mot dagstaket (5.8). Anropas av Availability.gs vid varje Geocoding-/Distance Matrix-anrop.
function addMapsElements(n) {
  const key = 'maps_elements_' + ymdCompact(todayStr());
  const v = (parseInt(getProp(key), 10) || 0) + (Number(n) || 0);
  setProp(key, v);
  return v;
}
function mapsCapReached() { return mapsElementsToday() >= mapsDailyCap(); }

// ============================================================
// Filhantering (4.1, 4.2) – exakt de tre fil-id:na, aldrig sök på namn, aldrig skapa/radera.
// ============================================================

// Verifierar filen enligt 4.2 (cachad 10 min per id). Returnerar File-objektet när det hämtats, annars null.
// opts.farsk = true hoppar över cachen (setup verifierar alltid på riktigt) och returnerar alltid File-objektet.
function verifyBrevladaFile(id, opts) {
  const cache = CacheService.getScriptCache(), key = 'setupok:' + id;
  if (!(opts && opts.farsk) && cache.get(key) === '1') return null;
  if (typeof id !== 'string' || !FIL_ID_RE.test(id)) fel('E_SETUP', 'Brevlådefilens id har fel format');
  let file = null;
  try { file = DriveApp.getFileById(id); } catch (e) { file = null; }
  if (!file) fel('E_SETUP', 'Brevlådefilen hittades inte');
  if (file.isTrashed()) fel('E_SETUP', 'Filen ligger i papperskorgen');
  if (!/^telexia-bokning-.*\.json$/.test(file.getName())) fel('E_SETUP', 'Brevlådefilen har fel namn');
  if (file.getMimeType() !== 'application/json') fel('E_SETUP', 'Brevlådefilen har fel filtyp');
  // Session.getEffectiveUser().getEmail() kräver scopet userinfo.email (appsscript.json). Saknas det svarar
  // Apps Script med tom sträng (kastar inte) – då ska felet vara självförklarande, inte "annat konto".
  const mig = Session.getEffectiveUser().getEmail();
  if (!mig) fel('E_SETUP', 'Scriptet saknar behörighet userinfo.email – lägg till scopet i appsscript.json och godkänn om');
  const owner = file.getOwner();
  if (!owner || owner.getEmail() !== mig) fel('E_SETUP', 'Brevlådefilen ägs av ett annat konto');
  cache.put(key, '1', SETUP_CACHE_S);
  return file;
}
function brevladaFile(id) { return verifyBrevladaFile(id) || DriveApp.getFileById(id); }
function clearSetupCache() {
  const c = CacheService.getScriptCache();
  [PROP.CONFIG_FILE_ID, PROP.INBOX_FILE_ID, PROP.CACHE_FILE_ID].forEach(p => { const id = getProp(p); if (id) c.remove('setupok:' + id); });
}

function readJsonFile(id) {
  const text = brevladaFile(id).getBlob().getDataAsString('UTF-8');
  let obj = null;
  try { obj = JSON.parse(text); } catch (e) { obj = null; }
  if (!isPlainObject(obj)) fel('E_SETUP', 'Brevlådefilen innehåller inte giltig JSON');
  return obj;
}
// Skriver filen med gemensamt huvud (4.1): rev+1, updatedAt, updatedBy 'script'. Anroparen håller låset.
function writeJsonFile(id, obj) {
  obj.schemaVersion = 1;
  obj.rev = (Number(obj.rev) || 0) + 1;
  obj.updatedAt = nowIso();
  obj.updatedBy = 'script';
  brevladaFile(id).setContent(JSON.stringify(obj));
  return obj;
}

// --- Config (läses av scriptet, skrivs av appen) – CacheService 10 min ---
// loadConfig(ctx?, opts?) → { rev, bokare[], motestyper[], formular, installningar, ignorerade[], pipelines[] }
function loadConfig(ctx, opts) {
  const cache = CacheService.getScriptCache();
  let cfg = null;
  if (!(opts && opts.farsk)) {
    const raw = cache.get('config');
    if (raw) { try { cfg = JSON.parse(raw); } catch (e) { cfg = null; } }
  }
  if (!cfg) {
    cfg = normalizeConfig(readJsonFile(getFileIds().config));
    const json = JSON.stringify(cfg);
    if (byteLength(json) <= CACHE_MAX_BYTES) cache.put('config', json, CONFIG_CACHE_S);
  }
  if (ctx) ctx.configRev = cfg.rev;
  return cfg;
}
function clearConfigCache() { CacheService.getScriptCache().remove('config'); }
function byteLength(s) { return Utilities.newBlob(s).getBytes().length; }

function normalizeConfig(raw) {
  const cfg = {
    schemaVersion: raw.schemaVersion || 1,
    rev: Number(raw.rev) || 0,
    updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : '',
    updatedBy: typeof raw.updatedBy === 'string' ? raw.updatedBy : '',
    bokare: Array.isArray(raw.bokare) ? raw.bokare.filter(isPlainObject) : [],
    motestyper: Array.isArray(raw.motestyper) ? raw.motestyper.filter(isPlainObject) : [],
    formular: fillDefaults(isPlainObject(raw.formular) ? raw.formular : {}, DEFAULT_BOKNINGSFORMULAR),
    installningar: fillDefaults(isPlainObject(raw.installningar) ? raw.installningar : {}, DEFAULT_BOKNINGSINSTALLNINGAR),
    ignorerade: Array.isArray(raw.ignorerade) ? raw.ignorerade.filter(isPlainObject) : [],
    pipelines: Array.isArray(raw.pipelines) ? raw.pipelines.filter(isPlainObject) : []
  };
  if (!Array.isArray(cfg.formular.extrafalt)) cfg.formular.extrafalt = [];
  if (!Array.isArray(cfg.installningar.kalendrar)) cfg.installningar.kalendrar = [];
  if (!isPlainObject(cfg.installningar.paus)) cfg.installningar.paus = deepClone(DEFAULT_BOKNINGSINSTALLNINGAR.paus);
  // Fält som aldrig ska finnas här (lämnar aldrig appen) nollas för säkerhets skull.
  cfg.installningar.adminNyckel = '';
  cfg.installningar.brevladaFiler = { config: '', inbox: '', cache: '' };
  return cfg;
}

// --- Inkorg (skrivs bara av scriptet, alltid under lås) ---
function readInbox() {
  const inbox = readJsonFile(getFileIds().inbox);
  if (!Array.isArray(inbox.bokningar)) inbox.bokningar = [];
  inbox.bokningar = inbox.bokningar.filter(isPlainObject);
  return inbox;
}
function writeInbox(inbox) { return writeJsonFile(getFileIds().inbox, inbox); }
function findBokningInInbox(inbox, bokningId) { return inbox.bokningar.find(b => b.bokningId === bokningId) || null; }

// --- Cache-fil (geokod, restid, icsReserv) – används av Availability.gs/Calendar.gs ---
function readCacheFile() {
  const c = readJsonFile(getFileIds().cache);
  if (!isPlainObject(c.geokod)) c.geokod = {};
  if (!isPlainObject(c.restid)) c.restid = {};
  if (c.icsReserv === undefined) c.icsReserv = null;
  return c;
}
function writeCacheFile(c) { return writeJsonFile(getFileIds().cache, c); }

// ============================================================
// Lås (4.8)
// ============================================================

function withScriptLock(fn, waitMs) {
  const lock = LockService.getScriptLock();
  let fick = false;
  try { fick = lock.tryLock(waitMs || LOCK_WAIT_MS); } catch (e) { fick = false; }
  if (!fick) fel('E_LOCK');
  try { return fn(); }
  finally { try { lock.releaseLock(); } catch (e) { /* redan släppt */ } }
}

// ============================================================
// Räknare i CacheService (4.5) – get→put är inte atomiskt, medvetet utan lås.
// ============================================================

function bumpCounter(key, ttlS) {
  const cache = CacheService.getScriptCache();
  const n = (parseInt(cache.get(key), 10) || 0) + 1;
  cache.put(key, String(n), ttlS);
  return n;
}
function readCounter(key) { return parseInt(CacheService.getScriptCache().get(key), 10) || 0; }
function minuteWindow() { return Math.floor(Date.now() / 60000); }
function hourWindow() { return Math.floor(Date.now() / 3600000); }
function tenMinWindow() { return Math.floor(Date.now() / 600000); }

// ============================================================
// Autentisering (4.5)
// ============================================================

function sha256hex(s) {
  return Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, s, Utilities.Charset.UTF_8)
    .map(b => ('0' + (b & 0xff).toString(16)).slice(-2)).join('');
}
// Nyckelprefix för räknare per kod: en del av kodHashen (klartextkoden hamnar aldrig i cache-nycklar).
function kodKey(bokare) { return String(bokare.kodHash || '').slice(0, 16) || ('id_' + String(bokare.id || '')); }

function findBokareByKod(k, config) {
  if (typeof k !== 'string' || !KOD_RE.test(k)) return null;
  const h = sha256hex(k);
  return config.bokare.find(b => typeof b.kodHash === 'string' && b.kodHash === h && b.aktiv === true) || null;
}

// Okänd/ogiltig/inaktiv kod: samma svar (E_KEY) – utom när okända koder överskridit sin gräns (E_RATE).
function badKod() {
  const n = bumpCounter('rl:bad:' + tenMinWindow(), 600);
  if (n > RL_BAD_PER_10MIN) fel('E_RATE', undefined, { typ: 'anrop' });
  fel('E_KEY');
}

// Returnerar { bokare, config }; sätter ctx.bokareId/ctx.kodKey; tillämpar anropsgränser per kod.
function authBokare(req, ctx) {
  const k = req.k;
  if (typeof k !== 'string' || !KOD_RE.test(k)) badKod();
  const config = loadConfig(ctx);
  const bokare = findBokareByKod(k, config);
  if (!bokare) badKod();
  ctx.bokareId = String(bokare.id || '');
  ctx.kodKey = kodKey(bokare);
  if (bumpCounter('rl:' + ctx.kodKey + ':m' + minuteWindow(), 120) > RL_PER_MIN) fel('E_RATE', undefined, { typ: 'anrop' });
  if (bumpCounter('rl:' + ctx.kodKey + ':h' + hourWindow(), TTL_H_S) > RL_PER_H) fel('E_RATE', undefined, { typ: 'anrop' });
  return { bokare: bokare, config: config };
}

// Konstanttidsjämförelse: HMAC av båda värdena med samma nyckel, därefter full byte-jämförelse utan tidig avbrytning.
function constantTimeEqual(a, b) {
  const salt = 'pipeline-bokning-adminnyckel';
  const ha = Utilities.computeHmacSha256Signature(String(a), salt, Utilities.Charset.UTF_8);
  const hb = Utilities.computeHmacSha256Signature(String(b), salt, Utilities.Charset.UTF_8);
  let diff = ha.length ^ hb.length;
  for (let i = 0; i < ha.length && i < hb.length; i++) diff |= (ha[i] ^ hb[i]);
  return diff === 0;
}
function authAdmin(req, ctx) {
  if (bumpCounter('rl:admin:m' + minuteWindow(), 120) > RL_ADMIN_PER_MIN) fel('E_RATE', undefined, { typ: 'anrop' });
  const expected = getProp(PROP.ADMIN_KEY);
  if (!expected) fel('E_SETUP', 'Adminnyckel saknas i Script Properties');
  const given = typeof req.adminKey === 'string' ? req.adminKey : '';
  if (!given || given.length > 256 || !constantTimeEqual(given, expected)) fel('E_ADMIN');
  ctx.bokareId = 'admin';
}

// ============================================================
// Handlingsgränser (4.5)
// ============================================================

// Bokningar: kontroll före arbetet (utan att räkna upp), uppräkning efter lyckad bokning.
function checkBookLimits(ctx) {
  const idag = todayStr();
  const perH = readCounter('book:h:' + ctx.kodKey + ':' + hourWindow());
  const perD = readCounter('book:d:' + ctx.kodKey + ':' + idag);
  const global = parseInt(getProp('book_count_' + ymdCompact(idag)), 10) || 0;
  if (perH >= MAX_BOOK_PER_KOD_H || perD >= MAX_BOOK_PER_KOD_D || global >= MAX_BOOK_GLOBAL_D)
    fel('E_RATE', 'För många bokningar – kontakta CJ', { typ: 'bokningar' });
}
function countBooking(ctx) {
  const idag = todayStr();
  bumpCounter('book:h:' + ctx.kodKey + ':' + hourWindow(), TTL_H_S);
  bumpCounter('book:d:' + ctx.kodKey + ':' + idag, TTL_D_S);
  const key = 'book_count_' + ymdCompact(idag);
  setProp(key, (parseInt(getProp(key), 10) || 0) + 1);
}

// Adressnyckel för gränsräkning: gemener, utan skiljetecken, ett mellanslag, utan "sverige" (samma princip som cache-filen, 4.1).
function limitAdressNyckel(adress) {
  return String(adress || '').toLowerCase().replace(/[^a-z0-9åäö]+/g, ' ').replace(/\bsverige\b/g, '').replace(/\s+/g, ' ').trim();
}
// Unika adresser per kod och dag (MAX_ADRESSER_PER_KOD_D) och nya geokodningar per kod och timme (MAX_GEOCODE_PER_KOD_H).
// En adress som koden redan använt i dag räknas inte igen. Timräknaren KONTROLLERAS här men stegas först i
// countGeocodeCall() – bara när Geocoding-API:t faktiskt anropades (cache-träffar räknas inte, 4.5/5.8).
function checkAdressLimits(ctx, adress) {
  const nyckel = limitAdressNyckel(adress);
  if (!nyckel) return;
  const cache = CacheService.getScriptCache();
  const dagKey = 'geo:count:' + ctx.kodKey + ':' + todayStr();
  let lista = [];
  try { lista = JSON.parse(cache.get(dagKey) || '[]'); } catch (e) { lista = []; }
  if (!Array.isArray(lista)) lista = [];
  const h = sha256hex(nyckel).slice(0, 16);
  if (lista.indexOf(h) >= 0) return;
  if (lista.length >= MAX_ADRESSER_PER_KOD_D) fel('E_RATE', 'För många adresser – kontakta CJ', { typ: 'adresser' });
  if (readCounter(geocodeTimKey(ctx)) >= MAX_GEOCODE_PER_KOD_H) fel('E_RATE', 'För många adressuppslag – vänta en stund', { typ: 'geocode' });
  lista.push(h);
  cache.put(dagKey, JSON.stringify(lista), TTL_D_S);
}
function geocodeTimKey(ctx) { return 'geo:h:' + ctx.kodKey + ':' + hourWindow(); }
// Stegas efter geokodning när geocodeAddress rapporterar nyttAnrop:true (ett riktigt Geocoding-API-anrop).
function countGeocodeCall(ctx) { if (ctx && ctx.kodKey) bumpCounter(geocodeTimKey(ctx), TTL_H_S); }

// ============================================================
// Reservationer (4.8, 5.11) – lever bara i CacheService.
//   res:<id>          → JSON { id, bokareId, motestypId, start, slut, plats, cooldownMin, expires, expiresMs } (TTL 300 s)
//   res:index         → JSON-lista med samma poster (utgångna rensas vid varje läsning)
//   res:owner:<kod>   → aktuellt reservations-id för koden (nytt reserve släpper det gamla)
// Calendar.gs läser aktiva reservationer via listActiveReservations() (eller res:index direkt) i buildBusyList.
// ============================================================

function resIndexRead() {
  const cache = CacheService.getScriptCache();
  let lista = [];
  try { lista = JSON.parse(cache.get('res:index') || '[]'); } catch (e) { lista = []; }
  if (!Array.isArray(lista)) lista = [];
  const nu = Date.now();
  return lista.filter(r => isPlainObject(r) && typeof r.id === 'string' && Number(r.expiresMs) > nu);
}
function resIndexWrite(lista) { CacheService.getScriptCache().put('res:index', JSON.stringify(lista), TTL_D_S); }
function listActiveReservations() { return resIndexRead(); }

function getReservation(id) {
  if (typeof id !== 'string' || !/^rs_[A-Za-z0-9]{8,40}$/.test(id)) return null;
  const raw = CacheService.getScriptCache().get('res:' + id);
  if (!raw) return null;
  let r = null;
  try { r = JSON.parse(raw); } catch (e) { r = null; }
  return isPlainObject(r) && Number(r.expiresMs) > Date.now() ? r : null;
}
function ownReservationId(ctx) { return CacheService.getScriptCache().get('res:owner:' + ctx.kodKey) || ''; }

function createReservation(ctx, bokare, typ, startIso, slutIso, plats) {
  if (MAX_RES_PER_KOD <= 1) releaseOwnReservation(ctx);
  const cache = CacheService.getScriptCache();
  const id = 'rs_' + Utilities.getUuid().replace(/-/g, '').slice(0, 20);
  const expiresMs = Date.now() + RES_TTL_S * 1000;
  const r = {
    id: id, bokareId: String(bokare.id || ''), motestypId: String(typ.id || ''),
    start: startIso, slut: slutIso, plats: plats || null, cooldownMin: Number(typ.cooldownMin) || 0,
    expires: isoWithOffset(new Date(expiresMs)), expiresMs: expiresMs
  };
  cache.put('res:' + id, JSON.stringify(r), RES_TTL_S);
  const idx = resIndexRead(); idx.push(r); resIndexWrite(idx);
  cache.put('res:owner:' + ctx.kodKey, id, RES_TTL_S);
  return r;
}
function releaseReservation(id) {
  const cache = CacheService.getScriptCache();
  cache.remove('res:' + id);
  resIndexWrite(resIndexRead().filter(r => r.id !== id));
}
function releaseOwnReservation(ctx) {
  const cache = CacheService.getScriptCache();
  const id = ownReservationId(ctx);
  if (id) releaseReservation(id);
  cache.remove('res:owner:' + ctx.kodKey);
}

// ============================================================
// Gemensam validering och uppslag
// ============================================================

function str(v) { return typeof v === 'string' ? v : ''; }
// Tar bort kontrolltecken utom \n och \t (CRLF → LF), trimmar.
function cleanText(v) { return String(v).replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').trim(); }

// Strängfält i enkla endpoints: kastar E_VALIDATION direkt.
function strField(v, namn, max, obligatorisk) {
  if (v === undefined || v === null) v = '';
  if (typeof v !== 'string') valideringsfel({ [namn]: 'Ogiltigt värde' });
  const s = cleanText(v);
  if (s.length > max) valideringsfel({ [namn]: 'För långt värde' });
  if (obligatorisk && !s) valideringsfel({ [namn]: 'Obligatoriskt' });
  return s;
}
function datumField(v, namn) {
  if (typeof v !== 'string' || !DATUM_RE.test(v) || isNaN(new Date(v + 'T12:00:00Z').getTime())) valideringsfel({ [namn]: 'Ogiltigt datum' });
  return v;
}

function pausInfo(inst) {
  const p = isPlainObject(inst.paus) ? inst.paus : {};
  return { aktiv: p.aktiv === true, tom: str(p.tom), meddelande: str(p.meddelande) };
}
// reserve/book med start ≤ paus.tom → E_PAUSED (4.3). Aktiv paus utan slutdatum tolkas som tills vidare.
function pausCheck(inst, datum) {
  const p = pausInfo(inst);
  if (!p.aktiv) return;
  if (!p.tom || datum <= p.tom) fel('E_PAUSED', undefined, { tom: p.tom, meddelande: p.meddelande });
}

// Aktiva mötestyper som bokaren får boka: typer i bokarens pipeline + globala, filtrerade på tillatnaMotestypIds.
function tillatnaMotestyper(config, bokare) {
  const tillatna = Array.isArray(bokare.tillatnaMotestypIds) ? bokare.tillatnaMotestypIds : [];
  return config.motestyper.filter(t =>
    t.aktiv !== false &&
    (t.global === true || (t.pipelineId && t.pipelineId === bokare.pipelineId)) &&
    (!tillatna.length || tillatna.indexOf(t.id) >= 0));
}
function motestypExport(t) {
  return { id: str(t.id), titel: str(t.titel), langdMin: Number(t.langdMin) || 0, cooldownMin: Number(t.cooldownMin) || 0,
           restid: t.restid === true, farg: str(t.farg), bekraftelseMall: str(t.bekraftelseMall) };
}
// Slår upp mötestypen för ett anrop. undantaPost (ombokning, 4.4/5.3) tillåter bokningens egen typ även om den är inaktiv
// eller inte längre i tillatnaMotestypIds. Returnerar en normaliserad kopia.
function resolveMotestyp(config, bokare, motestypId, undantaPost) {
  if (typeof motestypId !== 'string' || !motestypId || motestypId.length > 64) valideringsfel({ motestypId: 'Okänd mötestyp' });
  let t = null;
  if (undantaPost && undantaPost.motestypId === motestypId) t = config.motestyper.find(x => x.id === motestypId) || null;
  else t = tillatnaMotestyper(config, bokare).find(x => x.id === motestypId) || null;
  if (!t) valideringsfel({ motestypId: 'Okänd mötestyp' });
  const typ = Object.assign({}, t, motestypExport(t));
  if (!(typ.langdMin > 0)) valideringsfel({ motestypId: 'Mötestypen är felkonfigurerad' });
  return typ;
}

// undantaBokningId honoreras bara för CJ-bokare eller bokningens egen bokare; annars ignoreras parametern tyst (4.4).
function honoredUndanta(v, bokare) {
  if (typeof v !== 'string' || !BOKNING_ID_RE.test(v)) return null;
  const post = findBokningInInbox(readInbox(), v);
  if (!post) return null;
  if (bokare.arCj === true || post.bokareId === bokare.id) return { bokningId: v, post: post };
  return null;
}

// Starttid från klienten: ISO med offset → { datum, tid, iso, ms } i Stockholm-tid. Gränserna härleds ur SAMMA källa
// som availability (mapCfg/isWorkingDay/firstBookableDay/sistaDagFor i Availability.gs): raster, öppen dag (arbetstid,
// röd dag), framförhållning per mötestyp (4.4 steg 2, 5.4) och horisont – så att en lucka availability visar som
// 'ledig' aldrig avvisas här med E_VALIDATION.
function parseStartField(v, inst, typ) {
  if (typeof v !== 'string' || !ISO_START_RE.test(v)) valideringsfel({ start: 'Ogiltig starttid' });
  const d = new Date(v);
  if (isNaN(d.getTime()) || d.getUTCSeconds() !== 0 || d.getUTCMilliseconds() !== 0) valideringsfel({ start: 'Ogiltig starttid' });
  const p = tzParts(d);
  const cfg = mapCfg(inst);
  const at = cfg.arbetstider[weekdayOf(p.datum)];
  if (!at || !isWorkingDay(p.datum, cfg)) valideringsfel({ start: 'Dagen är stängd' });
  const m = tidToMin(p.tid), s = tidToMin(at.start);
  if (isNaN(m) || isNaN(s) || m < s || (m - s) % cfg.rasterMin !== 0) valideringsfel({ start: 'Tiden ligger inte på ett giltigt klockslag' });
  const idag = todayStr();
  if (p.datum < firstBookableDay(cfg, typ || { restid: true }, idag)) valideringsfel({ start: 'Tiden är för tidig' });
  if (p.datum > sistaDagFor(cfg, idag)) valideringsfel({ start: 'Utanför bokningshorisonten' });
  return { datum: p.datum, tid: p.tid, iso: toIsoWithOffset(p.datum, p.tid), ms: d.getTime() };
}

// Egen kalenderskrivning kräver kalendern med lage 'fullt' (4.7).
function bokningarKalenderId(inst) {
  const k = (Array.isArray(inst.kalendrar) ? inst.kalendrar : []).find(x => isPlainObject(x) && x.lage === 'fullt' && typeof x.id === 'string' && x.id);
  if (!k) fel('E_CALENDAR', 'Ingen kalender för bokningar är vald i Inställningar');
  return k.id;
}

// Geokodning via Availability.gs (cachekedja + Maps). Fel → 'okand' (schablon), aldrig avbruten bokning.
// ctx (bokare) → timräknaren MAX_GEOCODE_PER_KOD_H stegas bara när ett riktigt API-anrop gjordes (nyttAnrop).
// Anropas före låset i reserve/book och före computeAvailability i availability: värmer CacheService så att
// geocodeAddress inuti beräkningen/låset blir cache-träff.
function geoForBooking(adress, ctx) {
  const tom = { lat: null, lng: null, formaterad: '', status: 'okand' };
  if (!adress) return Object.assign(tom, { status: 'saknas' });
  try {
    const g = geocodeAddress(adress);
    if (g && g.nyttAnrop === true) countGeocodeCall(ctx);
    if (g && g.status === 'ok' && typeof g.lat === 'number' && typeof g.lng === 'number')
      return { lat: g.lat, lng: g.lng, formaterad: str(g.formaterad), status: 'ok' };
    return Object.assign(tom, { formaterad: g ? str(g.formaterad) : '' });
  } catch (e) {
    if (errorCode(e) === 'E_RATE') throw e;
    return tom;
  }
}

// Räknar om en enskild dag (färsk kalenderläsning i book/reserve) och returnerar slotten för klockslaget, eller null.
// inbox (valfri) = redan läst inkorg – book skickar den så att inkorgsfilen läses en gång under låset.
function findSlot(bokare, config, typ, adress, st, reservationId, undantaBokningId, farsk, inbox) {
  const data = computeAvailability({
    bokare: bokare, config: config, typ: typ, motestypId: typ.id,
    adress: typ.restid ? (adress || '') : '',
    from: st.datum, to: st.datum,
    reservationId: reservationId || '', undantaBokningId: undantaBokningId || '',
    farsk: !!farsk, intern: true, inbox: inbox || null
  });
  const dag = (data && Array.isArray(data.dagar) ? data.dagar : []).find(d => d.datum === st.datum);
  if (!dag || dag.status !== 'oppen') return null;
  return (Array.isArray(dag.slots) ? dag.slots : []).find(s => s.tid === st.tid) || null;
}
function blockLen(block) {
  if (!Array.isArray(block) || block.length !== 2) return 0;
  const a = tidToMin(block[0]), b = tidToMin(block[1]);
  return isNaN(a) || isNaN(b) ? 0 : Math.max(0, b - a);
}
// restid-objektet på inkorgsposten (4.1): foreMin/efterMin ur slottens interna minuter (restidMin) eller blocklängderna.
// status ∈ 'ok' | 'schablon' | 'okand' (4.1/5.8) – appen flaggar allt utom 'ok' som restidsproblem (6.2, 8.4), så en
// mötestyp utan restid får 'ok' med 0/0 (aldrig ett eget värde).
function restidFromSlot(slot, typ, geo) {
  if (!typ.restid) return { foreMin: 0, efterMin: 0, status: 'ok' };
  const rm = isPlainObject(slot.restidMin) ? slot.restidMin : null;
  const fore = rm && typeof rm.fore === 'number' ? rm.fore : blockLen(slot.restid && slot.restid.inBlock);
  const efter = rm && typeof rm.efter === 'number' ? rm.efter : blockLen(slot.restid && slot.restid.utBlock);
  let status = 'ok';
  if (geo.status !== 'ok') status = 'okand';
  else if (slot.restidOkand === true || (rm && rm.kalla === 'schablon')) status = 'schablon';
  return { foreMin: fore, efterMin: efter, status: status };
}

// ============================================================
// Endpoint: ping (oautentiserad, 4.4)
// ============================================================

// konfigurerad = alla tre fil-id:n finns, alla tre filerna klarar filkontrollen 4.2 (cachad 10 min per id – ping är
// oautentiserat och får inte kunna driva Drive-kvoten; färsk kontroll görs bara i det adminautentiserade setup), ADMIN_KEY
// finns och config-filen är läsbar JSON. orsak = '' när konfigurerad, annars en statisk text med filens roll (config/inbox/cache).
function handlePing(req, ctx) {
  if (bumpCounter('rl:ping:m' + minuteWindow(), 120) > RL_PING_PER_MIN) fel('E_RATE', undefined, { typ: 'anrop' });
  let konfigurerad = false, config = null;
  let orsak = brevladaStatus();
  if (!orsak && !getProp(PROP.ADMIN_KEY)) orsak = 'Adminnyckel saknas i Script Properties';
  if (!orsak) {
    try { config = loadConfig(ctx); konfigurerad = true; }
    catch (e) { if (errorCode(e) !== 'E_SETUP') throw e; orsak = 'config: ' + e.message; }
  }
  return {
    scriptVersion: SCRIPT_VERSION,
    konfigurerad: konfigurerad,
    orsak: orsak,
    mapsNyckel: !!getProp(PROP.MAPS_API_KEY),
    mapsForbrukningIdag: mapsElementsToday(),
    mapsVarning: CacheService.getScriptCache().get('maps:varning') || '',
    mapsDagstak: mapsDailyCap(),   // M5: dagstaket (Script Property MAPS_DAILY_CAP, default 1000) så att Inställningar kan visa "N av tak"
    icsStatus: icsStatusForPing(config),
    // M5 (10.4): bokningar i dag (Script Property book_count_<YYYYMMDD>, samma räknare som MAX_BOOK_GLOBAL_D), senaste lyckade
    // dailyMaintenance (V1: triggern kör fortfarande) och antal avstämningsvarningar "saknas i inkorgen" (4.11).
    bokningarIdag: parseInt(getProp('book_count_' + ymdCompact(todayStr())), 10) || 0,
    underhallSenast: getProp(MAINT_PROP_SENAST),
    avstamningSaknas: avstamningSaknas().antal
  };
}
// Kontroll av de tre brevlådefilerna (4.2, cachad 10 min per id). Returnerar '' när allt är i ordning, annars '<roll>: <statisk orsak>'.
const BREVLADA_ROLLER = [['config', PROP.CONFIG_FILE_ID], ['inbox', PROP.INBOX_FILE_ID], ['cache', PROP.CACHE_FILE_ID]];
function brevladaStatus() {
  const saknas = BREVLADA_ROLLER.filter(r => !getProp(r[1])).map(r => r[0]);
  if (saknas.length) return 'Fil-id saknas i Script Properties: ' + saknas.join(', ');
  for (let i = 0; i < BREVLADA_ROLLER.length; i++) {
    const roll = BREVLADA_ROLLER[i][0], id = getProp(BREVLADA_ROLLER[i][1]);
    try { verifyBrevladaFile(id); }
    catch (e) { if (errorCode(e) !== 'E_SETUP') throw e; return roll + ': ' + e.message; }
  }
  return '';
}
// ICS-status: i första hand Calendar.gs getIcsStatus() (CacheService 'ics:meta'); reserv = cache-filens icsReserv (senast lyckade läsning).
// M5: dessutom hamtningMs (senaste hämtningens tid), cachad (resultatet ryms i CacheService) och langsam (senaste hämtningen tog
// > 5 s → reservkopian används vid cache-miss i 30 min, A46) – visas under Inställningar › ICS-status.
function icsStatusForPing(config) {
  const st = { ok: false, hamtadTs: '', antal: 0, medPlats: 0, preliminara: 0, hamtningMs: 0, cachad: false, langsam: false };
  if (!config) return st;
  if (!config.installningar.outlookIcsUrl) { st.ok = true; return st; }
  try {
    if (typeof getIcsStatus === 'function') {
      const g = getIcsStatus();
      if (isPlainObject(g)) return { ok: g.ok === true, hamtadTs: str(g.hamtadTs), antal: Number(g.antal) || 0, medPlats: Number(g.medPlats) || 0, preliminara: Number(g.preliminara) || 0,
        hamtningMs: Number(g.hamtningMs) || 0, cachad: g.cachad === true, langsam: g.langsam === true };
    }
    const r = readCacheFile().icsReserv;
    st.ok = true;
    if (isPlainObject(r) && Array.isArray(r.handelser)) {
      st.hamtadTs = str(r.hamtadTs);
      st.antal = r.handelser.length;
      st.medPlats = r.handelser.filter(h => h && h.plats).length;
      st.preliminara = r.handelser.filter(h => h && h.preliminar === true).length;
    }
  } catch (e) { st.ok = false; }
  return st;
}

// ============================================================
// Endpoint: hello (4.4)
// ============================================================

function handleHello(req, ctx) {
  const a = authBokare(req, ctx), bokare = a.bokare, config = a.config, inst = config.installningar;
  const idag = todayStr();
  const pipeline = config.pipelines.find(p => p.id === bokare.pipelineId) || {};
  return {
    bokare: { id: str(bokare.id), arCj: bokare.arCj === true, namn: str(bokare.namn), organisation: str(bokare.organisation),
              pipelineNamn: str(pipeline.name), pipelineFarg: str(pipeline.color) },
    motestyper: tillatnaMotestyper(config, bokare).map(motestypExport),
    formular: config.formular,
    paus: pausInfo(inst),
    horisont: { from: idag, to: horisontTomDatum(inst) },
    integritetstext: str(inst.integritetstext),
    kontaktTextBokare: str(inst.kontaktTextBokare),
    notisEpost: str(inst.notisEpost),
    serverTime: nowIso(),
    egna: egnaBokningar(bokare, idag)
  };
}
// Bokarens egna bokningar med slut ≥ idag − 7 dagar, sorterade på start. Kundnamn får visas för ägaren (beslut 16).
function egnaBokningar(bokare, idag) {
  const grans = addDays(idag, -7);
  return readInbox().bokningar
    .filter(b => b.bokareId === bokare.id && typeof b.slut === 'string' && fromIso(b.slut).datum >= grans)
    .sort((x, y) => String(x.start).localeCompare(String(y.start)))
    .map(b => ({
      bokningId: str(b.bokningId), start: str(b.start), slut: str(b.slut),
      kundNamn: str(b.kund && b.kund.namn), kontaktNamn: str(b.kontakt && b.kontakt.namn), adress: str(b.adress),
      motestypId: str(b.motestypId), status: egenStatus(b)
    }));
}
function egenStatus(b) {
  if (b.status === 'avbokad' || b.status === 'avvisad') return b.status;
  return (Array.isArray(b.historik) ? b.historik : []).some(h => h && h.typ === 'ombokad') ? 'ombokad' : 'bokad';
}

// ============================================================
// Endpoint: availability (4.4, 5.3) – beräkningen sker i Availability.gs
// ============================================================

function handleAvailability(req, ctx) {
  const a = authBokare(req, ctx), bokare = a.bokare, config = a.config, inst = config.installningar;
  const from = datumField(req.from, 'from'), to = datumField(req.to, 'to');
  if (to < from) valideringsfel({ to: 'Slutdatum ligger före startdatum' });
  if (daysBetween(from, to) > 14) valideringsfel({ to: 'Högst 14 dagar per förfrågan' });
  if (from > horisontTomDatum(inst)) valideringsfel({ from: 'Utanför bokningshorisonten' });
  const adress = strField(req.adress, 'adress', MAXLEN.adress, false);
  const undanta = honoredUndanta(req.undantaBokningId, bokare);
  const typ = resolveMotestyp(config, bokare, req.motestypId, undanta ? undanta.post : null);
  const egen = getReservation(req.reservationId);
  const reservationId = egen && egen.bokareId === bokare.id ? egen.id : '';
  if (typ.restid && adress) {
    checkAdressLimits(ctx, adress);
    geoForBooking(adress, ctx);   // geokodar (räknar ev. API-anrop mot timgränsen) → cache-träff i computeAvailability
  }
  return computeAvailability({
    bokare: bokare, config: config, typ: typ, motestypId: typ.id,
    adress: typ.restid ? adress : '',
    from: from, to: to,
    reservationId: reservationId, undantaBokningId: undanta ? undanta.bokningId : '',
    farsk: false, intern: false
  });
}

// ============================================================
// Endpoint: reserve / release (4.4, 4.8, 5.11)
// ============================================================

function handleReserve(req, ctx) {
  const a = authBokare(req, ctx), bokare = a.bokare, config = a.config, inst = config.installningar;
  const typ = resolveMotestyp(config, bokare, req.motestypId, null);
  const st = parseStartField(req.start, inst, typ);
  pausCheck(inst, st.datum);
  const adress = typ.restid ? strField(req.adress, 'adress', MAXLEN.adress, false) : '';
  let plats = null;
  if (typ.restid && adress) {
    checkAdressLimits(ctx, adress);
    const g = geoForBooking(adress, ctx);
    plats = { text: adress, lat: g.lat, lng: g.lng, geokodad: g.status === 'ok' };
  }
  const slutIso = toIsoWithOffset(st.datum, minToTid(tidToMin(st.tid) + typ.langdMin));
  const egenId = ownReservationId(ctx);
  // Värm cacherna före låset (4.8): ICS-hämtning (UrlFetchApp), geokodning av ankare och Distance Matrix sker här,
  // så att bara Calendar.Events.list (färsk) + CacheService återstår inuti låset. Resultatet används inte – luckan
  // avgörs alltid av den färska läsningen under låset.
  warmSlotCaches(bokare, config, typ, adress, st, egenId);
  return withScriptLock(() => {
    const slot = findSlot(bokare, config, typ, adress, st, egenId, '', true);
    if (!slot || slot.status !== 'ledig') fel('E_SLOT_TAKEN');
    const r = createReservation(ctx, bokare, typ, st.iso, slutIso, plats);
    return { reservationId: r.id, expiresAt: r.expires };
  });
}
// Kör dagsberäkningen utan färsk kalenderläsning (cachat busy:<datum>/ics:busy/geo/restid). Nätverksfel här
// bryter inte anropet – den färska beräkningen under låset avgör (E_CALENDAR först där).
function warmSlotCaches(bokare, config, typ, adress, st, reservationId) {
  // ICS uttryckligen först: en träff i busy:<datum> (60 s) skulle annars hoppa över readIcs, och den färska läsningen under
  // låset skulle då hämta flödet där (memo per körning i Calendar.gs gör att läsningen under låset blir en kopia).
  if (typeof readIcs === 'function') { try { readIcs(config, { farsk: false }); } catch (e) { /* avgörs under låset */ } }
  try { findSlot(bokare, config, typ, adress, st, reservationId, '', false); }
  catch (e) { if (errorCode(e) === 'E_RATE') throw e; }
}

function handleRelease(req, ctx) {
  const a = authBokare(req, ctx), bokare = a.bokare;
  const id = typeof req.reservationId === 'string' ? req.reservationId : '';
  withScriptLock(() => {
    const r = getReservation(id);
    if (r && r.bokareId === bokare.id) releaseOwnReservation(ctx);
  });
  return {};
}

// ============================================================
// Endpoint: book (4.4 – ordning 1–7)
// ============================================================

// Hård indatavalidering före låset. Samlar alla fältfel och kastar E_VALIDATION med details.falt (statiska texter).
// initialFalt = redan funna fel (starttiden, parseStartField) så att klienten får alla fältfel i ett svar.
function validateBookInput(req, config, bokare, typ, initialFalt) {
  const falt = Object.assign({}, isPlainObject(initialFalt) ? initialFalt : {});
  const karna = config.formular.karna || {};
  const kravs = namn => isPlainObject(karna[namn]) && karna[namn].synlig !== false && karna[namn].obligatorisk === true;
  const text = (v, namn, max, obligatorisk, min) => {
    if (v === undefined || v === null) v = '';
    if (typeof v !== 'string') { falt[namn] = 'Ogiltigt värde'; return ''; }
    const s = cleanText(v);
    if (s.length > max) { falt[namn] = 'För långt värde'; return s.slice(0, max); }
    if (obligatorisk && !s) { falt[namn] = 'Obligatoriskt'; return s; }
    if (s && min && s.length < min) { falt[namn] = 'För kort värde'; return s; }
    return s;
  };
  const kund = isPlainObject(req.kund) ? req.kund : {};
  const kontakt = isPlainObject(req.kontakt) ? req.kontakt : {};

  const kundnamn = text(kund.namn, 'kundnamn', MAXLEN.kundnamn, true, 2);
  const orgnrRaw = text(kund.orgnr, 'orgnr', MAXLEN.orgnr, bokare.arCj !== true);
  let orgnr = '';
  if (!falt.orgnr && orgnrRaw) { orgnr = normalizeOrgnr(orgnrRaw); if (!orgnr) falt.orgnr = 'Ogiltigt organisationsnummer'; }

  // Adress tvingas vid restid, e-post utan restid – oavsett formulärets inställning (3.5, A24).
  const adress = text(req.adress, 'adress', MAXLEN.adress, typ.restid === true || kravs('adress'));
  const kontaktNamn = text(kontakt.namn, 'kontaktperson', MAXLEN.kontaktperson, kravs('kontaktperson'));
  const telefon = text(kontakt.telefon, 'telefon', MAXLEN.telefon, kravs('telefon'));
  if (!falt.telefon && kravs('telefon') && normalizePhone(telefon).length < 8) falt.telefon = 'Ange ett giltigt telefonnummer';
  const epostRaw = text(kontakt.epost, 'epost', MAXLEN.epost, typ.restid !== true || kravs('epost'));
  const epost = normalizeEmail(epostRaw);
  if (!falt.epost && epost && !EPOST_RE.test(epost)) falt.epost = 'Ange en giltig e-postadress';
  const notering = text(req.notering, 'notering', MAXLEN.notering, kravs('notering'));

  // Extrafält: objekt av strängar, bara kända (synliga) id:n, typregler, obligatoriskhet.
  const extrafalt = {};
  const defs = config.formular.extrafalt.filter(d => isPlainObject(d) && typeof d.id === 'string' && d.synlig !== false);
  const inExtra = req.extrafalt === undefined || req.extrafalt === null ? {} : req.extrafalt;
  if (!isPlainObject(inExtra)) falt.extrafalt = 'Ogiltigt värde';
  else {
    Object.keys(inExtra).forEach(id => {
      if (id === '_kundId') {
        if (bokare.arCj === true) {
          const v = inExtra[id];
          if (typeof v === 'string' && KUND_ID_RE.test(v)) extrafalt._kundId = v;
          else if (v !== '' && v !== null && v !== undefined) falt._kundId = 'Ogiltigt värde';
        }
        return;   // ignoreras tyst för bokare utan arCj
      }
      const def = defs.find(d => d.id === id);
      if (!def) { falt.extrafalt = 'Okänt fält'; return; }   // fältets id ekas aldrig – inte ens som nyckel (9.6)
      const v = inExtra[id];
      if (typeof v !== 'string') { falt[id] = 'Ogiltigt värde'; return; }
      const s = cleanText(v);
      if (def.typ === 'fritext') { if (s.length > MAXLEN.fritext) { falt[id] = 'För långt värde'; return; } }
      else if (def.typ === 'dropdown') { if (s && (!Array.isArray(def.alternativ) || def.alternativ.indexOf(s) < 0)) { falt[id] = 'Ogiltigt val'; return; } }
      else if (def.typ === 'janej') { if (s && s !== 'ja' && s !== 'nej') { falt[id] = 'Ogiltigt val'; return; } }
      else { if (s.length > MAXLEN.kort) { falt[id] = 'För långt värde'; return; } }
      extrafalt[id] = s;
    });
    defs.forEach(def => { if (def.obligatorisk === true && !extrafalt[def.id] && !falt[def.id]) falt[def.id] = 'Obligatoriskt'; });
  }

  const clientBokningId = typeof req.clientBokningId === 'string' && CLIENT_BOKNING_ID_RE.test(req.clientBokningId) ? req.clientBokningId : '';
  if (!clientBokningId) falt.clientBokningId = 'Ogiltig förfrågan – ladda om sidan';

  if (Object.keys(falt).length) valideringsfel(falt);
  return {
    kund: { namn: kundnamn, orgnr: orgnr },
    kontakt: { namn: kontaktNamn, telefon: telefon, epost: epost },
    adress: adress, notering: notering, extrafalt: extrafalt, clientBokningId: clientBokningId
  };
}

function handleBook(req, ctx) {
  // 1. Kod → E_KEY (anropsgränser i authBokare).
  const a = authBokare(req, ctx), bokare = a.bokare, config = a.config, inst = config.installningar;
  const typ = resolveMotestyp(config, bokare, req.motestypId, null);
  // 2. Hård indatavalidering före låset. Startfel samlas i samma falt-objekt som övriga fältfel.
  let st = null, startFalt = null;
  try { st = parseStartField(req.start, inst, typ); }
  catch (e) { if (errorCode(e) !== 'E_VALIDATION') throw e; startFalt = e.details && e.details.falt ? e.details.falt : { start: 'Ogiltig starttid' }; }
  const input = validateBookInput(req, config, bokare, typ, startFalt);
  const reservationId = typeof req.reservationId === 'string' ? req.reservationId.slice(0, 64) : '';
  if (typ.restid && input.adress) checkAdressLimits(ctx, input.adress);
  const slutIso = toIsoWithOffset(st.datum, minToTid(tidToMin(st.tid) + typ.langdMin));
  // Geokodning och dagsberäkning (utan färsk kalenderläsning) FÖRE låset värmer cacherna: geocodeAddress, ICS,
  // ankare och Distance Matrix blir cache-träffar inuti låset, som då bara gör Calendar.Events.list + Drive.
  // updateCacheFile (Availability.gs) tar INGET lås – nästla aldrig withScriptLock.
  const geo = typ.restid ? geoForBooking(input.adress, ctx) : { lat: null, lng: null, formaterad: '', status: 'saknas' };
  const egenFore = getReservation(reservationId);
  warmSlotCaches(bokare, config, typ, input.adress, st, egenFore && egenFore.bokareId === bokare.id ? egenFore.id : ownReservationId(ctx));

  let bokning = null, ny = false;
  withScriptLock(() => {
    // 3. Idempotens: samma clientBokningId + bokare → befintlig bokning som ok:true – FÖRE handlingsgränser, paus och
    //    luckkontroll, så att sajtens retry efter E_ABORT/E_NETWORK aldrig får E_RATE/E_PAUSED för ett möte som finns.
    const inbox = readInbox();
    const befintlig = inbox.bokningar.find(b => b.clientBokningId === input.clientBokningId && b.bokareId === bokare.id);
    if (befintlig) { bokning = befintlig; return; }

    // 3b. Handlingsgränser → E_RATE; paus → E_PAUSED (bara CacheService/Properties/config – ingen nätverks-I/O).
    checkBookLimits(ctx);
    pausCheck(inst, st.datum);

    // 4. Räkna om dagen med färsk kalenderläsning: utan egen reservation, med andras (5.11). Egen reservation =
    //    den som skickades i reservationId om den är aktiv och bokarens, annars bokarens aktuella (res:owner) –
    //    så att ett saknat/utgånget id efter en misslyckad tyst omreservation inte gör bokarens egen lucka till hinder.
    const egen = getReservation(reservationId);
    const egenAktiv = egen && egen.bokareId === bokare.id ? egen : null;
    const egenId = egenAktiv ? egenAktiv.id : ownReservationId(ctx);
    const slot = findSlot(bokare, config, typ, input.adress, st, egenId, '', true, inbox);   // inkorgen läses en gång under låset
    if (!slot || slot.status !== 'ledig') fel(reservationId && !egenAktiv ? 'E_RESERVATION_EXPIRED' : 'E_SLOT_TAKEN');

    const ts = nowIso();
    bokning = {
      bokningId: Utilities.getUuid(), clientBokningId: input.clientBokningId, rev: 1, status: 'ny',
      bokareId: str(bokare.id), pipelineId: str(bokare.pipelineId), motestypId: typ.id,
      start: st.iso, slut: slutIso,
      adress: input.adress, geo: geo, restid: restidFromSlot(slot, typ, geo),
      kund: input.kund, kontakt: input.kontakt, notering: input.notering, extrafalt: input.extrafalt,
      kalenderEventId: '', skapad: ts,
      importeradAt: null, importeradAv: null, andradAt: null, plan: null,
      historik: [{ ts: ts, typ: 'bokad', av: str(bokare.namn) }]
    };

    // 5. Kalenderhändelse (E_CALENDAR – inget skrivet).
    const calId = bokningarKalenderId(inst);
    const ev = createBookingEvent(config, bokare, typ, bokning, calId);
    bokning.kalenderEventId = str(ev && ev.id);

    // 6. Inkorgen – misslyckas den tas händelsen bort igen (best effort) → E_INTERNAL.
    try {
      inbox.bokningar.push(bokning);
      writeInbox(inbox);
    } catch (e) {
      try { Calendar.Events.remove(calId, bokning.kalenderEventId, { sendUpdates: 'all' }); } catch (e2) { /* best effort */ }
      fel('E_INTERNAL', 'Bokningen kunde inte sparas – inget har bokats');
    }
    releaseOwnReservation(ctx);
    countBooking(ctx);
    ny = true;
  });

  // 7. Utanför låset: notismejl till CJ. Bekräftelsetexten renderas på bokningssidan.
  if (ny) notifyCj(config, bokare, typ, bokning);
  return { bokningId: bokning.bokningId, start: bokning.start, slut: bokning.slut, kalenderEventId: bokning.kalenderEventId, restid: bokning.restid, bokning: bokning };
}

// ============================================================
// Kalenderskrivning (4.7) – Calendar advanced service v3
// ============================================================

function createBookingEvent(config, bokare, typ, bokning, calId) {
  const inst = config.installningar;
  const kalenderId = calId || bokningarKalenderId(inst);
  const s = v => String(v || '').replace(/[<>]/g, ' ');   // aldrig HTML i kalender/Outlook
  const kontakt = isPlainObject(bokning.kontakt) ? bokning.kontakt : {};
  const kund = isPlainObject(bokning.kund) ? bokning.kund : {};
  const resurs = {
    summary: s(typ.titel) + ': ' + s(kund.namn),
    location: s(bokning.adress),
    description: 'Bokad av: ' + s(bokare.namn) + '\nBokningId: ' + bokning.bokningId +
                 (inst.kontaktuppgifterIKalender === true
                   ? '\nKontakt: ' + s(kontakt.namn) + ', ' + s(kontakt.telefon) + ', ' + s(kontakt.epost)
                   : '\nKontakt: ' + s(kontakt.namn)) +
                 (bokning.notering ? '\nNotering: ' + s(bokning.notering) : ''),
    start: { dateTime: bokning.start, timeZone: TZ },
    end:   { dateTime: bokning.slut,  timeZone: TZ },
    guestsCanInviteOthers: false, guestsCanSeeOtherGuests: false,
    extendedProperties: { private: {
      bokningId: String(bokning.bokningId), bokareId: String(bokning.bokareId || ''),
      pipelineId: String(bokning.pipelineId || ''), motestypId: String(bokning.motestypId || '') } }
  };
  // Telexia-adressen som gäst → Outlook får inbjudan/uppdatering/avbokning. Tom adress → ingen gäst (API:t avvisar tom e-post).
  if (inst.telexiaEpost) resurs.attendees = [{ email: String(inst.telexiaEpost) }];
  let ev = null;
  try { ev = Calendar.Events.insert(resurs, kalenderId, { sendUpdates: 'all' }); }
  catch (e) { ev = null; }
  if (!ev || !ev.id) fel('E_CALENDAR');
  return ev;
}

// ============================================================
// E-post (4.9) – plain text, minimerat innehåll
// ============================================================

function notifyCj(config, bokare, typ, bokning) {
  const inst = config.installningar;
  if (!inst.notisEpost) return;
  const s = v => String(v || '').replace(/[<>]/g, ' ');
  const p = fromIso(bokning.start), slutTid = fromIso(bokning.slut).tid;
  const rs = bokning.restid && bokning.restid.status;
  // Raden väljs på mötestypens restid-flagga (inkorgspostens status är 'ok' med 0/0 för typer utan restid, 4.1).
  let restidRad = 'OBS: restid okänd – kontrollera adressen';
  if (typ.restid !== true) restidRad = 'ingen (möte utan restid)';
  else if (rs === 'ok') restidRad = 'ok (' + bokning.restid.foreMin + ' min före, ' + bokning.restid.efterMin + ' min efter)';
  else if (rs === 'schablon') restidRad = 'schablon – Maps gav inget svar';
  const subject = 'Ny bokning: ' + s(typ.titel) + ' ' + p.datum + ' ' + p.tid;
  const body = [
    'Ny bokning i Pipeline.',
    '',
    'Kund: ' + s(bokning.kund && bokning.kund.namn),
    'Bokare: ' + s(bokare.namn) + (bokare.organisation ? ' (' + s(bokare.organisation) + ')' : ''),
    'Mötestyp: ' + s(typ.titel),
    'Tid: ' + longDateLabel(p.datum) + ' kl ' + p.tid + '–' + slutTid,
    'Restid: ' + restidRad,
    '',
    'Öppna Pipeline: ' + APP_URL,
    'Bokningsnummer: ' + bokning.bokningId
  ].join('\n');
  try { MailApp.sendEmail({ to: String(inst.notisEpost), subject: subject, body: body, name: 'Pipeline bokning' }); }
  catch (e) { loggaMejlfel(bokning.bokningId); }
}
// Mejlfel fäller aldrig bokningen – historikposten skrivs best effort under lås.
function loggaMejlfel(bokningId) {
  try {
    withScriptLock(() => {
      const inbox = readInbox();
      const b = findBokningInInbox(inbox, bokningId);
      if (!b) return;
      if (!Array.isArray(b.historik)) b.historik = [];
      b.historik.push({ ts: nowIso(), typ: 'mejlfel', av: 'script' });
      writeInbox(inbox);
    }, 5000);
  } catch (e) { /* best effort */ }
}

// ============================================================
// Endpoint: geocode (4.4) – k eller adminKey
// ============================================================

function handleGeocode(req, ctx) {
  let bokare = null;
  if (typeof req.k === 'string' && req.k) bokare = authBokare(req, ctx).bokare;
  else if (typeof req.adminKey === 'string' && req.adminKey) authAdmin(req, ctx);
  else badKod();
  const adress = strField(req.adress, 'adress', MAXLEN.adress, true);
  if (adress.length < 3) valideringsfel({ adress: 'Ange en adress' });
  if (bokare) checkAdressLimits(ctx, adress);
  const g = geoForBooking(adress, bokare ? ctx : null);
  return { status: g.status === 'ok' ? 'ok' : 'okand', lat: g.lat, lng: g.lng, formaterad: g.formaterad };
}

// ============================================================
// Admin-endpoints (4.4) – autentiseras med adminKey (authAdmin: ~60/min, konstanttidsjämförelse).
// M3: setup, config-push, calendars-list, inbox-list, ack, reject. M4: calendar-preview, rebook, cancel. M5: purge.
// ============================================================

// ---------- setup (4.2, 4.4, 10.1 steg 4c) ----------
// In:  { adminKey, fileIds:{ config, inbox, cache } }  (även spec-formen { configFileId, inboxFileId, cacheFileId })
// Ut:  { version, scriptVersion, konfigurerad:true, ownerEmail, kalendrar:[{ id, summary, namn, primary, primar, accessRole }] }
// Adminnyckeln (4.5, 10.1 steg 4b): genereras av appen och klistras in av CJ i Script Properties INNAN setup körs.
// Saknas ADMIN_KEY → E_SETUP (scriptet sätter aldrig nyckeln själv – annars kunde den som känner till tre fil-id:n
// "ta" nyckeln i fönstret mellan deploy och inklistring). Finns den krävs exakt den (E_ADMIN, konstanttidsjämförelse).
// Kan köras om (Återanslut): verifierar, sparar id:n, tömmer cacher, seedar tomma filer, skapar triggern idempotent.
function handleSetup(req, ctx) {
  if (bumpCounter('rl:admin:m' + minuteWindow(), 120) > RL_ADMIN_PER_MIN) fel('E_RATE', undefined, { typ: 'anrop' });
  const befintlig = getProp(PROP.ADMIN_KEY);
  if (!befintlig) fel('E_SETUP', 'Adminnyckel saknas i Script Properties');
  const given = typeof req.adminKey === 'string' ? req.adminKey : '';
  if (!given || given.length > 256 || !constantTimeEqual(given, befintlig)) fel('E_ADMIN');
  ctx.bokareId = 'admin';

  const ids = setupFileIds(req);
  const filer = {};
  BREVLADA_ROLLER.forEach(r => {
    const roll = r[0];
    try { filer[roll] = verifyBrevladaFile(ids[roll], { farsk: true }); }
    catch (e) { if (errorCode(e) !== 'E_SETUP') throw e; throw apiError('E_SETUP', e.message, { fil: roll }); }
  });

  setProp(PROP.CONFIG_FILE_ID, ids.config);
  setProp(PROP.INBOX_FILE_ID, ids.inbox);
  setProp(PROP.CACHE_FILE_ID, ids.cache);
  clearSetupCache();
  clearConfigCache();
  withScriptLock(() => {
    seedBrevladaFile(filer.config, 'config', { bokare: [], motestyper: [], formular: deepClone(DEFAULT_BOKNINGSFORMULAR), installningar: {}, ignorerade: [], pipelines: [] });
    seedBrevladaFile(filer.inbox, 'inbox', { bokningar: [] });
    seedBrevladaFile(filer.cache, 'cache', { geokod: {}, restid: {}, icsReserv: null });
  });
  install();

  let kalendrar = [];
  try { kalendrar = listCalendars(); } catch (e) { kalendrar = []; }   // best effort – Anslut-guiden kan hämta om via calendars-list
  return { version: SCRIPT_VERSION, scriptVersion: SCRIPT_VERSION, konfigurerad: true, ownerEmail: Session.getEffectiveUser().getEmail(), kalendrar: kalendrar };
}
function setupFileIds(req) {
  const f = isPlainObject(req.fileIds) ? req.fileIds : {};
  const ids = {
    config: typeof f.config === 'string' ? f.config : str(req.configFileId),
    inbox: typeof f.inbox === 'string' ? f.inbox : str(req.inboxFileId),
    cache: typeof f.cache === 'string' ? f.cache : str(req.cacheFileId)
  };
  const falt = {};
  ['config', 'inbox', 'cache'].forEach(k => { if (!FIL_ID_RE.test(ids[k])) falt[k] = 'Ogiltigt fil-id'; });
  if (Object.keys(falt).length) valideringsfel(falt);
  if (ids.config === ids.inbox || ids.config === ids.cache || ids.inbox === ids.cache) valideringsfel({ fileIds: 'Samma fil angiven två gånger' });
  return ids;
}
// Tom fil ('' / '{}' / 'null') → initial struktur med gemensamt huvud (4.1). Annat innehåll måste vara ett JSON-objekt.
function seedBrevladaFile(file, roll, seed) {
  const text = String(file.getBlob().getDataAsString('UTF-8') || '').trim();
  if (text === '' || text === '{}' || text === 'null') {
    file.setContent(JSON.stringify(Object.assign({ schemaVersion: 1, rev: 0, updatedAt: nowIso(), updatedBy: 'script' }, seed)));
    return true;
  }
  let obj = null;
  try { obj = JSON.parse(text); } catch (e) { obj = null; }
  if (!isPlainObject(obj)) throw apiError('E_SETUP', 'Brevlådefilen innehåller inte giltig JSON', { fil: roll });
  return false;
}

// ---------- config-push (4.4, 6.7 pushBokningConfig) ----------
// In:  { adminKey, rev }   (rev = det revisionsnummer appen just skrev i config-filen)
// Ut:  { ok:true, rev:<läst rev>, configRev:<läst rev>, varningar:[] }
// Fel: E_STATE med details.configRev (= läst rev) när filens rev < begärd rev (Drive har inte hunnit ikapp, spec 4.3/4.4)
//      – appen försöker om efter 2 s, max 3 gånger. En NYARE fil-rev än begärd är ok (en senare push har landat).
function handleConfigPush(req, ctx) {
  authAdmin(req, ctx);
  const rev = req.rev;
  if (!(typeof rev === 'number' && Number.isInteger(rev) && rev >= 0)) valideringsfel({ rev: 'Ogiltigt värde' });
  clearConfigCache();
  const cfg = loadConfig(ctx, { farsk: true });
  if (cfg.rev < rev) throw apiError('E_STATE', 'Brevlådans konfiguration är äldre än begärd version – försök igen', { configRev: cfg.rev });
  return { ok: true, rev: cfg.rev, configRev: cfg.rev, varningar: configVarningar(cfg) };
}
// Statiska varningstexter (4.4): aldrig värden ur config (ICS-url refereras som "fältet Outlook-ICS").
function configVarningar(cfg) {
  const v = [], inst = cfg.installningar;
  const kal = Array.isArray(inst.kalendrar) ? inst.kalendrar.filter(isPlainObject) : [];
  const fullt = kal.filter(k => k.lage === 'fullt').length;
  if (fullt !== 1) v.push('Exakt en kalender ska ha läget Bokningar (fullt) – nu ' + fullt);
  if (inst.outlookIcsUrl && !/^https:\/\/\S+$/i.test(String(inst.outlookIcsUrl))) v.push('Fältet Outlook-ICS är inte en https-adress');
  const utanPipeline = cfg.bokare.filter(b => !b.pipelineId).length;
  if (utanPipeline) v.push('Bokare utan pipeline: ' + utanPipeline);
  const utanKod = cfg.bokare.filter(b => b.aktiv === true && !(typeof b.kodHash === 'string' && /^[0-9a-f]{64}$/.test(b.kodHash))).length;
  if (utanKod) v.push('Aktiva bokare utan giltig kodhash: ' + utanKod);
  const typUtan = cfg.motestyper.filter(t => t.global !== true && !t.pipelineId).length;
  if (typUtan) v.push('Mötestyper utan pipeline som inte är globala: ' + typUtan);
  const okandaPl = cfg.bokare.filter(b => b.pipelineId && !cfg.pipelines.some(p => p.id === b.pipelineId)).length;
  if (okandaPl) v.push('Bokare med okänd pipeline: ' + okandaPl);
  if (kal.some(k => k.lage === 'tider' || k.lage === 'fullt')) {
    try {
      const kanda = listCalendars().map(k => k.id);
      kal.filter(k => (k.lage === 'tider' || k.lage === 'fullt') && kanda.indexOf(String(k.id)) < 0)
         .forEach(k => v.push('Okänd kalender: ' + String(k.namn || k.id).replace(/[<>]/g, ' ').slice(0, 80)));
    } catch (e) { v.push('Kalenderlistan kunde inte hämtas för kontroll'); }
  }
  return v;
}

// ---------- calendars-list (4.4) ----------
// In:  { adminKey }   Ut: { kalendrar:[{ id, summary, namn, primary, primar, accessRole }] } – primär först, sedan namn.
function handleCalendarsList(req, ctx) {
  authAdmin(req, ctx);
  let lista = [];
  try { lista = listCalendars(); } catch (e) { fel('E_CALENDAR', 'Kalenderlistan kunde inte hämtas'); }
  return { kalendrar: lista };
}
function listCalendars() {
  const out = [];
  let pageToken = null, guard = 0;
  do {
    const params = { maxResults: 250 };
    if (pageToken) params.pageToken = pageToken;
    const res = Calendar.CalendarList.list(params);
    (res && res.items ? res.items : []).forEach(k => {
      if (!k || !k.id || k.deleted === true) return;
      const namn = str(k.summaryOverride) || str(k.summary) || str(k.id);
      out.push({ id: String(k.id), summary: namn, namn: namn, primary: k.primary === true, primar: k.primary === true, accessRole: str(k.accessRole) });
    });
    pageToken = res && res.nextPageToken ? res.nextPageToken : null;
  } while (pageToken && guard++ < 20);
  return out.sort((a, b) => (a.primary === b.primary ? 0 : a.primary ? -1 : 1) || a.summary.localeCompare(b.summary, 'sv'));
}

// ---------- inbox-list (4.4, 6.2, 8.2 reserv) ----------
// In:  { adminKey, status?: 'ny' | ['ny','importerad',…], limit?: 1–500 (default 200) }
// Ut:  { bokningar:[ inkorgsposter, nyaste först (skapad) ], antal:<antal som matchar filtret>, totalt:<alla i filen>, rev:<inkorgens rev> }
function handleInboxList(req, ctx) {
  authAdmin(req, ctx);
  let statusar = null;
  if (req.status !== undefined && req.status !== null && req.status !== '') {
    const arr = Array.isArray(req.status) ? req.status : [req.status];
    if (!arr.length || !arr.every(s => typeof s === 'string' && INBOX_STATUSAR.indexOf(s) >= 0)) valideringsfel({ status: 'Ogiltigt värde' });
    statusar = arr;
  }
  let limit = INBOX_LIST_DEFAULT;
  if (req.limit !== undefined && req.limit !== null) {
    if (!(typeof req.limit === 'number' && Number.isInteger(req.limit) && req.limit >= 1 && req.limit <= INBOX_LIST_MAX)) valideringsfel({ limit: 'Ogiltigt värde' });
    limit = req.limit;
  }
  const inbox = readInbox();
  const urval = inbox.bokningar
    .filter(b => !statusar || statusar.indexOf(b.status) >= 0)
    .sort((a, b) => String(b.skapad || '').localeCompare(String(a.skapad || '')));
  return { bokningar: urval.slice(0, limit).map(inboxExport), antal: urval.length, totalt: inbox.bokningar.length, rev: Number(inbox.rev) || 0 };
}
// Inkorgsposter innehåller inga koder/hashar (4.1) – fälten tas bort defensivt om de någonsin skulle finnas.
function inboxExport(b) { const c = deepClone(b); delete c.kodHash; delete c.kod; delete c.adminKey; return c; }

// ---------- ack (4.4, 8.2 steg 4 – claim-modellen) ----------
// In:  { adminKey, enhetId, bokningIds:[…] }  (även spec-formen { deviceId, bokningar:[{ bokningId, leadId, eventId, kundId,
//      kontaktId, nyProcess, nyKund, mojligDubblett }] } – planen lagras då på posten som `plan`)
// Ut:  { resultat:[{ bokningId, claimed, status, importeradAv, importeradTs, saknad?, plan? }],
//        claimed:[bokningId], alreadyClaimed:[{ bokningId, importeradAv, importeradTs, plan }], missing:[bokningId] }
// Under lås: 'ny' → 'importerad' (importeradTs/importeradAt, importeradAv = enhetId) → claimed:true; redan importerad av
// någon enhet → claimed:false med importeradAv; okänd → claimed:false, saknad:true; avvisad/avbokad → claimed:false med status.
// Idempotent: samma enhet som redan importerat får claimed:false (posten finns lokalt, avstämningen 8.2 steg 6 hanterar den).
function handleAck(req, ctx) {
  authAdmin(req, ctx);
  const enhetId = typeof req.enhetId === 'string' ? req.enhetId : str(req.deviceId);
  if (!ENHET_ID_RE.test(enhetId)) valideringsfel({ enhetId: 'Ogiltigt värde' });
  const ids = [], planer = {};
  if (req.bokningIds !== undefined && !Array.isArray(req.bokningIds)) valideringsfel({ bokningIds: 'Ogiltigt värde' });
  (req.bokningIds || []).forEach(id => ids.push(id));
  if (req.bokningar !== undefined && !Array.isArray(req.bokningar)) valideringsfel({ bokningar: 'Ogiltigt värde' });
  (req.bokningar || []).forEach(p => { if (!isPlainObject(p)) valideringsfel({ bokningar: 'Ogiltigt värde' }); ids.push(p.bokningId); planer[String(p.bokningId)] = ackPlan(p); });
  if (!ids.length) valideringsfel({ bokningIds: 'Obligatoriskt' });
  if (ids.length > ACK_MAX_IDS) valideringsfel({ bokningIds: 'För många' });
  if (!ids.every(id => typeof id === 'string' && BOKNING_ID_RE.test(id))) valideringsfel({ bokningIds: 'Ogiltigt värde' });
  const unika = ids.filter((id, i) => ids.indexOf(id) === i);

  const resultat = [];
  withScriptLock(() => {
    const inbox = readInbox();
    const ts = nowIso();
    let andrad = false;
    unika.forEach(id => {
      const b = findBokningInInbox(inbox, id);
      if (!b) { resultat.push({ bokningId: id, claimed: false, saknad: true, status: '', importeradAv: '', importeradTs: '' }); return; }
      if (b.status === 'ny') {
        b.status = 'importerad';
        b.importeradTs = ts; b.importeradAt = ts; b.importeradAv = enhetId;
        if (planer[id]) b.plan = planer[id];
        if (!Array.isArray(b.historik)) b.historik = [];
        b.historik.push({ ts: ts, typ: 'importerad', av: enhetId });
        andrad = true;
        resultat.push({ bokningId: id, claimed: true, status: 'importerad', importeradAv: enhetId, importeradTs: ts, plan: b.plan || null });
        return;
      }
      resultat.push({ bokningId: id, claimed: false, status: str(b.status), importeradAv: str(b.importeradAv), importeradTs: str(b.importeradTs || b.importeradAt), plan: isPlainObject(b.plan) ? b.plan : null });
    });
    if (andrad) writeInbox(inbox);
  });
  return {
    resultat: resultat,
    claimed: resultat.filter(r => r.claimed).map(r => r.bokningId),
    alreadyClaimed: resultat.filter(r => !r.claimed && r.status === 'importerad').map(r => ({ bokningId: r.bokningId, importeradAv: r.importeradAv, importeradTs: r.importeradTs, plan: r.plan })),
    missing: resultat.filter(r => r.saknad).map(r => r.bokningId)
  };
}
function ackPlan(p) {
  const plan = {};
  ['leadId', 'eventId', 'kundId', 'kontaktId'].forEach(k => { plan[k] = typeof p[k] === 'string' && PLAN_ID_RE.test(p[k]) ? p[k] : ''; });
  ['nyProcess', 'nyKund', 'mojligDubblett'].forEach(k => { plan[k] = p[k] === true; });
  return plan;
}

// ---------- reject (4.4, 4.7, 4.9, 6.2 Avvisa) ----------
// In:  { adminKey, bokningId, orsak? }
// Ut:  { ok:true, bokningId, status:'avvisad', kalenderBorttagen, kalenderFel, mejlSkickat, bokning }
// Från 'ny'/'importerad' (annars E_STATE, details.status); okänd → E_NOT_FOUND. Under lås: Calendar.Events.remove
// (sendUpdates 'all'; 404/410 = redan borta = lyckat; annat fel → status sätts ändå + historik 'kalenderfel' och
// kalenderFel:true i svaret enligt spec 4.7 – appen ska visa varningen; Kalenderkoll (M4) flaggar posten), status
// 'avvisad', avvisadTs/avvisadOrsak/andradAt, historik. Utanför låset: plain text-mejl till bokaren om bokare.epost finns (A25).
function handleReject(req, ctx) {
  authAdmin(req, ctx);
  const bokningId = typeof req.bokningId === 'string' ? req.bokningId : '';
  if (!BOKNING_ID_RE.test(bokningId)) valideringsfel({ bokningId: 'Ogiltigt värde' });
  const orsak = strField(req.orsak, 'orsak', ORSAK_MAX, false);
  const config = loadConfig(ctx);
  let bokning = null, kal = { borttagen: false, fel: false };
  withScriptLock(() => {
    const inbox = readInbox();
    const b = findBokningInInbox(inbox, bokningId);
    if (!b) fel('E_NOT_FOUND');
    if (b.status !== 'ny' && b.status !== 'importerad') fel('E_STATE', undefined, { status: str(b.status) });
    const ts = nowIso();
    kal = removeBookingEvent(config, b.kalenderEventId);
    b.status = 'avvisad';
    b.avvisadTs = ts; b.avvisadOrsak = orsak; b.andradAt = ts;
    if (!Array.isArray(b.historik)) b.historik = [];
    b.historik.push({ ts: ts, typ: 'avvisad', av: 'CJ', orsak: orsak });
    if (kal.fel) b.historik.push({ ts: ts, typ: 'kalenderfel', av: 'script' });
    writeInbox(inbox);
    clearBusyCacheFor(b);   // busy:<datum> (60 s) ska inte visa den borttagna händelsen som upptaget
    bokning = b;
  });
  const mejlSkickat = notifyBokareAvvisad(config, bokning, orsak);
  return { ok: true, bokningId: bokningId, status: 'avvisad', kalenderBorttagen: kal.borttagen, kalenderFel: kal.fel, mejlSkickat: mejlSkickat, bokning: bokning };
}
// Tömmer Calendar.gs dagscache (busy:<datum>, 4.6) för bokningens dagar efter en ändring i kalendern.
function clearBusyCacheFor(bokning) {
  try {
    const a = fromIso(bokning.start).datum, z = fromIso(bokning.slut).datum;
    if (!a) return;
    const keys = [];
    for (let d = a, g = 0; d <= (z || a) && g < 8; d = addDays(d, 1), g++) keys.push('busy:' + d);
    CacheService.getScriptCache().removeAll(keys);
  } catch (e) { /* cache är en optimering */ }
}
// Tar bort bokningens kalenderhändelse (4.7). → { borttagen, fel }. Ingen händelse-id → inget att ta bort.
function removeBookingEvent(config, kalenderEventId) {
  if (!kalenderEventId) return { borttagen: false, fel: false };
  let calId = '';
  try { calId = bokningarKalenderId(config.installningar); } catch (e) { return { borttagen: false, fel: true }; }
  try { Calendar.Events.remove(calId, String(kalenderEventId), { sendUpdates: 'all' }); return { borttagen: true, fel: false }; }
  catch (e) { return calendarEventGone(e) ? { borttagen: true, fel: false } : { borttagen: false, fel: true }; }
}
// HTTP 410 (Resource has been deleted) och 404 (Not Found) = händelsen är redan borta = lyckat (4.7, V8).
function calendarEventGone(e) {
  const code = e && e.details && Number(e.details.code);
  if (code === 410 || code === 404) return true;
  return /\b(410|404)\b|has been deleted|not found/i.test(String(e && e.message || ''));
}
// Mejl till bokaren efter avvisning (4.9, A25): plain text med kundnamn, tid, orsak och "Du kontaktar kunden.". Aldrig kontaktuppgifter.
function notifyBokareAvvisad(config, bokning, orsak) {
  const bokare = config.bokare.find(b => b.id === bokning.bokareId) || null;
  const epost = bokare ? normalizeEmail(bokare.epost) : '';
  if (!epost || !EPOST_RE.test(epost)) return false;
  const s = v => String(v || '').replace(/[<>]/g, ' ');
  const typ = config.motestyper.find(t => t.id === bokning.motestypId) || {};
  const p = fromIso(bokning.start), slutTid = fromIso(bokning.slut).tid;
  const subject = 'Bokning avvisad: ' + s(bokning.kund && bokning.kund.namn) + ' ' + p.datum + ' ' + p.tid;
  const body = [
    'Hej ' + s(bokare.namn) + '!',
    '',
    'CJ har avvisat bokningen nedan. Inbjudan är borttagen ur kalendern.',
    '',
    'Kund: ' + s(bokning.kund && bokning.kund.namn),
    'Mötestyp: ' + s(typ.titel || bokning.motestypId),
    'Tid: ' + longDateLabel(p.datum) + ' kl ' + p.tid + '–' + slutTid,
    'Orsak: ' + (orsak ? s(orsak) : '(ingen orsak angiven)'),
    '',
    'Du kontaktar kunden.',
    '',
    'Bokningsnummer: ' + String(bokning.bokningId)
  ].join('\n');
  try { MailApp.sendEmail({ to: epost, subject: subject, body: body, name: 'Pipeline bokning' }); return true; }
  catch (e) { loggaMejlfel(bokning.bokningId); return false; }
}

// ---------- calendar-preview (4.4, 4.6, 6.3 Kalenderkoll) – M4 ----------
// In:  { adminKey, from, to }  ('YYYY-MM-DD' inklusive; även spec-formen { fran, till }). Högst PREVIEW_MAX_DAGAR (8 veckor),
//      fönstret måste ligga inom [idag−7, horisont+7] (E_VALIDATION, falt.from/to).
// Ut:  { from, to, idag, horisontTom, genererad,
//        handelser:[{ id, ignoreraId, matchIds, kalla:'bokningar'|'privat'|'ics'|'reservation', datum, start, slut, heldag,
//                     titel, plats, hasPlace, restid, cooldownMin, preliminar, raknad, ignorerad, bokningId, bokareId, motestypId,
//                     sammanslagenMed:[], varning, varningar:[] }],
//        icsStatus:{ ok, hamtadTs, antal, medPlats, preliminara }, obesvarade, varningar:[] }
// Exakt det scriptet ser efter sammanslagning (buildBusyList med ALLA källor: Google 'tider'/'fullt', Outlook-ICS, inkorgens
// bokningar, aktiva reservationer). Ignorerade händelser är MED (ignorerad:true) i stället för uteslutna; preliminära ICS-poster
// är med (preliminar:true, raknad enligt config). En händelse över midnatt ger ett segment per dag (samma id, olika datum).
// Regel för titel/plats (4.6, 9): bara för kalendrar med läge 'fullt' (kalla 'bokningar'), Outlook-ICS och reservationer –
// ALDRIG för läge 'tider' (kalla 'privat'): där är titel/plats alltid '' (hasPlace/restid är bara boolska). Inga kundnamn ur
// inkorgen (appen har dem lokalt) – bokningId räcker för att matcha. `id` = intern busy-id (unik per segment, prefix anger källa,
// används i sammanslagenMed); `ignoreraId` = det id KALENDER_IGNORERA ska lagra (Google event-id / ICS UID / bokningens
// kalenderhändelse-id), `matchIds` = alla id:n posten matchas på (event-id, recurringEventId, UID). Varningar: ICS-fel,
// "Många obesvarade …", Maps-varning, avstämningens "saknas i inkorgen" (4.11, fylls av dailyMaintenance – Script Property + CacheService),
// "N avbokade/avvisade möten ligger kvar i kalendern" (4.7: händelse vars bokningId är avbokad/avvisad i inkorgen, t.ex. efter
// misslyckad Calendar.Events.remove – posten får varning "Avbokad/Avvisad i inkorgen men händelsen finns kvar …").
function handleCalendarPreview(req, ctx) {
  authAdmin(req, ctx);
  const config = loadConfig(ctx), inst = config.installningar;
  const from = datumField(req.from !== undefined && req.from !== null ? req.from : req.fran, 'from');
  const to = datumField(req.to !== undefined && req.to !== null ? req.to : req.till, 'to');
  if (to < from) valideringsfel({ to: 'Slutdatum ligger före startdatum' });
  if (daysBetween(from, to) > PREVIEW_MAX_DAGAR) valideringsfel({ to: 'Högst 8 veckor per förfrågan' });
  const idag = todayStr(), horisontTom = horisontTomDatum(inst);
  if (from < addDays(idag, -7)) valideringsfel({ from: 'Utanför fönstret (tidigast 7 dagar bakåt)' });
  if (to > addDays(horisontTom, 7)) valideringsfel({ to: 'Utanför bokningshorisonten' });

  // Inkorgen läses en gång: buildBusyList får den som opts.inbox, och avbokade/avvisade poster används för att flagga händelser
  // som ligger kvar i kalendern (4.7: misslyckad Calendar.Events.remove → status sätts ändå, Kalenderkoll ska visa varning).
  let inbox = null;
  try { inbox = readInbox(); } catch (e) { inbox = null; }             // null → buildBusyList läser själv och varnar
  const dodaPoster = avbokadeIInkorgen(inbox);
  const busy = buildBusyList(from, to, { config: config, inbox: inbox, farsk: false });
  // Avstämning (4.11, A52): den nattliga listan (Script Property/CacheService) + en LIVE jämförelse av vyn mot inkorgen, så att
  // "Kontrollera avstämning" ser en föräldralös händelse (bokningId utan inkorgspost) direkt – även före första nattkörningen,
  // efter att en händelse skapats under dagen och när triggern dött (V1). Anonymiserade händelser (PURGE_ANONYM_TITEL) räknas inte.
  const saknas = avstamningSaknas();
  if (inbox && Array.isArray(inbox.bokningar)) {
    const kanda = {};
    inbox.bokningar.forEach(b => { if (b && b.bokningId) kanda[str(b.bokningId)] = true; });
    busy.forEach(x => {
      const id = str(x.bokningId);
      if (x.kalla === 'bokningar' && id && BOKNING_ID_RE.test(id) && !kanda[id] && str(x.summary) !== PURGE_ANONYM_TITEL && saknas[id] !== true) { saknas[id] = true; saknas.antal++; }
    });
  }
  const handelser = busy.map(x => previewExport(x, saknas, dodaPoster));
  const varningar = [];
  const lagg = v => { const s = str(v); if (s && varningar.indexOf(s) < 0) varningar.push(s); };
  (busy.varningar || []).forEach(lagg);
  const kvarIKalendern = handelser.filter(h => h.bokningId && dodaPoster[h.bokningId]).length;
  if (kvarIKalendern) lagg(kvarIKalendern + ' avbokade/avvisade möten ligger kvar i kalendern – ta bort dem manuellt');
  const mapsVarning = CacheService.getScriptCache().get('maps:varning');
  if (mapsVarning) lagg('Maps: ' + mapsVarning);
  const saknasIVyn = handelser.filter(h => h.bokningId && saknas[h.bokningId]).length;
  if (saknas.antal) lagg('Kalenderhändelser som saknas i inkorgen: ' + saknas.antal + (saknasIVyn ? ' (' + saknasIVyn + ' i vyn)' : ''));
  const obesvarade = handelser.filter(h => h.preliminar).length;
  return {
    from: from, to: to, idag: idag, horisontTom: horisontTom, genererad: nowIso(),
    handelser: handelser, icsStatus: icsStatusForPing(config), obesvarade: obesvarade, varningar: varningar
  };
}
// Avstämningens lista "saknas i inkorgen" (4.11): Script Property AVSTAMNING_PROP { ts, ids } + CacheService AVSTAMNING_CACHE_KEY
// (JSON-lista av bokningId), båda skrivna av dailyMaintenance (avstamningSkriv). → { <bokningId>: true, …, antal }.
function avstamningSaknas() {
  const ut = { antal: 0 };
  const lagg = lista => { if (Array.isArray(lista)) lista.forEach(id => { if (typeof id === 'string' && id && id !== 'antal' && !ut[id]) { ut[id] = true; ut.antal++; } }); };
  // Script Property (skrivs av dailyMaintenance, giltig AVSTAMNING_GILTIG_MS – CacheService klarar högst 6 h, spec säger 24 h, A48) …
  try {
    const raw = getProp(AVSTAMNING_PROP);
    const obj = raw ? JSON.parse(raw) : null;
    if (isPlainObject(obj) && typeof obj.ts === 'string' && Date.now() - new Date(obj.ts).getTime() < AVSTAMNING_GILTIG_MS) lagg(obj.ids);
  } catch (e) { /* best effort */ }
  // … plus CacheService-nyckeln (samma lista, kortare liv – används även av tester/felsökning).
  try {
    const raw = CacheService.getScriptCache().get(AVSTAMNING_CACHE_KEY);
    lagg(raw ? JSON.parse(raw) : []);
  } catch (e) { /* cache är best effort */ }
  return ut;
}
// Skriver avstämningslistan (dailyMaintenance) eller tar bort id:n ur den (purge). ids = hela nya listan.
function avstamningSkriv(ids, ts) {
  const lista = (Array.isArray(ids) ? ids : []).filter(id => typeof id === 'string' && id).slice(0, AVSTAMNING_MAX_IDS);
  try { setProp(AVSTAMNING_PROP, JSON.stringify({ ts: typeof ts === 'string' && ts ? ts : nowIso(), ids: lista })); } catch (e) { /* best effort */ }
  try { CacheService.getScriptCache().put(AVSTAMNING_CACHE_KEY, JSON.stringify(lista), TTL_D_S); } catch (e) { /* best effort */ }
}
// Inkorgens avbokade/avvisade poster (status 'avbokad'/'avvisad' – dit hör även de med historik typ 'kalenderfel') → { <bokningId>: status }.
// En kalenderhändelse med sådant bokningId ska inte finnas kvar (cancel/reject tar bort den) – finns den ändå varnar Kalenderkoll (4.7).
function avbokadeIInkorgen(inbox) {
  const ut = {};
  ((inbox && inbox.bokningar) || []).forEach(b => {
    if (!b || !b.bokningId) return;
    const st = str(b.status);
    if (st === 'avbokad' || st === 'avvisad') ut[str(b.bokningId)] = st;
  });
  return ut;
}
// BusyItem-segment → Kalenderkoll-post. Titel/plats bara för 'bokningar', 'ics' och 'reservation' – aldrig 'privat' (läge 'tider').
// dodaPoster (valfri) = avbokadeIInkorgen(inbox): händelse med bokningId som är avbokad/avvisad i inkorgen får en varning.
function previewExport(x, saknas, dodaPoster) {
  const kalla = ['bokningar', 'privat', 'ics', 'reservation'].indexOf(x.kalla) >= 0 ? x.kalla : 'privat';
  const visaText = kalla !== 'privat';
  const text = v => cleanText(String(v || '')).slice(0, 200);
  const platsText = x.plats && typeof x.plats === 'object' ? x.plats.text : x.plats;
  const matchIds = kalla === 'reservation' ? [] : (Array.isArray(x.matchIds) ? x.matchIds : []).map(v => String(v || '')).filter(Boolean);
  let titel = '';
  if (kalla === 'reservation') titel = 'Reservation';
  else if (visaText) titel = text(x.summary);
  const varningarPost = [];
  if (x.varning) varningarPost.push(text(x.varning));
  if (x.bokningId && saknas && saknas[x.bokningId] === true) varningarPost.push('saknas i inkorgen');
  const dod = x.bokningId && dodaPoster ? dodaPoster[x.bokningId] : '';
  if (dod === 'avbokad' || dod === 'avvisad') varningarPost.push((dod === 'avbokad' ? 'Avbokad' : 'Avvisad') + ' i inkorgen men händelsen finns kvar i kalendern – ta bort den manuellt');
  return {
    id: str(x.id), ignoreraId: matchIds[0] || '', matchIds: matchIds,
    kalla: kalla, datum: str(x.datum), start: str(x.start), slut: str(x.slut), heldag: x.heldag === true,
    titel: titel, plats: visaText && kalla !== 'reservation' ? text(platsText) : '',
    hasPlace: x.hasPlace === true, restid: x.isTravelMeeting === true, cooldownMin: Number(x.cooldownMin) || 0,
    preliminar: x.preliminar === true, raknad: x.raknad === true, ignorerad: x.ignorerad === true,
    bokningId: str(x.bokningId), bokareId: str(x.bokareId), motestypId: str(x.motestypId),
    sammanslagenMed: (Array.isArray(x.sammanslagenMed) ? x.sammanslagenMed : []).map(v => String(v || '')).filter(Boolean),
    varning: varningarPost[0] || '', varningar: varningarPost
  };
}

// ---------- rebook (4.4, 4.7, 4.9, 6.3 Omboka, 8.3) – M4 ----------
// In:  { adminKey, bokningId, start, adress?, reservationId?, motestypId?, orsak? }
//      start = ISO med offset ('2026-09-24T10:00:00+02:00') eller { datum:'YYYY-MM-DD', tid:'HH:MM' }; samma regler som book
//      (raster, öppen dag, framförhållning per mötestyp, horisont – parseStartField). adress: ny adress (typ med restid; utelämnad →
//      befintlig). motestypId: bara bokningens egen (utelämnad = samma) eller en aktiv typ som bokningens bokare får boka.
//      reservationId: honoreras (undantas som hinder) bara om reservationen tillhör bokningens bokare eller en CJ-bokare.
// Ut:  { bokningId, start, slut, adress, geo, restid, motestypId, kalenderEventId, kalenderNyHandelse, rev, mejlSkickat, bokning }
// Posten måste ha status ny/importerad (annars E_STATE, details.status; okänd → E_NOT_FOUND). Bokningens mötestyp tillåts även om
// den är inaktiv eller inte längre i tillatnaMotestypIds (resolveMotestyp med undantaPost). Den nya luckan kontrolleras under låset
// med färsk kalenderläsning och computeAvailability(undantaBokningId = bokningId) → E_SLOT_TAKEN. Nätverks-I/O (ICS, geokodning,
// Distance Matrix) före låset (4.8). Kalendern: Calendar.Events.patch(start/end/location[/summary], sendUpdates 'all'); är händelsen
// borta (404/410) skapas en ny (kalenderNyHandelse:true, nytt kalenderEventId); annat fel → E_CALENDAR, inget ändrat. Inkorgsposten:
// start, slut, adress, geo, restid, rev+1, andradAt, historik { typ:'ombokad', av:'cj', fran, till } – status oförändrad (appen speglar
// via rev > bokningRev, 8.3). Busy-cachen töms för gamla och nya dagen. Utanför låset: mejl till bokaren om bokare.epost finns (A25).
const REBOOK_STATUSAR = ['ny', 'importerad', 'bokad', 'ombokad'];
function handleRebook(req, ctx) {
  authAdmin(req, ctx);
  const bokningId = typeof req.bokningId === 'string' ? req.bokningId : '';
  if (!BOKNING_ID_RE.test(bokningId)) valideringsfel({ bokningId: 'Ogiltigt värde' });
  const startIso = rebookStartIso(req.start);
  const orsak = strField(req.orsak, 'orsak', ORSAK_MAX, false);
  const nyAdress = req.adress === undefined || req.adress === null ? null : strField(req.adress, 'adress', MAXLEN.adress, false);
  if (req.motestypId !== undefined && req.motestypId !== null && (typeof req.motestypId !== 'string' || !req.motestypId || req.motestypId.length > 64)) valideringsfel({ motestypId: 'Okänd mötestyp' });
  const config = loadConfig(ctx), inst = config.installningar;

  // Posten läses utan lås för validering och cache-värmning; avgörs på nytt under låset.
  const post0 = findBokningInInbox(readInbox(), bokningId);
  if (!post0) fel('E_NOT_FOUND');
  if (REBOOK_STATUSAR.indexOf(str(post0.status)) < 0) fel('E_STATE', undefined, { status: str(post0.status) });
  const bokare = rebookBokare(config, post0);
  const typbyte = typeof req.motestypId === 'string' && req.motestypId !== str(post0.motestypId);
  const typ = typbyte ? resolveMotestyp(config, bokare, req.motestypId, null) : resolveMotestyp(config, bokare, str(post0.motestypId), post0);
  const st = parseStartField(startIso, inst, typ);
  const adress = nyAdress !== null ? nyAdress : str(post0.adress);
  if (typ.restid && !adress) valideringsfel({ adress: 'Obligatoriskt' });
  const slutIso = toIsoWithOffset(st.datum, minToTid(tidToMin(st.tid) + typ.langdMin));
  const reservationId = rebookReservationId(req.reservationId, config, post0);

  // Före låset (4.8): geokodning, ICS och dagsberäkning utan färsk kalenderläsning värmer cacherna.
  const geo = typ.restid ? geoForBooking(adress, null) : { lat: null, lng: null, formaterad: '', status: 'saknas' };
  if (typeof readIcs === 'function') { try { readIcs(config, { farsk: false }); } catch (e) { /* avgörs under låset */ } }
  try { findSlot(bokare, config, typ, adress, st, reservationId, bokningId, false); } catch (e) { if (errorCode(e) === 'E_RATE') throw e; }

  let bokning = null, fran = '', kal = null;
  withScriptLock(() => {
    const inbox = readInbox();
    const b = findBokningInInbox(inbox, bokningId);
    if (!b) fel('E_NOT_FOUND');
    if (REBOOK_STATUSAR.indexOf(str(b.status)) < 0) fel('E_STATE', undefined, { status: str(b.status) });
    const slot = findSlot(bokare, config, typ, adress, st, reservationId, bokningId, true, inbox);   // färsk läsning, egen post undantagen
    if (!slot || slot.status !== 'ledig') fel('E_SLOT_TAKEN');
    const ts = nowIso();
    fran = str(b.start); const franSlut = str(b.slut);
    const nytt = { start: st.iso, slut: slutIso, adress: adress, motestypId: typ.id };
    kal = patchBookingEvent(config, bokare, typ, b, nytt);                 // E_CALENDAR → inget ändrat
    b.start = st.iso; b.slut = slutIso; b.adress = adress; b.geo = geo; b.restid = restidFromSlot(slot, typ, geo);
    if (typbyte) b.motestypId = typ.id;
    b.kalenderEventId = kal.eventId;
    b.rev = (Number(b.rev) || 0) + 1; b.andradAt = ts;
    if (!Array.isArray(b.historik)) b.historik = [];
    const h = { ts: ts, typ: 'ombokad', av: 'cj', fran: fran, till: st.iso };
    if (orsak) h.orsak = orsak;
    if (typbyte) h.motestypFran = str(post0.motestypId);
    b.historik.push(h);
    try { writeInbox(inbox); }
    catch (e) {
      // Kalendern är redan flyttad – försök flytta tillbaka (best effort) så att kalender och inkorg inte går isär.
      try { patchBookingEvent(config, bokare, typ, Object.assign({}, b, { kalenderEventId: kal.eventId }), { start: fran, slut: franSlut, adress: str(post0.adress), motestypId: str(b.motestypId) }); } catch (e2) { /* best effort */ }
      fel('E_INTERNAL', 'Ombokningen kunde inte sparas – inget har ändrats');
    }
    clearBusyCacheFor({ start: fran, slut: franSlut });
    clearBusyCacheFor(b);
    bokning = b;
  });
  const mejlSkickat = notifyBokareOmbokad(config, bokning, fran, orsak);
  return {
    bokningId: bokningId, start: bokning.start, slut: bokning.slut, adress: bokning.adress, geo: bokning.geo, restid: bokning.restid,
    motestypId: bokning.motestypId, kalenderEventId: bokning.kalenderEventId, kalenderNyHandelse: kal.ny === true,
    rev: Number(bokning.rev) || 0, mejlSkickat: mejlSkickat, bokning: inboxExport(bokning)
  };
}
// start för rebook: ISO med offset eller { datum, tid } → ISO-sträng (parseStartField gör resten).
function rebookStartIso(v) {
  if (isPlainObject(v)) {
    const datum = typeof v.datum === 'string' ? v.datum : '', tid = typeof v.tid === 'string' ? v.tid : '';
    if (!DATUM_RE.test(datum) || isNaN(new Date(datum + 'T12:00:00Z').getTime()) || isNaN(tidToMin(tid))) valideringsfel({ start: 'Ogiltig starttid' });
    return toIsoWithOffset(datum, tid);
  }
  if (typeof v !== 'string') valideringsfel({ start: 'Ogiltig starttid' });
  return v;
}
// Bokaren som tillgängligheten räknas för: bokningens egen bokare (även inaktiv), annars en syntetisk CJ-bokare i bokningens
// pipeline (bokaren borttagen ur config) – typen slås ändå upp via undantaPost, och kundnamn/egen-flaggor spelar ingen roll för admin.
function rebookBokare(config, post) {
  const b = config.bokare.find(x => x.id === post.bokareId) || null;
  if (b) return b;
  return { id: str(post.bokareId), namn: 'Borttagen bokare', epost: '', pipelineId: str(post.pipelineId), tillatnaMotestypIds: [], aktiv: false, arCj: true };
}
// Reservation som undantas vid ombokning: bara om den finns och tillhör bokningens bokare eller en CJ-bokare.
function rebookReservationId(v, config, post) {
  const r = getReservation(typeof v === 'string' ? v.slice(0, 64) : '');
  if (!r) return '';
  if (r.bokareId === post.bokareId) return r.id;
  const agare = config.bokare.find(x => x.id === r.bokareId);
  return agare && agare.arCj === true ? r.id : '';
}
// Flyttar bokningens kalenderhändelse (4.7): Events.patch({ start, end, location[, summary, extendedProperties] }, sendUpdates 'all').
// Händelsen borta (404/410) eller inget id → ny händelse via createBookingEvent (ny:true). Annat fel → E_CALENDAR (inget ändrat).
function patchBookingEvent(config, bokare, typ, bokning, nytt) {
  const inst = config.installningar;
  const calId = bokningarKalenderId(inst);
  const s = v => String(v || '').replace(/[<>]/g, ' ');
  const uppdaterad = Object.assign({}, bokning, { start: nytt.start, slut: nytt.slut, adress: nytt.adress, motestypId: nytt.motestypId });
  const skapaNy = () => { const ev = createBookingEvent(config, bokare, typ, uppdaterad, calId); return { eventId: str(ev && ev.id), ny: true }; };
  const eventId = str(bokning.kalenderEventId);
  if (!eventId) return skapaNy();
  const resurs = {
    start: { dateTime: nytt.start, timeZone: TZ },
    end:   { dateTime: nytt.slut,  timeZone: TZ },
    location: s(nytt.adress)
  };
  if (nytt.motestypId !== str(bokning.motestypId)) {
    const kund = isPlainObject(bokning.kund) ? bokning.kund : {};
    resurs.summary = s(typ.titel) + ': ' + s(kund.namn);
    resurs.extendedProperties = { private: { bokningId: String(bokning.bokningId), bokareId: String(bokning.bokareId || ''), pipelineId: String(bokning.pipelineId || ''), motestypId: String(nytt.motestypId) } };
  }
  let ev = null, gone = false;
  try { ev = Calendar.Events.patch(resurs, calId, eventId, { sendUpdates: 'all' }); }
  catch (e) { if (calendarEventGone(e)) gone = true; else fel('E_CALENDAR'); }
  if (gone) return skapaNy();
  return { eventId: str(ev && ev.id) || eventId, ny: false };
}
// Mejl till bokaren efter ombokning (4.9, A25): kundnamn, gammal och ny tid, CJ:s orsak, "Du kontaktar kunden.". Aldrig kontaktuppgifter.
function notifyBokareOmbokad(config, bokning, franIso, orsak) {
  const bokare = config.bokare.find(b => b.id === bokning.bokareId) || null;
  const epost = bokare ? normalizeEmail(bokare.epost) : '';
  if (!epost || !EPOST_RE.test(epost)) return false;
  const s = v => String(v || '').replace(/[<>]/g, ' ');
  const typ = config.motestyper.find(t => t.id === bokning.motestypId) || {};
  const g = franIso ? fromIso(franIso) : { datum: '', tid: '' };
  const p = fromIso(bokning.start), slutTid = fromIso(bokning.slut).tid;
  const subject = 'Bokning flyttad: ' + s(bokning.kund && bokning.kund.namn) + ' ' + p.datum + ' ' + p.tid;
  const body = [
    'Hej ' + s(bokare.namn) + '!',
    '',
    'CJ har flyttat bokningen nedan. Kalenderinbjudan är uppdaterad.',
    '',
    'Kund: ' + s(bokning.kund && bokning.kund.namn),
    'Mötestyp: ' + s(typ.titel || bokning.motestypId),
    'Tidigare tid: ' + (g.datum ? longDateLabel(g.datum) + ' kl ' + g.tid : '(okänd)'),
    'Ny tid: ' + longDateLabel(p.datum) + ' kl ' + p.tid + '–' + slutTid,
    'Orsak: ' + (orsak ? s(orsak) : '(ingen orsak angiven)'),
    '',
    'Du kontaktar kunden.',
    '',
    'Bokningsnummer: ' + String(bokning.bokningId)
  ].join('\n');
  try { MailApp.sendEmail({ to: epost, subject: subject, body: body, name: 'Pipeline bokning' }); return true; }
  catch (e) { loggaMejlfel(bokning.bokningId); return false; }
}

// ---------- cancel (4.4, 4.7, 4.9, 6.3 Avboka, 8.3) – M4 ----------
// In:  { adminKey, bokningId, orsak? }  (även { kalenderEventId, orsak? } utan bokningId, 4.4: avbokning ska fungera efter gallring –
//      finns ingen inkorgspost med det händelse-id:t tas bara kalenderhändelsen bort, postSaknas:true)
// Ut:  { ok:true, bokningId, status:'avbokad', kalenderBorttagen, kalenderFel, mejlSkickat, rev, postSaknas, bokning }
// Från ny/importerad (annars E_STATE, details.status – t.ex. redan 'avbokad'/'avvisad'); okänd → E_NOT_FOUND. Under lås:
// Calendar.Events.remove (sendUpdates 'all'; 404/410 = redan borta = lyckat; annat fel → status sätts ändå + historik 'kalenderfel'
// + kalenderFel:true, 4.7), status 'avbokad', avbokadTs/avbokadOrsak/andradAt, historik { typ:'avbokad', av:'cj', orsak }, inkorgen
// skrivs (rev+1), busy-cachen töms. Posten raderas aldrig (8.3). Utanför låset: mejl till bokaren om bokare.epost finns (A25).
function handleCancel(req, ctx) {
  authAdmin(req, ctx);
  const bokningId = typeof req.bokningId === 'string' ? req.bokningId : '';
  const kalenderEventId = typeof req.kalenderEventId === 'string' ? cleanText(req.kalenderEventId).slice(0, 256) : '';
  if (bokningId || !kalenderEventId) { if (!BOKNING_ID_RE.test(bokningId)) valideringsfel({ bokningId: 'Ogiltigt värde' }); }
  const orsak = strField(req.orsak, 'orsak', ORSAK_MAX, false);
  const config = loadConfig(ctx);
  let bokning = null, kal = { borttagen: false, fel: false }, rev = 0, postSaknas = false;
  withScriptLock(() => {
    const inbox = readInbox();
    let b = bokningId ? findBokningInInbox(inbox, bokningId) : null;
    if (!b && !bokningId && kalenderEventId) b = inbox.bokningar.find(x => str(x.kalenderEventId) === kalenderEventId) || null;
    if (!b) {
      if (!bokningId && kalenderEventId) {
        // Föräldralös händelse (4.4, Kalenderkoll "Ta bort ur kalendern"): hämta först dag + bokningId så att busy:<datum>-cachen
        // (60 s) töms och id:t stryks ur avstämningslistan – annars visar nästa calendar-preview händelsen (och 'saknas i
        // inkorgen') i upp till en minut efter borttagningen. Borta/fel vid hämtning → bara borttagning som förut.
        let resurs = null;
        try { resurs = Calendar.Events.get(bokningarKalenderId(config.installningar), kalenderEventId); } catch (e) { resurs = null; }
        kal = removeBookingEvent(config, kalenderEventId); postSaknas = true; rev = Number(inbox.rev) || 0;
        if (resurs) {
          clearBusyCacheFor({ start: purgeStartIso(resurs), slut: purgeSlutIso(resurs) });
          const priv = (resurs.extendedProperties && resurs.extendedProperties.private) || {};
          if (priv.bokningId) avstamningStryk({ [str(priv.bokningId)]: true });
        }
        return;
      }
      fel('E_NOT_FOUND');
    }
    if (REBOOK_STATUSAR.indexOf(str(b.status)) < 0) fel('E_STATE', undefined, { status: str(b.status) });
    const ts = nowIso();
    kal = removeBookingEvent(config, b.kalenderEventId);
    b.status = 'avbokad';
    b.avbokadTs = ts; b.avbokadOrsak = orsak; b.andradAt = ts;
    if (!Array.isArray(b.historik)) b.historik = [];
    b.historik.push({ ts: ts, typ: 'avbokad', av: 'cj', orsak: orsak });
    if (kal.fel) b.historik.push({ ts: ts, typ: 'kalenderfel', av: 'script' });
    writeInbox(inbox);
    rev = Number(inbox.rev) || 0;
    clearBusyCacheFor(b);
    bokning = b;
  });
  const mejlSkickat = bokning ? notifyBokareAvbokad(config, bokning, orsak) : false;
  return {
    ok: true, bokningId: bokning ? str(bokning.bokningId) : '', status: 'avbokad',
    kalenderBorttagen: kal.borttagen, kalenderFel: kal.fel, mejlSkickat: mejlSkickat, rev: rev, postSaknas: postSaknas,
    bokning: bokning ? inboxExport(bokning) : null
  };
}
// Mejl till bokaren efter avbokning (4.9, A25): kundnamn, tid, orsak, "Du kontaktar kunden.". Aldrig kontaktuppgifter.
function notifyBokareAvbokad(config, bokning, orsak) {
  const bokare = config.bokare.find(b => b.id === bokning.bokareId) || null;
  const epost = bokare ? normalizeEmail(bokare.epost) : '';
  if (!epost || !EPOST_RE.test(epost)) return false;
  const s = v => String(v || '').replace(/[<>]/g, ' ');
  const typ = config.motestyper.find(t => t.id === bokning.motestypId) || {};
  const p = fromIso(bokning.start), slutTid = fromIso(bokning.slut).tid;
  const subject = 'Bokning avbokad: ' + s(bokning.kund && bokning.kund.namn) + ' ' + p.datum + ' ' + p.tid;
  const body = [
    'Hej ' + s(bokare.namn) + '!',
    '',
    'CJ har avbokat bokningen nedan. Kalenderinbjudan är borttagen.',
    '',
    'Kund: ' + s(bokning.kund && bokning.kund.namn),
    'Mötestyp: ' + s(typ.titel || bokning.motestypId),
    'Tid: ' + longDateLabel(p.datum) + ' kl ' + p.tid + '–' + slutTid,
    'Orsak: ' + (orsak ? s(orsak) : '(ingen orsak angiven)'),
    '',
    'Du kontaktar kunden.',
    '',
    'Bokningsnummer: ' + String(bokning.bokningId)
  ].join('\n');
  try { MailApp.sendEmail({ to: epost, subject: subject, body: body, name: 'Pipeline bokning' }); return true; }
  catch (e) { loggaMejlfel(bokning.bokningId); return false; }
}

// ---------- purge (4.4, 8.5, 9 raderingsrutin, A19) – M5 ----------
// In:  { adminKey, bokningIds?:[…], kalenderEventIds?:[…], orgnr?, adresser?:[…] } – minst ett av fälten måste ha innehåll.
//      bokningIds: inkorgs-id:n (36 tecken); kalenderEventIds: appens ev.kalenderEventId (Google event-id); orgnr: kundens orgnr
//      (normaliseras med normalizeOrgnr – bara ett giltigt orgnr matchar, aldrig tomt); adresser: adressträngar vars geokodposter
//      ska bort. Högst PURGE_MAX_IDS per id-lista, PURGE_MAX_ADRESSER adresser.
// Ut:  { borttagna, kalenderRaderade, anonymiserade, geokodBorttagna, kalenderFel:[{ eventId, bokningId, typ }], rev }
//      borttagna = inkorgsposter som togs bort; kalenderRaderade = framtida kalenderhändelser raderade (sendUpdates 'all',
//      404/410 = redan borta = ok, räknas inte); anonymiserade = passerade händelser med titel "Möte (borttaget)", tom plats/
//      beskrivning och bokningId-egenskaperna borttagna (sendUpdates 'all' så Outlook-kopian uppdateras, V9); geokodBorttagna =
//      geokodposter ur cache-filen (adresser ur berörda poster + adresser[]); kalenderFel = händelser som inte kunde raderas/
//      anonymiseras/sökas (typ 'radera' | 'anonymisera' | 'sok' | 'hamta'); rev = inkorgens rev efter skrivningen.
// Under lås (4.8): inkorgsposter vars bokningId ingår ELLER vars kund.orgnr = orgnr tas bort; kalenderhändelser hittas via
// posten (kalenderEventId), via kalenderEventIds och via Calendar.Events.list(privateExtendedProperty 'bokningId=<id>') för
// bokningId utan känt event-id; händelse med slut i framtiden raderas, passerad anonymiseras (A19 – aldrig radering bakåt) efter
// Calendar.Events.get (borta/'cancelled'/redan anonymiserad → hoppas över utan patch eller notis);
// inkorgen skrivs (rev+1) om något togs bort; geokodposter tas bort ur cache-filen och CacheService (geo:<hash>); busy:<datum>
// töms för berörda dagar och id:na stryks ur avstämningslistan. Ingen nätverks-I/O (Calendar/Drive är Google-interna, som i
// cancel/reject). Inga mejl. Kalenderfel fäller aldrig anropet – de rapporteras i kalenderFel (appen visar varning).
function handlePurge(req, ctx) {
  authAdmin(req, ctx);
  const idLista = (v, namn, re, max) => {
    if (v === undefined || v === null) return [];
    if (!Array.isArray(v) || v.length > max) valideringsfel({ [namn]: 'Ogiltigt värde' });
    const ut = [];
    v.forEach(x => { if (typeof x !== 'string' || !re.test(x)) valideringsfel({ [namn]: 'Ogiltigt värde' }); if (ut.indexOf(x) < 0) ut.push(x); });
    return ut;
  };
  const bokningIds = idLista(req.bokningIds, 'bokningIds', BOKNING_ID_RE, PURGE_MAX_IDS);
  const kalenderEventIds = idLista(req.kalenderEventIds, 'kalenderEventIds', PURGE_EVENT_ID_RE, PURGE_MAX_IDS);
  const orgnrRaw = req.orgnr === undefined || req.orgnr === null ? '' : strField(req.orgnr, 'orgnr', 40, false);
  const orgnr = normalizeOrgnr(orgnrRaw);
  if (orgnrRaw && !orgnr) valideringsfel({ orgnr: 'Ogiltigt orgnr' });
  let adresser = [];
  if (req.adresser !== undefined && req.adresser !== null) {
    if (!Array.isArray(req.adresser) || req.adresser.length > PURGE_MAX_ADRESSER) valideringsfel({ adresser: 'Ogiltigt värde' });
    adresser = req.adresser.map(a => strField(a, 'adresser', MAXLEN.adress, false)).filter(Boolean);
  }
  if (!bokningIds.length && !kalenderEventIds.length && !orgnr && !adresser.length) valideringsfel({ bokningIds: 'Inget att radera' });
  const config = loadConfig(ctx);
  let calId = '';
  try { calId = bokningarKalenderId(config.installningar); } catch (e) { calId = ''; }
  const ut = { borttagna: 0, kalenderRaderade: 0, anonymiserade: 0, geokodBorttagna: 0, kalenderFel: [], rev: 0 };

  withScriptLock(() => {
    const inbox = readInbox();
    const idSet = {}; bokningIds.forEach(id => { idSet[id] = true; });
    const traff = b => idSet[str(b.bokningId)] === true || (!!orgnr && isPlainObject(b.kund) && normalizeOrgnr(b.kund.orgnr) === orgnr);
    const borttagna = inbox.bokningar.filter(traff);
    const kvar = inbox.bokningar.filter(b => !traff(b));
    // Alla bokningId som berörs (begärda + funna via orgnr) och deras kända händelser.
    const allaIds = {}; bokningIds.forEach(id => { allaIds[id] = ''; });
    borttagna.forEach(b => { if (b.bokningId) allaIds[str(b.bokningId)] = str(b.kalenderEventId); });
    const handelser = {};   // eventId → { bokningId, slut (ISO|''), resurs|null }
    // Samma händelse kan komma från flera håll (appen skickar både bokningId och kalenderEventId): en befintlig post kompletteras
    // med slut/resurs/bokningId när den saknar dem, så att sökträffen (som bär end) slipper ett extra Calendar.Events.get.
    const laggHandelse = (eventId, bokningId, slut, resurs) => {
      if (!eventId) return;
      const h = handelser[eventId];
      if (!h) { handelser[eventId] = { bokningId: bokningId || '', slut: slut || '', resurs: resurs || null }; return; }
      if (!h.bokningId && bokningId) h.bokningId = bokningId;
      if (!h.slut && slut) h.slut = slut;
      if (!h.resurs && resurs) h.resurs = resurs;
    };
    borttagna.forEach(b => laggHandelse(str(b.kalenderEventId), str(b.bokningId), str(b.slut), null));
    kalenderEventIds.forEach(id => laggHandelse(id, '', '', null));
    if (calId) {
      Object.keys(allaIds).forEach(id => {
        if (allaIds[id]) return;   // känt event-id via posten
        try { listGoogleEventsByBokningId_(calId, id).forEach(ev => laggHandelse(str(ev.id), id, purgeSlutIso(ev), ev)); }
        catch (e) { ut.kalenderFel.push({ eventId: '', bokningId: id, typ: 'sok' }); }
      });
    }
    const adressNycklar = {};
    borttagna.forEach(b => { const k = normalizeAdressKey(b.adress); if (k) adressNycklar[k] = true; });
    adresser.forEach(a => { const k = normalizeAdressKey(a); if (k) adressNycklar[k] = true; });

    // Kalendern: framtida raderas, passerade anonymiseras. Utan bokningskalender → alla kända händelser blir kalenderFel.
    // Passerade händelser hämtas först (Calendar.Events.get) när resursen inte redan är känd: en avbokad/avvisad post behåller
    // kalenderEventId fast cancel/reject redan tagit bort händelsen (404/410 eller status 'cancelled' → inget att anonymisera,
    // ingen patch och ingen notis), och en redan anonymiserad händelse (PURGE_ANONYM_TITEL) patchas inte om.
    const nuMs = Date.now();
    const hamta = h => {   // → true om händelsen fortfarande ska hanteras
      if (!h.resurs) {
        try { h.resurs = Calendar.Events.get(calId, h.eventId); }
        catch (e) { if (calendarEventGone(e)) return false; ut.kalenderFel.push({ eventId: h.eventId, bokningId: h.bokningId, typ: 'hamta' }); return false; }
      }
      return !(h.resurs && (h.resurs.status === 'cancelled' || str(h.resurs.summary) === PURGE_ANONYM_TITEL));
    };
    Object.keys(handelser).forEach(eventId => {
      const h = handelser[eventId]; h.eventId = eventId;
      if (!calId) { ut.kalenderFel.push({ eventId, bokningId: h.bokningId, typ: 'radera' }); return; }
      let slutMs = h.slut ? new Date(h.slut).getTime() : NaN;
      if (isNaN(slutMs)) {
        if (!hamta(h)) return;
        slutMs = new Date(purgeSlutIso(h.resurs)).getTime();
      }
      const framtida = isNaN(slutMs) || slutMs > nuMs;
      if (!framtida && !hamta(h)) return;
      const r = framtida ? purgeRaderaHandelse(calId, eventId) : purgeAnonymiseraHandelse(calId, eventId);
      if (r.fel) ut.kalenderFel.push({ eventId, bokningId: h.bokningId, typ: r.typ });
      else if (r.typ === 'radera') { if (r.gjort) ut.kalenderRaderade++; }
      else if (r.gjort) ut.anonymiserade++;
    });

    if (borttagna.length) { inbox.bokningar = kvar; writeInbox(inbox); }
    ut.borttagna = borttagna.length;
    ut.rev = Number(inbox.rev) || 0;

    // Cache-filen (geokod) + CacheService (geo:<hash>, busy:<datum>, avstämning).
    const nycklar = Object.keys(adressNycklar);
    if (nycklar.length) {
      updateCacheFile(obj => { let n = 0; nycklar.forEach(k => { if (obj.geokod && Object.prototype.hasOwnProperty.call(obj.geokod, k)) { delete obj.geokod[k]; n++; } }); ut.geokodBorttagna = n; return n > 0; });
      try { CacheService.getScriptCache().removeAll(nycklar.map(k => 'geo:' + sha256hex(k))); } catch (e) { /* best effort */ }
    }
    borttagna.forEach(b => clearBusyCacheFor(b));
    // Händelser utan inkorgspost (kalenderEventIds/sökning) har ingen känd dag utan extra anrop – töm busy:<datum> för hela
    // preview-fönstret (≤ ~80 nycklar, 60 s-cache) så att Kalenderkoll inte visar den raderade händelsen (och 'saknas i inkorgen')
    // i upp till en minut efter "Ta bort ur kalendern".
    if (Object.keys(handelser).length) clearBusyCacheWindow(config.installningar);
    avstamningStryk(allaIds);
  });
  return ut;
}
// Tömmer busy:<datum> för [idag−7, horisont+7] (calendar-preview-fönstret). Cachen är en optimering – fel ignoreras.
function clearBusyCacheWindow(inst) {
  try {
    const keys = [];
    const till = addDays(horisontTomDatum(inst), 7);
    for (let d = addDays(todayStr(), -7), g = 0; d <= till && g < 120; d = addDays(d, 1), g++) keys.push('busy:' + d);
    CacheService.getScriptCache().removeAll(keys);
  } catch (e) { /* cache är en optimering */ }
}
// Stryker id:n (objekt { <bokningId>: … }) ur avstämningslistan utan att ändra listans ts (A48) – purge och cancel { kalenderEventId }.
function avstamningStryk(idSet) {
  const saknas = avstamningSaknas();
  const kvar = Object.keys(saknas).filter(id => id !== 'antal' && !Object.prototype.hasOwnProperty.call(idSet || {}, id));
  if (kvar.length !== saknas.antal) avstamningSkriv(kvar, purgeAvstamningTs());
}
function purgeAvstamningTs() { try { const o = JSON.parse(getProp(AVSTAMNING_PROP) || 'null'); return isPlainObject(o) && typeof o.ts === 'string' ? o.ts : ''; } catch (e) { return ''; } }
// Start-/sluttid (ISO) för en Events-resurs: dateTime, eller date (heldag; end.date är exklusivt) som lokal midnatt.
function purgeStartIso(ev) {
  const start = ev && ev.start ? ev.start : {};
  if (start.dateTime) return String(start.dateTime);
  if (start.date) return toIsoWithOffset(String(start.date), '00:00');
  return '';
}
function purgeSlutIso(ev) {
  const end = ev && ev.end ? ev.end : {};
  if (end.dateTime) return String(end.dateTime);
  if (end.date) return toIsoWithOffset(String(end.date), '00:00');
  return '';
}
function purgeRaderaHandelse(calId, eventId) {
  try { Calendar.Events.remove(calId, String(eventId), { sendUpdates: 'all' }); return { typ: 'radera', gjort: true, fel: false }; }
  catch (e) { return calendarEventGone(e) ? { typ: 'radera', gjort: false, fel: false } : { typ: 'radera', gjort: false, fel: true }; }
}
// Anonymisering (A19, 9): titel "Möte (borttaget)", tom plats och beskrivning, bokningsegenskaperna borttagna (null = ta bort i
// Calendar API:s patch), gäster oförändrade så att Outlook-kopian uppdateras med sendUpdates 'all' (V9). 404/410 = redan borta.
function purgeAnonymiseraHandelse(calId, eventId) {
  const resurs = {
    summary: 'Möte (borttaget)', location: '', description: '',
    extendedProperties: { private: { bokningId: null, bokareId: null, pipelineId: null, motestypId: null } }
  };
  try { Calendar.Events.patch(resurs, calId, String(eventId), { sendUpdates: 'all' }); return { typ: 'anonymisera', gjort: true, fel: false }; }
  catch (e) { return calendarEventGone(e) ? { typ: 'anonymisera', gjort: false, fel: false } : { typ: 'anonymisera', gjort: false, fel: true }; }
}

// Routingtabell (4.4). Nycklarna är action-värdena exakt som klienterna skickar dem.
const HANDLERS = {
  'ping': handlePing,
  'hello': handleHello,
  'availability': handleAvailability,
  'reserve': handleReserve,
  'release': handleRelease,
  'book': handleBook,
  'geocode': handleGeocode,
  'setup': handleSetup,
  'config-push': handleConfigPush,
  'calendars-list': handleCalendarsList,
  'calendar-preview': handleCalendarPreview,
  'inbox-list': handleInboxList,
  'ack': handleAck,
  'reject': handleReject,
  'cancel': handleCancel,
  'rebook': handleRebook,
  'purge': handlePurge
};

// ============================================================
// Trigger och underhåll (4.11) – install() körs en gång manuellt av CJ vid deploy (auktoriserar även scopes) och
// därefter idempotent av setup (Anslut-guiden). dailyMaintenance (M5): gallring av inkorg och cache-fil, räknare i Script
// Properties, avstämning kalender ↔ inkorg. Loggar EN rad { trigger:'dailyMaintenance', ok, ms, … } utan personuppgifter.
// ============================================================

function install() {
  ScriptApp.getProjectTriggers()
    .filter(t => t.getHandlerFunction() === 'dailyMaintenance')
    .forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('dailyMaintenance').timeBased().everyDays(1).atHour(3).create();
  return 'Trigger för dailyMaintenance skapad (kl 03–04). Scriptversion ' + SCRIPT_VERSION + '.';
}

function dailyMaintenance() {
  const t0 = Date.now();
  if (typeof availResetMemo_ === 'function') availResetMemo_();   // egen körning – memona ska vara tomma som i doPost
  if (typeof kalResetMemo_ === 'function') kalResetMemo_();
  const rad = { trigger: 'dailyMaintenance', ok: true, ms: 0, raknare: 0, inkorg: 0, utanImport: 0, geokod: 0, restid: 0, saknas: 0, fel: [] };
  const nuMs = Date.now();
  // 1. Räknare i Script Properties äldre än 7 dagar (4.2, 4.11) – oberoende av brevlådan.
  try { rad.raknare = gallraRaknare(todayStr()); } catch (e) { rad.ok = false; rad.fel.push('raknare:' + felKlass(e)); }
  // 2. Inkorg + cache-fil under lås (4.8: 20 s). Kräver ansluten brevlåda (annars hoppas steget över, ingen felrad).
  let config = null, inbox = null, gallradeIds = {};
  try { config = loadConfig(); } catch (e) { config = null; if (errorCode(e) !== 'E_SETUP') { rad.ok = false; rad.fel.push('config:' + felKlass(e)); } }
  if (config) {
    try {
      withScriptLock(() => {
        inbox = readInbox();
        const g = gallraInkorg(inbox.bokningar, nuMs);
        rad.inkorg = g.borttagna.length; rad.utanImport = g.utanImport;
        g.borttagna.forEach(b => { if (b.bokningId) gallradeIds[str(b.bokningId)] = true; });
        if (g.borttagna.length) { inbox.bokningar = g.kvar; writeInbox(inbox); }
        const gallradeNycklar = {};
        g.borttagna.forEach(b => { const k = normalizeAdressKey(b.adress); if (k) gallradeNycklar[k] = true; });
        updateCacheFile(obj => { const c = gallraCacheFil(obj, nuMs, gallradeNycklar); rad.geokod = c.geokod; rad.restid = c.restid; return c.andrad; });
      }, MAINT_LOCK_WAIT_MS);
    } catch (e) { rad.ok = false; rad.fel.push('inkorg:' + (errorCode(e) || felKlass(e))); }
    // 3. Avstämning kalender ↔ inkorg (4.11, A52): Bokningar-kalenderns händelser i [nu−7 d, horisont+7 d] med
    //    extendedProperties.private.bokningId som saknar inkorgspost → Script Property + CacheService (calendar-preview/ping visar).
    //    Events.list körs efter att låset släppts; en bokning som skapas däremellan finns i kalendern men inte i det redan lästa
    //    inbox-objektet, därför läses inkorgen om (en Drive-läsning) när något hittats och id:n med post stryks.
    try {
      if (inbox) {
        let saknas = avstamningKorning(config, inbox, gallradeIds, nuMs);
        if (saknas.length) {
          let farsk = null;
          try { farsk = readInbox(); } catch (e) { farsk = null; }
          if (farsk && Array.isArray(farsk.bokningar)) {
            const kanda = {}; farsk.bokningar.forEach(b => { if (b && b.bokningId) kanda[str(b.bokningId)] = true; });
            saknas = saknas.filter(id => !kanda[id]);
          }
        }
        rad.saknas = saknas.length;
        avstamningSkriv(saknas);
      }
    } catch (e) { rad.ok = false; rad.fel.push('avstamning:' + (errorCode(e) || felKlass(e))); }
  }
  rad.ms = Date.now() - t0;
  if (rad.ok) { try { setProp(MAINT_PROP_SENAST, nowIso()); } catch (e) { /* best effort */ } }
  console.log(JSON.stringify(rad));
  return rad;
}
// Räknare maps_elements_<YYYYMMDD>/book_count_<YYYYMMDD> äldre än 7 dagar. → antal borttagna.
function gallraRaknare(idag) {
  const props = PropertiesService.getScriptProperties();
  const grans = ymdCompact(addDays(idag, -7));
  let n = 0;
  Object.keys(props.getProperties()).forEach(k => {
    const m = /^(maps_elements_|book_count_)(\d{8})$/.exec(k);
    if (m && m[2] < grans) { props.deleteProperty(k); n++; }
  });
  return n;
}
// Ren funktion (4.11, A6): → { kvar:[], borttagna:[], utanImport }.
//   importerad/avvisad/avbokad: referens = senaste av andradAt/importeradAt/avvisadTs/avbokadTs (reserv skapad); äldre än 30 dagar
//   OCH slut passerat → bort. ny: slut passerat med > 90 dagar → bort ("gallrad utan import"). Okänd status eller poster utan
//   tolkbara datum behålls (hellre en post för mycket än en förlorad).
function gallraInkorg(bokningar, nuMs) {
  const kvar = [], borttagna = []; let utanImport = 0;
  const ms = v => { const t = typeof v === 'string' && v ? new Date(v).getTime() : NaN; return isNaN(t) ? null : t; };
  const dag = 86400000;
  (bokningar || []).forEach(b => {
    if (!isPlainObject(b)) return;
    const status = str(b.status), slutMs = ms(b.slut);
    let bort = false;
    if (status === 'importerad' || status === 'avvisad' || status === 'avbokad') {
      const ref = [b.andradAt, b.importeradAt, b.avvisadTs, b.avbokadTs].map(ms).filter(t => t !== null);
      const refMs = ref.length ? Math.max.apply(null, ref) : ms(b.skapad);
      bort = refMs !== null && slutMs !== null && nuMs - refMs > GALLRING_IMPORTERAD_DAGAR * dag && slutMs < nuMs;
    } else if (status === 'ny') {
      bort = slutMs !== null && nuMs - slutMs > GALLRING_NY_DAGAR * dag;
      if (bort) utanImport++;
    }
    (bort ? borttagna : kvar).push(b);
  });
  return { kvar, borttagna, utanImport };
}
// Ren funktion (4.11): geokod-/restidsposter äldre än 180 dagar bort; geokodposter för gallrade bokningars adresser markeras
// gallrad och tas bort när de är äldre än 90 dagar. → { andrad, geokod, restid }.
function gallraCacheFil(obj, nuMs, gallradeNycklar) {
  const dag = 86400000; let geokod = 0, restid = 0, andrad = false;
  const alder = post => { const t = post && typeof post.ts === 'string' ? new Date(post.ts).getTime() : NaN; return isNaN(t) ? null : nuMs - t; };
  if (!isPlainObject(obj.geokod)) obj.geokod = {};
  if (!isPlainObject(obj.restid)) obj.restid = {};
  Object.keys(gallradeNycklar || {}).forEach(k => { const post = obj.geokod[k]; if (isPlainObject(post) && post.gallrad !== true) { post.gallrad = true; andrad = true; } });
  Object.keys(obj.geokod).forEach(k => {
    const post = obj.geokod[k], a = alder(post);
    if (!isPlainObject(post) || a === null) return;   // utan ts (äldre format): lämnas
    if (a > GALLRING_CACHE_DAGAR * dag || (post.gallrad === true && a > GALLRING_GEOKOD_GALLRAD_DAGAR * dag)) { delete obj.geokod[k]; geokod++; }
  });
  Object.keys(obj.restid).forEach(k => {
    const post = obj.restid[k], a = alder(post);
    if (isPlainObject(post) && a !== null && a > GALLRING_CACHE_DAGAR * dag) { delete obj.restid[k]; restid++; }
  });
  return { andrad: andrad || geokod > 0 || restid > 0, geokod, restid };
}
// Avstämning (4.11, A52): en avgränsad Events.list på Bokningar-kalendern i [nu−7 d, horisont+7 d] (listGoogleEventsAvstamning_,
// Calendar.gs – singleEvents, showDeleted:false, bara de fält som behövs). Flaggas: händelser med private.bokningId i giltigt
// format som saknar inkorgspost och inte gallrades i samma körning, där
//   • alla FRAMTIDA händelser räknas (framtida poster gallras aldrig och purge tar bort båda → en framtida händelse utan post är
//     alltid föräldralös; den blockerar dessutom luckan i tillgängligheten tills den tas bort), och
//   • PASSERADE händelser (de senaste 7 dagarna) bara räknas om de ändrats/skapats de senaste 7 dagarna (`updated`) – äldre
//     gallrade möten som bara fått en gästuppdatering flaggas inte.
// Anonymiserade händelser (PURGE_ANONYM_TITEL) hoppas över även om bryggan skulle ha behållit bokningId (V13).
// Utan tidsgräns skulle ett aldrig slutande återkommande möte i en delad "fullt"-kalender expanderas till 50 × 2 500 poster.
// → [bokningId] (unika). Kastar E_CALENDAR.
function avstamningKorning(config, inbox, ignoreraIds, nuMs) {
  let calId = '';
  try { calId = bokningarKalenderId(config.installningar); } catch (e) { return []; }   // ingen bokningskalender vald → inget att stämma av
  const kanda = {}; (inbox.bokningar || []).forEach(b => { if (b && b.bokningId) kanda[str(b.bokningId)] = true; });
  const granMs = nuMs - 7 * 86400000;
  const timeMin = isoWithOffset(new Date(granMs));
  const timeMax = toIsoWithOffset(addDays(horisontTomDatum(config.installningar), 8), '00:00');   // t.o.m. horisont+7 (exklusiv gräns)
  const saknas = [];
  listGoogleEventsAvstamning_(calId, timeMin, timeMax).forEach(ev => {
    const priv = (ev && ev.extendedProperties && ev.extendedProperties.private) || {};
    const id = str(priv.bokningId);
    if (!id || !BOKNING_ID_RE.test(id) || kanda[id] || (ignoreraIds && ignoreraIds[id]) || saknas.indexOf(id) >= 0) return;
    if (str(ev.summary) === PURGE_ANONYM_TITEL) return;
    const slutMs = new Date(purgeSlutIso(ev)).getTime();
    if (!isNaN(slutMs) && slutMs <= nuMs) {
      const updMs = ev.updated ? new Date(ev.updated).getTime() : NaN;
      if (isNaN(updMs) || updMs < granMs) return;   // passerad och inte nyligen ändrad → inte föräldralös-varning
    }
    saknas.push(id);
  });
  return saknas;
}
