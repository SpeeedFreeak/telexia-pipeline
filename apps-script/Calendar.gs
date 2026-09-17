/**
 * Calendar.gs – kalenderläsning för bokningsmodulen (spec 4.6, 5.2, 3.5 KALENDER_IGNORERA, A8, A9, A20).
 *
 * Uppdelning:
 *   1. RENA FUNKTIONER (inga Apps Script-tjänster – kan enhetstestas i Node):
 *      parseIcs, expandRrule, icsInstances, normalizeGoogleEvent (hoppar över modulens egna blockhändelser private.pipelineBlock === '1',
 *      version 11), normalizeIcsItem,
 *      reservationToBusy, inboxBookingToBusy, mergeBusy, applyIgnore (ignorera/räkna + restid-override, version 9), finalizeBusy
 *      (härledda fält + effektiv buffert cooldownMin = max(cooldown, marginal) – version 10), busyForDay.
 *   2. WRAPPERS runt Apps Script-tjänster (Calendar advanced service v3, UrlFetchApp, CacheService,
 *      Utilities, Session) – små och utbytbara.
 *   3. SAMMANSÄTTNING: readIcs, readBusy, buildBusyList, getIcsStatus.
 *
 * Tidshjälpen (tzParts, toIsoWithOffset, addDays, weekdayOf, todayStr, fromIso) definieras i
 * Code.gs (spec 3.4) och anropas här med specens namn; loadConfig/readInbox likaså. readIcsReserv/
 * writeIcsReserv (cache-filens icsReserv) ligger i Availability.gs. Delat globalt scope i Apps Script.
 *
 * BusyItem (spec 5.2) – en post per DAG-SEGMENT (händelse över midnatt delas per dag, 5.13):
 *   { id, kalla:'privat'|'bokningar'|'ics'|'reservation', datum:'YYYY-MM-DD',
 *     start, slut (ISO med offset), startMin, slutMin (minuter sedan midnatt, 0–1440),
 *     heldag, hasPlace, plats:{ text, lat, lng, geokodad, omrade? }, isTravelMeeting,
 *     cooldownMin (EFFEKTIV buffert efter händelsen, version 10: max(mötestypens/reservationens cooldown, marginalFysisktMin för
 *       restidsankare resp. marginalOnlineMin för platslösa) – sätts i finalizeBusy för alla poster, 0 för heldag; hindret i
 *       dayPlan är [start, slut + cooldownMin], blockFor ger paus-block, previewResor/previewExport använder samma värde),
 *     ignore, preliminar, raknad, ignorerad, egen, egenReservation,
 *     bokningId, bokareId, motestypId, kundnamn (bara egna), summary (bara internt/Kalenderkoll),
 *     sammanslagenMed:[], matchIds:[] (event-id, recurringEventId, ICS UID – för ignorera-listan),
 *     varning:'' }
 *   plats.omrade (steg 2c, A56) = områdesetikett 'Stad · Stadsdel' när platsen är geokodad – ur inkorgspostens geo.omrade,
 *   reservationens plats.omrade (Code.gs) eller geokodaAnkare (Availability.gs) för platstexter; aldrig satt utan koordinater.
 *   hasPlace (Teams-fix, version 7): en bokning vars mötestyp saknar restid (kalRestidFn_, via motestypId) får alltid hasPlace:false
 *   – plats/omrade kan finnas kvar för visning men posten blir aldrig restidsankare (isTravelMeeting).
 *   override (version 9, bara internt – exporteras aldrig till bokaren): { online:true|false|null, adress } när en KALENDER_IGNORERA-post
 *   (3.5) bär manuell restidsklassning (online) och/eller rättad adress för händelsen; sätts i applyIgnore, respekteras av finalizeBusy
 *   och speglas i calendar-preview som overrideOnline/overrideAdress (Code.gs previewExport).
 *
 * Inget av det som läses här loggas: ICS-url, titlar och platser stannar i minnet/CacheService.
 *
 * Blocksynk (version 11, A61, K6): kalendern "Pipeline – restid" (Script Property BLOCK_KALENDER_ID, Code.gs blockKalenderId_) innehåller
 * modulens EGNA restid-/marginalblock och läses aldrig – readBusy hoppar över den oavsett läge och normalizeGoogleEvent släpper
 * igenom inga händelser med extendedProperties.private.pipelineBlock === '1' (skulle någon ändå ha lagt dem i en läst kalender).
 * Annars blev blocken hinder/ankare = dubbelräkning.
 */

// ---------- Konstanter ----------
const KAL_TZ = 'Europe/Stockholm';
const KAL_ICS_CACHE_KEY = 'ics:busy';          // reducerad ICS-lista, 15 min (4.6)
const KAL_ICS_META_KEY = 'ics:meta';           // status för ping/Kalenderkoll
const KAL_ICS_CACHE_S = 900;
const KAL_ICS_FEL_CACHE_S = 300;               // efter misslyckad hämtning: vänta 5 min innan nytt försök
const KAL_ICS_RESERV_MIN_ALDER_MS = 15 * 60000; // icsReserv i cache-filen skrivs bara om den befintliga är äldre än 15 min
// Memo per körning (varje request är en ny V8-kontext): reserve/book läser ICS FÖRE låset (warmSlotCaches) och får
// samma resultat under låset utan nytt UrlFetch – även om flödet inte ryms i CacheService (fler än KAL_ICS_MAX_CHUNKS bitar).
let KAL_ICS_MEMO = null;                        // { url, res } | null
function kalResetMemo_() { KAL_ICS_MEMO = null; }   // anropas av doPost (Code.gs) så att memot aldrig överlever ett anrop
// CacheService-format för det filtrerade, reducerade ICS-resultatet (M5, spec 4.6 + A45): JSON → Utilities.gzip → base64,
// delat i bitar om högst KAL_ICS_CHUNK_BYTES under nycklarna ics:busy:0 … ics:busy:<n-1>; indexnyckeln ics:busy bär
// { v, delar, langd, hamtadTs, antal }. Ett stort flöde (CJ: ~370 händelser, > 90 KB som JSON) ryms därmed i cachen och
// andra anropet inom 15 min gör varken UrlFetch eller parsning. Fler än KAL_ICS_MAX_CHUNKS bitar → ingen cache (parsa varje gång).
const KAL_ICS_CACHE_VERSION = 2;
const KAL_ICS_CHUNK_BYTES = 90 * 1024;         // per nyckel (CacheService-gräns 100 KB/värde)
const KAL_ICS_MAX_CHUNKS = 8;                  // ≈ 720 KB base64 ≈ 540 KB gzip – långt över alla rimliga flöden
const KAL_ICS_SUMMARY_MAX = 160;               // reducerad post: titel/plats klipps (Kalenderkoll visar högst 200 tecken)
const KAL_ICS_PLATS_MAX = 200;
// Långsamt Outlook (A46): tar hämtningen längre än KAL_ICS_LANGSAM_MS markeras meta.langsamTs, och i KAL_ICS_LANGSAM_S därefter
// används cache-filens icsReserv (Drive-läsning ~1 s) vid cache-miss i stället för ny hämtning – förutsatt att reserven är
// yngre än KAL_ICS_RESERV_MAX_ALDER_MS. Resultatet läggs i CacheService så att följande anrop inte ens läser Drive.
const KAL_ICS_LANGSAM_MS = 5000;
const KAL_ICS_LANGSAM_S = 1800;
const KAL_ICS_RESERV_MAX_ALDER_MS = 60 * 60000;
const KAL_BUSY_CACHE_S = 60;                   // busy:<datum> (4.6)
const KAL_MERGE_TOLERANS_MIN = 5;              // "samma start och slut (±5 min)"
const KAL_MERGE_OVERLAPP = 0.9;                // "överlapp ≥ 90 % av den kortare"
const KAL_MAX_OBESVARADE = 10;                 // varning vid fler obesvarade Outlook-inbjudningar
const KAL_MAX_RRULE_INSTANSER = 1000;          // skyddsgräns vid expansion
const KAL_STOCKHOLM_TZID = ['europe', 'w. europe', 'central europe', 'romance'];
const KAL_UTC_TZID = ['utc', 'gmt', 'etc/utc', 'etc/gmt', 'z', 'coordinated universal time'];
const KAL_KALLA_PRIO = { bokningar: 3, privat: 2, ics: 1, reservation: 0 };
const KAL_ICS_VECKODAG = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };

// =====================================================================================
// 1. RENA HJÄLPFUNKTIONER
// =====================================================================================

function kalMinutesOf(tid) {                       // 'HH:MM' → minuter sedan midnatt
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(tid || ''));
  return m ? (+m[1]) * 60 + (+m[2]) : 0;
}
function kalTidOf(min) {                           // minuter → 'HH:MM' (1440 → '24:00')
  const h = Math.floor(min / 60), mm = min % 60;
  return String(h).padStart(2, '0') + ':' + String(mm).padStart(2, '0');
}
function kalIsUrl(text) { return /^\s*(https?:\/\/|www\.)/i.test(String(text || '')); }
// Online-möte i platsfältet (version 8): Outlook sätter LOCATION "Microsoft Teams-möte"/"Microsoft Teams Meeting" på Teams-inbjudningar
// (ibland "Konferensrum X; Microsoft Teams-möte"), Google-synkade möten likaså. Sådana texter geokodades tidigare till en riktig plats
// och gjorde varje Teams-möte till ett restidsankare med helt felaktiga ben (bas → "Teams-platsen" → nästa möte). Innehåller platsen
// ett online-ord – var som helst i texten – är det inget ankare (platsen visas ändå i Kalenderkoll). Ordgränser (\b) gör att
// "Telefonvägen 3"/"Distansgatan 5" fortfarande är platser. En riktig gatuadress med Teams-länk i beskrivningen påverkas inte
// (bara LOCATION-texten bedöms) – hellre ett ankare för mycket än en missad resa.
const KAL_ONLINE_RE = /\b(microsoft ?teams|teams|zoom|google ?meet|meet\.google|webex|skype|telefonm[öo]te|telefon|online|digitalt|distans|videom[öo]te|videol[äa]nk|virtuellt)\b/i;
function kalLooksLikePlace(text) {                 // URL (Teams-länk) och online-möten räknas inte som plats (5.2, version 8)
  const t = String(text || '').trim();
  if (!t || kalIsUrl(t)) return false;
  if (KAL_ONLINE_RE.test(t)) return false;
  return true;
}
function kalMsOf(iso) { return new Date(iso).getTime(); }
function kalIsoAt(datum, min) {                    // datum + minuter → ISO med offset (1440 = nästa dags 00:00)
  return min >= 1440 ? toIsoWithOffset(addDays(datum, 1), '00:00') : toIsoWithOffset(datum, kalTidOf(min));
}

/** Tom BusyItem med defaults; `base` skrivs över. */
function newBusyItem(base) {
  return Object.assign({
    id: '', kalla: 'privat', datum: '', start: '', slut: '', startMin: 0, slutMin: 0,
    heldag: false, hasPlace: false, plats: { text: '', lat: null, lng: null, geokodad: false },
    isTravelMeeting: false, cooldownMin: 0, ignore: false, preliminar: false, raknad: false, ignorerad: false,
    egen: false, egenReservation: false, bokningId: '', bokareId: '', motestypId: '', kundnamn: '',
    summary: '', sammanslagenMed: [], matchIds: [], varning: ''
  }, base || {});
}
// Platsobjekt ur en sträng (Google location / ICS LOCATION) eller ur ett redan normaliserat objekt
// { text, lat, lng, geokodad } (reservationer från Code.gs createReservation, inkorgsposter).
function kalPlats(plats) {
  if (plats && typeof plats === 'object') {
    const geo = typeof plats.lat === 'number' && typeof plats.lng === 'number' && isFinite(plats.lat) && isFinite(plats.lng);
    const ut = { text: String(plats.text || '').trim(), lat: geo ? plats.lat : null, lng: geo ? plats.lng : null, geokodad: geo && plats.geokodad !== false };
    if (ut.geokodad && typeof plats.omrade === 'string' && plats.omrade.trim()) ut.omrade = plats.omrade.trim().slice(0, 60);   // steg 2c
    return ut;
  }
  const t = String(plats || '').trim();
  return { text: t, lat: null, lng: null, geokodad: false };
}

/** Delar ett tidsatt intervall [startDate, endDate) i dag-segment i Stockholm-tid. */
function splitToDays(startDate, endDate, base) {
  const out = [];
  if (!(startDate instanceof Date) || !(endDate instanceof Date) || isNaN(startDate) || isNaN(endDate)) return out;
  if (endDate.getTime() <= startDate.getTime()) return out;     // nollängd → inget hinder
  const s = tzParts(startDate), e = tzParts(endDate);
  const sMin0 = kalMinutesOf(s.tid), eMin0 = kalMinutesOf(e.tid);
  let d = s.datum, guard = 0;
  while (d <= e.datum && guard++ < 400) {
    const sMin = d === s.datum ? sMin0 : 0;
    const eMin = d === e.datum ? eMin0 : 1440;
    if (eMin > sMin) {
      out.push(newBusyItem(Object.assign({}, base, {
        datum: d, startMin: sMin, slutMin: eMin, start: kalIsoAt(d, sMin), slut: kalIsoAt(d, eMin), heldag: false
      })));
    }
    if (d === e.datum) break;
    d = addDays(d, 1);
  }
  return out;
}

/** Heldagssegment för [startDatum, slutDatumExkl). */
function heldagSegments(startDatum, slutDatumExkl, base) {
  const out = [];
  let d = startDatum, guard = 0;
  const slut = slutDatumExkl && slutDatumExkl > startDatum ? slutDatumExkl : addDays(startDatum, 1);
  while (d < slut && guard++ < 400) {
    out.push(newBusyItem(Object.assign({}, base, {
      datum: d, startMin: 0, slutMin: 1440, start: kalIsoAt(d, 0), slut: kalIsoAt(d, 1440),
      heldag: true, hasPlace: false, isTravelMeeting: false
    })));
    d = addDays(d, 1);
  }
  return out;
}

// -------------------------------------------------------------------------------------
// 1a. Google-händelse → BusyItem (spec 4.6 punkt 1–2)
// -------------------------------------------------------------------------------------

/**
 * @param ev     Events-resurs från Calendar v3.
 * @param kalla  'privat' (lage 'tider') eller 'bokningar' (lage 'fullt').
 * @param opts   { cooldownFor: fn(motestypId) → min, restidFor: fn(motestypId) → bool }  (bara för 'bokningar')
 *               restidFor (Teams-fix, version 7): mötestyp utan restid → hasPlace:false även om location är satt (aldrig ankare).
 * @return       [] om händelsen inte räknas, annars dag-segment.
 */
function normalizeGoogleEvent(ev, kalla, opts) {
  opts = opts || {};
  if (!ev || ev.status === 'cancelled') return [];
  if (ev.transparency === 'transparent') return [];                         // "Ledig" → räknas inte
  const typ = ev.eventType || 'default';
  if (typ === 'workingLocation' || typ === 'birthday') return [];
  const att = Array.isArray(ev.attendees) ? ev.attendees : [];
  if (att.some(a => a && a.self && a.responseStatus === 'declined')) return [];
  const start = ev.start || {}, end = ev.end || {};
  const priv = (ev.extendedProperties && ev.extendedProperties.private) || {};
  if (priv.pipelineBlock === '1') return [];                                 // modulens eget restid-/marginalblock (version 11) – aldrig ett hinder
  const bokningId = kalla === 'bokningar' ? String(priv.bokningId || '') : '';
  const motestypId = kalla === 'bokningar' ? String(priv.motestypId || '') : '';
  const eventId = String(ev.id || '');
  const recurringEventId = String(ev.recurringEventId || '');
  const matchIds = [eventId, recurringEventId].filter(Boolean);
  const platsText = typ === 'focusTime' ? '' : String(ev.location || '');    // fokustid = hinder utan plats
  const utanRestid = kalla === 'bokningar' && motestypId && typeof opts.restidFor === 'function' && opts.restidFor(motestypId) === false;
  const base = {
    id: bokningId ? 'bk_' + bokningId : 'gcal:' + eventId,
    kalla: kalla === 'bokningar' ? 'bokningar' : 'privat',
    eventId, recurringEventId, iCalUID: String(ev.iCalUID || ''), matchIds,
    summary: typ === 'focusTime' ? 'Fokustid' : String(ev.summary || ''),
    plats: kalPlats(platsText), hasPlace: !utanRestid && kalLooksLikePlace(platsText),
    cooldownMin: (kalla === 'bokningar' && motestypId && typeof opts.cooldownFor === 'function') ? (opts.cooldownFor(motestypId) | 0) : 0,
    bokningId, motestypId,
    bokareId: kalla === 'bokningar' ? String(priv.bokareId || '') : '',
    pipelineId: kalla === 'bokningar' ? String(priv.pipelineId || '') : ''
  };
  if (start.date) return heldagSegments(String(start.date), end.date ? String(end.date) : '', base);
  if (!start.dateTime || !end.dateTime) return [];
  return splitToDays(new Date(start.dateTime), new Date(end.dateTime), base);
}

// -------------------------------------------------------------------------------------
// 1b. ICS-parser (spec 4.6 punkt 3, A9)
// -------------------------------------------------------------------------------------

/** Vecklar ut radbrytningar (RFC 5545 3.1: CRLF + mellanslag/tab = fortsättning). */
function icsUnfold(text) {
  return String(text || '').replace(/\r\n[ \t]/g, '').replace(/\n[ \t]/g, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}
function icsUnescape(v) {
  return String(v || '').replace(/\\n/gi, '\n').replace(/\\,/g, ',').replace(/\\;/g, ';').replace(/\\\\/g, '\\');
}
/** 'NAME;P1=a;P2="b:c":value' → { name, params:{P1:'a',P2:'b:c'}, value } (parametrar i VERSALER). */
function icsParseLine(line) {
  let i = 0, name = '', inQuote = false;
  const params = {};
  while (i < line.length && line[i] !== ';' && line[i] !== ':') name += line[i++];
  let key = '', val = '', mode = 'none';
  if (line[i] === ';') { mode = 'key'; i++; }
  while (i < line.length && mode !== 'done') {
    const c = line[i];
    if (mode === 'key') {
      if (c === '=') { mode = 'val'; val = ''; }
      else if (c === ':') { mode = 'done'; }
      else key += c;
      i++;
    } else if (mode === 'val') {
      if (c === '"') { inQuote = !inQuote; i++; continue; }
      if (!inQuote && (c === ';' || c === ':')) {
        params[key.toUpperCase()] = val; key = ''; val = '';
        mode = c === ';' ? 'key' : 'done'; i++; continue;
      }
      val += c; i++;
    } else if (mode === 'none') {
      if (c === ':') { mode = 'done'; }
      i++;
    }
  }
  if (key && mode !== 'done') params[key.toUpperCase()] = val;
  return { name: name.toUpperCase().trim(), params, value: line.slice(i) };
}

/** Klassar ett TZID: 'stockholm' | 'utc' | 'okand' (okänd tolkas som Stockholm med varning). */
function icsTzClass(tzid) {
  const t = String(tzid || '').trim().toLowerCase();
  if (!t) return 'stockholm';
  if (KAL_UTC_TZID.indexOf(t) >= 0) return 'utc';
  if (KAL_STOCKHOLM_TZID.some(p => t.indexOf(p) >= 0)) return 'stockholm';
  return 'okand';
}

/**
 * Tolkar ett DATE/DATE-TIME-värde. Returnerar { datum, tid|null, heldag, utc, varning }.
 * utc=true betyder att datum/tid är UTC-väggtid (konverteras vid behov med icsPartsToLocal).
 */
function icsParseDateValue(value, params) {
  params = params || {};
  const v = String(value || '').trim();
  let m = /^(\d{4})(\d{2})(\d{2})$/.exec(v);
  if (m || String(params.VALUE || '').toUpperCase() === 'DATE') {
    m = m || /^(\d{4})(\d{2})(\d{2})/.exec(v);
    if (!m) return null;
    return { datum: m[1] + '-' + m[2] + '-' + m[3], tid: null, heldag: true, utc: false, varning: '' };
  }
  m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})?(Z)?$/.exec(v);
  if (!m) return null;
  const datum = m[1] + '-' + m[2] + '-' + m[3], tid = m[4] + ':' + m[5];
  if (m[7] === 'Z') return { datum, tid, heldag: false, utc: true, varning: '' };
  const klass = icsTzClass(params.TZID);
  if (klass === 'utc') return { datum, tid, heldag: false, utc: true, varning: '' };
  return { datum, tid, heldag: false, utc: false,
    varning: klass === 'okand' ? 'Tidszon ' + String(params.TZID).slice(0, 40) + ' tolkas som Stockholm' : '' };
}
/** UTC-väggtid → Stockholm-väggtid. Lokala/heldag returneras oförändrade. */
function icsPartsToLocal(p) {
  if (!p || !p.utc || p.heldag) return p;
  const d = new Date(Date.UTC(+p.datum.slice(0, 4), +p.datum.slice(5, 7) - 1, +p.datum.slice(8, 10), +p.tid.slice(0, 2), +p.tid.slice(3, 5)));
  const loc = tzParts(d);
  return Object.assign({}, p, { datum: loc.datum, tid: loc.tid, utc: false });
}
/** Lokal (Stockholm) nyckel för EXDATE/RECURRENCE-ID-matchning. */
function icsInstanceKey(p) {
  const l = icsPartsToLocal(p);
  return l.heldag ? l.datum : l.datum + 'T' + l.tid;
}
/** Epok-ms för ett parts-värde (heldag = lokal midnatt). */
function icsPartsMs(p) {
  if (!p) return NaN;
  if (p.heldag) return kalMsOf(toIsoWithOffset(p.datum, '00:00'));
  if (p.utc) return Date.UTC(+p.datum.slice(0, 4), +p.datum.slice(5, 7) - 1, +p.datum.slice(8, 10), +p.tid.slice(0, 2), +p.tid.slice(3, 5));
  return kalMsOf(toIsoWithOffset(p.datum, p.tid));
}
/** 'P1DT2H30M' → minuter (negativ tillåten). */
function icsParseDuration(v) {
  const m = /^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(String(v || '').trim());
  if (!m) return null;
  const min = (+m[2] || 0) * 7 * 1440 + (+m[3] || 0) * 1440 + (+m[4] || 0) * 60 + (+m[5] || 0) + Math.ceil((+m[6] || 0) / 60);
  return m[1] === '-' ? -min : min;
}
function icsParseRrule(v) {
  const r = {};
  String(v || '').split(';').forEach(part => {
    const i = part.indexOf('='); if (i < 0) return;
    r[part.slice(0, i).toUpperCase()] = part.slice(i + 1);
  });
  const out = { freq: String(r.FREQ || '').toUpperCase(), interval: Math.max(1, parseInt(r.INTERVAL, 10) || 1), count: r.COUNT ? parseInt(r.COUNT, 10) : null,
    until: r.UNTIL ? icsParseDateValue(r.UNTIL, {}) : null, byday: [] };
  if (r.BYDAY) out.byday = r.BYDAY.split(',').map(s => KAL_ICS_VECKODAG[s.replace(/^[+-]?\d+/, '').toUpperCase()]).filter(x => x !== undefined);
  return out;
}

/**
 * parseIcs(text) → { vevents:[...], varningar:[] }
 * VEVENT: { uid, summary, location, status, transp, busystatus, allDayHint, dtstart, dtend, durationMin,
 *           rrule, exdates:[parts], recurrenceId:parts|null, attendees:[{ epost, partstat }], varningar:[] }
 */
function parseIcs(text) {
  const lines = icsUnfold(text).split('\n');
  const vevents = [], varningar = [];
  let cur = null;
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    if (!raw) continue;
    if (/^BEGIN:VEVENT/i.test(raw)) {
      cur = { uid: '', summary: '', location: '', status: '', transp: '', busystatus: '', allDayHint: false,
        dtstart: null, dtend: null, durationMin: null, rrule: null, exdates: [], recurrenceId: null, attendees: [], varningar: [] };
      continue;
    }
    if (/^END:VEVENT/i.test(raw)) { if (cur) vevents.push(cur); cur = null; continue; }
    if (!cur) continue;
    const l = icsParseLine(raw);
    switch (l.name) {
      case 'UID': cur.uid = l.value.trim(); break;
      case 'SUMMARY': cur.summary = icsUnescape(l.value); break;
      case 'LOCATION': cur.location = icsUnescape(l.value); break;
      case 'STATUS': cur.status = l.value.trim().toUpperCase(); break;
      case 'TRANSP': cur.transp = l.value.trim().toUpperCase(); break;
      case 'X-MICROSOFT-CDO-BUSYSTATUS': cur.busystatus = l.value.trim().toUpperCase(); break;
      case 'X-MICROSOFT-CDO-ALLDAYEVENT': cur.allDayHint = l.value.trim().toUpperCase() === 'TRUE'; break;
      case 'DTSTART': cur.dtstart = icsParseDateValue(l.value, l.params); break;
      case 'DTEND': cur.dtend = icsParseDateValue(l.value, l.params); break;
      case 'DURATION': cur.durationMin = icsParseDuration(l.value); break;
      case 'RRULE': cur.rrule = icsParseRrule(l.value); break;
      case 'RECURRENCE-ID': cur.recurrenceId = icsParseDateValue(l.value, l.params); break;
      case 'EXDATE':
        l.value.split(',').forEach(v => { const p = icsParseDateValue(v, l.params); if (p) cur.exdates.push(p); });
        break;
      case 'ATTENDEE': {
        const m = /^(?:mailto:)?(.+)$/i.exec(l.value.trim());
        cur.attendees.push({ epost: m ? m[1].trim().toLowerCase() : '', partstat: String(l.params.PARTSTAT || '').toUpperCase() });
        break;
      }
      default: break;
    }
  }
  vevents.forEach(v => {
    [v.dtstart, v.dtend, v.recurrenceId].forEach(p => { if (p && p.varning && v.varningar.indexOf(p.varning) < 0) v.varningar.push(p.varning); });
  });
  return { vevents, varningar };
}

/**
 * expandRrule(vevent, fromDatum, toDatum) → [{ start:parts, slut:parts, recurrenceKey }] för instanser som
 * ÖVERLAPPAR fönstret [fromDatum, toDatum] (lokala datum). Stöd: DAILY/WEEKLY med INTERVAL, BYDAY, COUNT,
 * UNTIL. MONTHLY/YEARLY (och okända) returnerar bara mästarinstansen med varning:true.
 * Ren funktion: stegar i väggtid (UTC-väggtid för Z-serier, Stockholm-väggtid annars).
 */
function expandRrule(vevent, fromDatum, toDatum) {
  const out = [];
  const st = vevent.dtstart;
  if (!st) return out;
  const durMin = icsDurationMin(vevent);
  const mkInst = (p) => {
    const slut = icsAddMinutes(p, durMin);
    return { start: p, slut, recurrenceKey: icsInstanceKey(p) };
  };
  const inWindow = (inst) => {
    const s = icsPartsToLocal(inst.start), e = icsPartsToLocal(inst.slut);
    const slutDatum = e.heldag ? e.datum : (e.tid === '00:00' ? addDays(e.datum, -1) : e.datum);   // slut exklusivt
    return s.datum <= toDatum && slutDatum >= fromDatum;
  };
  const r = vevent.rrule;
  if (!r || (r.freq !== 'DAILY' && r.freq !== 'WEEKLY')) {
    const inst = mkInst(st); inst.varning = true;
    if (inWindow(inst)) out.push(inst);
    return out;
  }
  const untilMs = r.until ? icsPartsMs(r.until) + (r.until.heldag ? 1440 * 60000 - 1 : 0) : null;
  const startMs = icsPartsMs(st);
  // Instanser som slutar före fönstret behöver ingen tidszonsberäkning (M5, prestanda): en instans vars datum ligger mer än
  // durationen + 2 dagar före fönstret kan inte nå in i det. De räknas (COUNT) men konverteras aldrig.
  const hoppaFore = addDays(fromDatum, -(Math.ceil(durMin / 1440) + 2));
  let count = 0, iter = 0;
  const emit = (datum) => {                                  // returnerar false när serien är slut
    if (datum < hoppaFore && datum > st.datum && !(r.until && datum >= addDays(r.until.datum, -1))) {   // före fönstret (efter DTSTART, ej nära UNTIL): räkna, hoppa över
      if (r.count !== null && count >= r.count) return false;
      count++;
      return true;
    }
    const p = Object.assign({}, st, { datum });
    const ms = icsPartsMs(p);
    if (ms < startMs) return true;                           // före DTSTART: ingen instans
    if (untilMs !== null && ms > untilMs) return false;
    if (r.count !== null && count >= r.count) return false;
    count++;
    const inst = mkInst(p);
    if (inWindow(inst)) out.push(inst);
    if (icsPartsToLocal(p).datum > toDatum) return false;    // förbi fönstret
    return true;
  };
  if (r.freq === 'DAILY') {
    let d = st.datum;
    // Snabbspolning (serier utan COUNT): hoppa direkt till sista instansen före hoppaFore i intervallets takt.
    if (r.count === null && hoppaFore > d) { const steg = Math.floor(daysBetween(d, hoppaFore) / r.interval); if (steg > 0) d = addDays(d, steg * r.interval); }
    while (iter++ < KAL_MAX_RRULE_INSTANSER) {
      const wd = weekdayOf(d);
      if (!r.byday.length || r.byday.indexOf(wd) >= 0) { if (!emit(d)) break; }
      else if (d > toDatum) break;
      d = addDays(d, r.interval);
    }
  } else {                                                   // WEEKLY, veckan börjar måndag (WKST default MO)
    const bydays = r.byday.length ? r.byday : [weekdayOf(st.datum)];
    const veckostart = addDays(st.datum, -((weekdayOf(st.datum) + 6) % 7));
    let vecka = 0, slut = false;
    if (r.count === null && hoppaFore > veckostart) { const v = Math.floor(daysBetween(veckostart, hoppaFore) / (7 * r.interval)) - 1; if (v > 0) vecka = v; }
    while (!slut && iter++ < KAL_MAX_RRULE_INSTANSER) {
      const ws = addDays(veckostart, 7 * r.interval * vecka);
      for (let o = 0; o < 7; o++) {
        const d = addDays(ws, o);
        if (bydays.indexOf(weekdayOf(d)) < 0) continue;
        if (!emit(d)) { slut = true; break; }
      }
      if (ws > toDatum) slut = true;
      vecka++;
    }
  }
  return out;
}
function icsDurationMin(v) {
  if (v.dtend) {
    const ms = icsPartsMs(v.dtend) - icsPartsMs(v.dtstart);
    return Math.max(0, Math.round(ms / 60000));
  }
  if (v.durationMin !== null && v.durationMin !== undefined) return Math.max(0, v.durationMin);
  return v.dtstart && v.dtstart.heldag ? 1440 : 0;           // RFC 5545: DATE utan DTEND = en dag; DATE-TIME = nollängd
}
/** parts + minuter → parts i samma "väggtidsläge" (heldag stegar hela dagar, UTC stegar i UTC, lokal via ISO). */
function icsAddMinutes(p, min) {
  if (p.heldag) return Object.assign({}, p, { datum: addDays(p.datum, Math.max(1, Math.round(min / 1440))) });
  if (p.utc) {
    const d = new Date(icsPartsMs(p) + min * 60000);
    return { datum: d.toISOString().slice(0, 10), tid: d.toISOString().slice(11, 16), heldag: false, utc: true, varning: '' };
  }
  const loc = tzParts(new Date(kalMsOf(toIsoWithOffset(p.datum, p.tid)) + min * 60000));
  return { datum: loc.datum, tid: loc.tid, heldag: false, utc: false, varning: '' };
}

/**
 * Upptaget-regel per VEVENT (A8). Returnerar null (räknas inte) eller
 * { status:'busy'|'oof'|'tentative', preliminar:bool }.
 */
function icsBusyRule(v, telexiaEpost) {
  if (v.status === 'CANCELLED') return null;
  const heldag = !!(v.dtstart && v.dtstart.heldag);
  const mail = String(telexiaEpost || '').trim().toLowerCase();
  const egen = mail ? v.attendees.find(a => a.epost === mail) : null;
  const partstat = egen ? egen.partstat : '';
  if (partstat === 'DECLINED') return null;
  if (!heldag) {                                            // heldag: Ledig-status ignoreras (A8)
    if (v.transp === 'TRANSPARENT') return null;
    if (v.busystatus === 'FREE') return null;
  }
  const preliminar = v.busystatus === 'TENTATIVE' || partstat === 'NEEDS-ACTION' || partstat === 'TENTATIVE';
  const status = preliminar ? 'tentative' : (v.busystatus === 'OOF' ? 'oof' : 'busy');
  return { status, preliminar };
}

/**
 * icsInstances(parsed, fromDatum, toDatum, opts) → { handelser:[reducerad], varningar:[] }
 * Reducerad post (det som cachas, 4.6): { uid, start, slut, plats, summary, status, preliminar, heldag, varning }
 * start/slut = ISO med offset (heldag: 'YYYY-MM-DD', slut exklusivt). opts: { telexiaEpost }
 */
function icsInstances(parsed, fromDatum, toDatum, opts) {
  opts = opts || {};
  const varningar = parsed.varningar.slice();
  const perUid = {};
  parsed.vevents.forEach(v => {
    if (!v.dtstart) return;
    const uid = v.uid || ('utan-uid-' + Math.random().toString(36).slice(2, 10));
    if (!perUid[uid]) perUid[uid] = { master: null, overrides: [] };
    if (v.recurrenceId) perUid[uid].overrides.push(v); else perUid[uid].master = v;
  });
  const handelser = [];
  const pushInst = (v, startP, slutP, extraVarning) => {
    const regel = icsBusyRule(v, opts.telexiaEpost);
    if (!regel) return;
    const s = icsPartsToLocal(startP), e = icsPartsToLocal(slutP);
    const varn = (v.varningar.concat(extraVarning ? [extraVarning] : [])).join('; ');
    handelser.push({
      uid: v.uid, heldag: !!s.heldag,
      start: s.heldag ? s.datum : toIsoWithOffset(s.datum, s.tid),
      slut: e.heldag ? e.datum : toIsoWithOffset(e.datum, e.tid),
      plats: String(v.location || '').slice(0, KAL_ICS_PLATS_MAX), summary: String(v.summary || '').slice(0, KAL_ICS_SUMMARY_MAX),
      status: regel.status, preliminar: regel.preliminar, varning: varn
    });
  };
  Object.keys(perUid).forEach(uid => {
    const g = perUid[uid];
    const overrideKeys = {};
    g.overrides.forEach(o => { overrideKeys[icsInstanceKey(o.recurrenceId)] = true; });
    if (g.master) {
      const m = g.master;
      if (m.rrule) {
        const inst = expandRrule(m, fromDatum, toDatum);
        const exKeys = {};
        m.exdates.forEach(x => { exKeys[icsInstanceKey(x)] = true; });
        const serieVarning = (m.rrule.freq !== 'DAILY' && m.rrule.freq !== 'WEEKLY') ? 'återkommande (månad/år) – ej expanderad' : '';
        if (serieVarning) varningar.push('Outlook-serie ej expanderad (' + m.rrule.freq.toLowerCase() + '): ' + String(m.summary || '').slice(0, 60));
        inst.forEach(i => {
          if (exKeys[i.recurrenceKey] || overrideKeys[i.recurrenceKey]) return;   // EXDATE / ersatt av RECURRENCE-ID
          pushInst(m, i.start, i.slut, serieVarning);
        });
      } else {
        pushInst(m, m.dtstart, icsAddMinutes(m.dtstart, icsDurationMin(m)));
      }
    }
    g.overrides.forEach(o => {                              // flyttad/ändrad instans räknas en gång, på nya tiden
      const slut = icsAddMinutes(o.dtstart, icsDurationMin(o));
      const s = icsPartsToLocal(o.dtstart), e = icsPartsToLocal(slut);
      const slutDatum = e.heldag ? e.datum : (e.tid === '00:00' ? addDays(e.datum, -1) : e.datum);
      if (s.datum <= toDatum && slutDatum >= fromDatum) pushInst(o, o.dtstart, slut);
    });
  });
  const obesvarade = handelser.filter(h => h.preliminar).length;
  if (obesvarade > KAL_MAX_OBESVARADE) varningar.push('Många obesvarade Outlook-inbjudningar (' + obesvarade + ')');
  return { handelser, varningar };
}

/** Modulens egna blocktitlar (Code.gs syncBlockBerakna_, version 11): '🚗 Restid …' / '⏱ Marginal efter …', ev. med '⚠ ' först.
 *  K6 för ICS-vägen: speglar Outlook någon gång kalendern "Pipeline – restid" får blocken aldrig komma tillbaka som hinder. */
const KAL_BLOCK_TITEL_RE = /^(?:⚠ )?(?:🚗 Restid |⏱ Marginal efter )/;
/** Reducerad ICS-post → BusyItem-segment. opts: { raknaPreliminara:bool } */
function normalizeIcsItem(h, opts) {
  opts = opts || {};
  if (KAL_BLOCK_TITEL_RE.test(String(h.summary || ''))) return [];        // modulens eget restid-/marginalblock speglat via Outlook (K6)
  const preliminar = !!h.preliminar;
  const base = {
    id: 'ics:' + h.uid + (h.heldag ? ':' + h.start : ':' + String(h.start).slice(0, 16)),
    kalla: 'ics', uid: h.uid, matchIds: h.uid ? [h.uid] : [],
    summary: h.summary || '', plats: kalPlats(h.plats), hasPlace: kalLooksLikePlace(h.plats),
    preliminar, ignore: preliminar && !opts.raknaPreliminara, raknad: preliminar && !!opts.raknaPreliminara,
    varning: h.varning || '', icsStatus: h.status || 'busy'
  };
  if (h.heldag) return heldagSegments(h.start, h.slut, base);
  return splitToDays(new Date(h.start), new Date(h.slut), base);
}

// -------------------------------------------------------------------------------------
// 1c. Reservationer och inkorgsbokningar → BusyItem
// -------------------------------------------------------------------------------------

/** Reservation ur res:index (4.8/5.11) → segment. opts: { reservationId } = anropande bokarens egen. */
function reservationToBusy(rs, opts) {
  opts = opts || {};
  if (!rs || !rs.start || !rs.slut) return [];
  const egen = !!(opts.reservationId && rs.id === opts.reservationId);
  const plats = kalPlats(rs.plats);            // rs.plats = { text, lat, lng, geokodad } | null (Code.gs createReservation)
  const base = {
    id: String(rs.id || ''), kalla: 'reservation', matchIds: [],
    plats, hasPlace: plats.geokodad || kalLooksLikePlace(plats.text),
    cooldownMin: rs.cooldownMin | 0, bokareId: String(rs.bokareId || ''), motestypId: String(rs.motestypId || ''),
    egen: egen || (!!opts.bokareId && rs.bokareId === opts.bokareId), egenReservation: egen,
    ignore: egen,                                            // egen reservation är varken hinder eller ankare (5.11)
    summary: 'Reservation'
  };
  return splitToDays(new Date(rs.start), new Date(rs.slut), base);
}

/** Inkorgspost med status ny/importerad (bokad) → segment; kalla 'bokningar', id 'bk_<bokningId>'.
 *  opts: { cooldownFor, restidFor } – restidFor(motestypId) === false (Teams-fix, version 7) → hasPlace:false: adress/geo/omrade
 *  behålls på plats för visning (Kalenderkoll), men posten blir aldrig restidsankare. */
function inboxBookingToBusy(b, opts) {
  opts = opts || {};
  if (!b || !b.start || !b.slut) return [];
  const st = String(b.status || '');
  if (st !== 'ny' && st !== 'importerad' && st !== 'bokad' && st !== 'ombokad') return [];
  const utanRestid = typeof opts.restidFor === 'function' && opts.restidFor(String(b.motestypId || '')) === false;
  const base = {
    id: 'bk_' + String(b.bokningId || ''), kalla: 'bokningar', matchIds: b.kalenderEventId ? [String(b.kalenderEventId)] : [],
    eventId: String(b.kalenderEventId || ''),
    plats: kalPlats(b.adress), hasPlace: !utanRestid && kalLooksLikePlace(b.adress),
    cooldownMin: typeof opts.cooldownFor === 'function' ? (opts.cooldownFor(b.motestypId) | 0) : 0,
    bokningId: String(b.bokningId || ''), bokareId: String(b.bokareId || ''), motestypId: String(b.motestypId || ''),
    pipelineId: String(b.pipelineId || ''), kundnamn: b.kund && b.kund.namn ? String(b.kund.namn) : '',
    summary: 'Bokning'                              // aldrig kundnamn i titeln (calendar-preview, M4) – kundnamn är eget fält (bara ägande bokare)
  };
  if (b.geo && typeof b.geo.lat === 'number' && typeof b.geo.lng === 'number') {
    base.plats.lat = b.geo.lat; base.plats.lng = b.geo.lng; base.plats.geokodad = true; base.hasPlace = !utanRestid;
    if (typeof b.geo.omrade === 'string' && b.geo.omrade.trim()) base.plats.omrade = b.geo.omrade.trim().slice(0, 60);   // steg 2c: områdesetikett
  }
  return splitToDays(new Date(b.start), new Date(b.slut), base);
}

// -------------------------------------------------------------------------------------
// 1d. mergeBusy, applyIgnore, finalizeBusy, busyForDay
// -------------------------------------------------------------------------------------

function kalItemKanSlasIhop(a, b) {
  if (a.kalla === 'reservation' || b.kalla === 'reservation') return false;   // reservationer slås aldrig ihop
  if (a.datum !== b.datum) return false;
  if (a.heldag !== b.heldag) return false;                                     // heldag bara med heldag
  if (a.bokningId && b.bokningId) return a.bokningId === b.bokningId;          // regel 0: samma bokning
  // regel 1: ICS-UID = Googles iCalUID (Outlooks accepterade inbjudan från Bokningar)
  if (a.kalla === 'ics' && b.kalla !== 'ics' && a.uid && b.iCalUID && a.uid === b.iCalUID) return true;
  if (b.kalla === 'ics' && a.kalla !== 'ics' && b.uid && a.iCalUID && b.uid === a.iCalUID) return true;
  if (a.heldag && b.heldag) return true;
  // regel 2: samma start och slut (±5 min) eller överlapp ≥ 90 % av den kortare
  const tol = KAL_MERGE_TOLERANS_MIN;
  if (Math.abs(a.startMin - b.startMin) <= tol && Math.abs(a.slutMin - b.slutMin) <= tol) return true;
  const overlapp = Math.min(a.slutMin, b.slutMin) - Math.max(a.startMin, b.startMin);
  const kortast = Math.min(a.slutMin - a.startMin, b.slutMin - b.startMin);
  return kortast > 0 && overlapp / kortast >= KAL_MERGE_OVERLAPP;
}
/** Vilken av två sammanslagningsbara poster som vinner: räknas > plats > bokningar > privat > ics. */
function kalVinnare(a, b) {
  const ra = a.ignore ? 0 : 1, rb = b.ignore ? 0 : 1;
  if (ra !== rb) return ra > rb ? a : b;
  if (a.hasPlace !== b.hasPlace) return a.hasPlace ? a : b;
  const pa = KAL_KALLA_PRIO[a.kalla] || 0, pb = KAL_KALLA_PRIO[b.kalla] || 0;
  if (pa !== pb) return pa > pb ? a : b;
  return a;
}
function kalUnik(arr) { return arr.filter((x, i) => x && arr.indexOf(x) === i); }

/**
 * mergeBusy(list) → ny lista utan dubbletter (spec 4.6 "Dubblettsammanslagning").
 * Den sammanslagna posten får vinnarens identitet, unionen av tiden (hellre för mycket hinder än dubbelbokning),
 * plats från den som har plats – en redan geokodad plats (inkorgspostens geo, lat/lng från bokningens geokodning) före en ren
 * platstext (kalenderhändelsens location), så att bokningens ankare inte geokodas om per text (steg 2b: place_id-resultatet cachas
 * inte under adresstexten – utan denna regel gjorde varje bokad adress ett extra Geocoding-anrop som ankare);
 * cooldown = max, räknas om någon räknas, `sammanslagenMed` = förlorarnas id.
 */
function mergeBusy(list) {
  const items = (list || []).map(x => Object.assign({}, x, {
    plats: Object.assign({}, x.plats || kalPlats('')),
    sammanslagenMed: (x.sammanslagenMed || []).slice(), matchIds: (x.matchIds || []).slice()
  }));
  const out = [];
  items.forEach(item => {
    let cur = item;
    for (let i = 0; i < out.length; i++) {
      const other = out[i];
      if (!kalItemKanSlasIhop(cur, other)) continue;
      const v = kalVinnare(other, cur), l = v === other ? cur : other;
      const merged = Object.assign({}, v, {
        startMin: Math.min(v.startMin, l.startMin), slutMin: Math.max(v.slutMin, l.slutMin),
        plats: v.plats.geokodad ? v.plats : (l.plats.geokodad ? l.plats : (v.hasPlace ? v.plats : (l.hasPlace ? l.plats : v.plats))),
        hasPlace: v.hasPlace || l.hasPlace,
        cooldownMin: Math.max(v.cooldownMin | 0, l.cooldownMin | 0),
        ignore: v.ignore && l.ignore, preliminar: v.preliminar && l.preliminar, raknad: v.raknad || l.raknad,
        egen: v.egen || l.egen, kundnamn: v.kundnamn || l.kundnamn,
        bokningId: v.bokningId || l.bokningId, bokareId: v.bokareId || l.bokareId, motestypId: v.motestypId || l.motestypId,
        iCalUID: v.iCalUID || l.iCalUID, uid: v.uid || l.uid,
        varning: v.varning || l.varning,
        sammanslagenMed: kalUnik(v.sammanslagenMed.concat([l.id], l.sammanslagenMed)),
        matchIds: kalUnik(v.matchIds.concat(l.matchIds))
      });
      merged.start = kalIsoAt(merged.datum, merged.startMin);
      merged.slut = kalIsoAt(merged.datum, merged.slutMin);
      out.splice(i, 1);
      cur = merged; i = -1;                                   // börja om: den sammanslagna kan matcha fler
    }
    out.push(cur);
  });
  return out.sort((a, b) => a.datum < b.datum ? -1 : a.datum > b.datum ? 1 : a.startMin - b.startMin);
}

/**
 * applyIgnore(list, ignorerade) → ny lista. `ignorerade` = config.ignorerade (KALENDER_IGNORERA, 3.5; version 9: restid-override):
 *   lage 'ignorera' → ignore:true, ignorerad:true (visas gråad i Kalenderkoll, aldrig hinder)
 *   lage 'rakna'    → preliminär post räknas: ignore:false, raknad:true
 *   lage 'restid'   → varken ignorera eller räkna – posten bär BARA restid-override (online/adress nedan)
 *   Bara exakt 'ignorera'/'rakna' räknas (version 9) – saknat, tomt eller okänt lage gör varken ignorera eller räkna. Gamla poster
 *   utan lage (3.5-migreringen) får 'ignorera' av appens uppstartsnormalisering innan de pushas; scriptet gissar inte längre.
 * Restid-override (version 9, oberoende av lage) – manuell klassning vinner över automatiken (kalLooksLikePlace/KAL_ONLINE_RE och
 * mötestypens restid-flagga): se kalTillampaOverride. En post per händelse-id; Ignorera/Räkna och online/adress samsas i samma post.
 * Matchar på id utan prefix mot item.matchIds (Google event-id, recurringEventId, ICS UID). Räckvidd: en post med instans-id:t
 * (Googles `<serie>_<tid>Z`, = calendar-preview ignoreraId) träffar bara den instansen; en post med recurringEventId
 * (calendar-preview serieId) eller ICS UID (delas av seriens alla instanser) träffar hela serien.
 */
function applyIgnore(list, ignorerade) {
  const ign = {}, rakna = {}, over = {};
  (ignorerade || []).forEach(p => {
    if (!p || !p.id) return;
    const id = String(p.id), o = kalOverrideAv(p);
    if (p.lage === 'ignorera') ign[id] = true; else if (p.lage === 'rakna') rakna[id] = true;
    if (o) over[id] = o;
  });
  return (list || []).map(x => {
    const item = Object.assign({}, x);
    const ids = item.matchIds || [];
    if (ids.some(id => ign[id])) { item.ignore = true; item.ignorerad = true; }
    else if (item.preliminar && ids.some(id => rakna[id])) { item.ignore = false; item.raknad = true; }
    const oid = ids.find(id => over[id] !== undefined);
    if (oid !== undefined) kalTillampaOverride(item, over[oid]);
    return item;
  });
}
/** KALENDER_IGNORERA-post → restid-override { online:true|false|null, adress, lat, lng, omrade } eller null när posten saknar online/adress.
 *  Fälten saneras redan i normalizeConfig (Code.gs) – här bara typkontroll: adress ≤ 200 tecken, lat/lng finita tal (annars ingen
 *  koordinat), omrade ≤ 60 tecken och bara tillsammans med koordinater (som kalPlats). */
function kalOverrideAv(p) {
  const online = p.online === true ? true : p.online === false ? false : null;
  const adress = typeof p.adress === 'string' ? p.adress.trim().slice(0, 200) : '';
  if (online === null && !adress) return null;
  const geo = !!adress && typeof p.lat === 'number' && typeof p.lng === 'number' && isFinite(p.lat) && isFinite(p.lng);
  const omrade = geo && typeof p.omrade === 'string' && p.omrade.trim() ? p.omrade.trim().slice(0, 60) : '';
  return { online, adress, lat: geo ? p.lat : null, lng: geo ? p.lng : null, omrade };
}
/** Tillämpar en restid-override på ett BusyItem (muterar item – applyIgnore arbetar redan på en kopia; plats kopieras här):
 *    adress med lat/lng → plats = { text: adress, lat, lng, geokodad:true, omrade? } och hasPlace:true (om inte online === true)
 *    adress utan lat/lng → plats.text byts, geokodad:false (geokodaAnkare i Availability.gs geokodar texten som förut), hasPlace:true (dito)
 *    online === true    → hasPlace:false – vinner över allt (även adress och mötestypens flagga)
 *    online === false   → hasPlace:true när platsen har text eller koordinater (åsidosätter KAL_ONLINE_RE och restidFor).
 *                         Är texten ett online-ord/URL (kalLooksLikePlace false, t.ex. "Microsoft Teams-möte") utan rättad adress
 *                         töms plats.text: ankare med schablon (5.13) i stället för att geokodaAnkare slår upp texten hos Google
 *                         (ett felankare någonstans i landet vore värre än schablon). Kalenderkoll visar då tom plats – rätta adressen.
 *  item.override = { online, adress } markerar posten för finalizeBusy (restidFor-skyddsnätet) och previewExport. */
function kalTillampaOverride(item, o) {
  const plats = Object.assign({}, item.plats || kalPlats(''));
  if (o.adress) {
    const geo = o.lat !== null;
    plats.text = o.adress; plats.lat = geo ? o.lat : null; plats.lng = geo ? o.lng : null; plats.geokodad = geo;
    if (geo && o.omrade) plats.omrade = o.omrade; else delete plats.omrade;
  }
  if (o.online === true) item.hasPlace = false;
  else if (o.online === false) {
    item.hasPlace = !!(plats.text || plats.geokodad);
    if (!o.adress && !plats.geokodad && plats.text && !kalLooksLikePlace(plats.text)) plats.text = '';
  }
  else if (o.adress) item.hasPlace = true;
  item.plats = plats;
  item.override = { online: o.online, adress: o.adress };
}

/** Sätter härledda fält (isTravelMeeting = hasPlace && !ignore, heldag aldrig ankare), den effektiva bufferten cooldownMin
 *  (version 10, K3: heldag ? 0 : max(cooldownMin, isTravelMeeting ? opts.marginal.fysisktMin : opts.marginal.onlineMin) – för ALLA
 *  poster, även ignorerade (de är ändå inte hinder); opts.marginal = kalMarginal_(config), utelämnad → defaults 15/5)
 *  och rensar kundnamn på andras poster.
 *  opts.restidFor (Teams-fix, version 7): en sammanslagen post med motestypId vars typ saknar restid får hasPlace:false – fångar
 *  Outlooks ICS-kopia av en äldre Teams-bokning (LOCATION satt före version 7): den vinner sammanslagningen på hasPlace och bär
 *  förlorarens bokningId/motestypId, så regeln i normalizeGoogleEvent/inboxBookingToBusy räcker inte ensam.
 *  Skyddsnätet gäller INTE en post med manuell override (version 9: item.override med online === false eller adress, applyIgnore) –
 *  CJ:s klassning vinner över mötestypens flagga. */
function finalizeBusy(list, opts) {
  opts = opts || {};
  const marginal = opts.marginal || kalMarginal_(null);
  return (list || []).map(x => {
    const item = Object.assign({}, x);
    const manuell = !!item.override && (item.override.online === false || !!item.override.adress);
    if (!manuell && item.motestypId && typeof opts.restidFor === 'function' && opts.restidFor(item.motestypId) === false) item.hasPlace = false;
    item.isTravelMeeting = !!item.hasPlace && !item.ignore && !item.heldag;
    // Effektiv buffert efter händelsen (version 10): mötestypens cooldown eller marginalen, det största; heldag har ingen.
    item.cooldownMin = item.heldag ? 0 : Math.max(item.cooldownMin | 0, item.isTravelMeeting ? marginal.fysisktMin : marginal.onlineMin);
    if (item.kalla === 'bokningar' || item.kalla === 'reservation') {
      item.egen = item.egen || (!!opts.bokareId && item.bokareId === opts.bokareId);
    }
    if (!item.egen) item.kundnamn = '';                      // kundnamn exporteras bara till ägande bokare (5.2)
    return item;
  });
}
function busyForDay(list, datum) { return (list || []).filter(b => b.datum === datum); }

// =====================================================================================
// 2. WRAPPERS RUNT APPS SCRIPT-TJÄNSTER
// =====================================================================================

function kalFel_(code, message) { const e = new Error(message || code); e.code = code; return e; }
function kalNu_() { return new Date(); }
function kalCache_() { return CacheService.getScriptCache(); }
function kalByteLength_(s) { return Utilities.newBlob(String(s)).getBytes().length; }
/** RFC3339 med offset i scriptets tidszon (spec 4.6). */
function rfc3339_(d) { return Utilities.formatDate(d, Session.getScriptTimeZone() || KAL_TZ, "yyyy-MM-dd'T'HH:mm:ssXXX"); }
function kalKlockslagNu_() { return Utilities.formatDate(kalNu_(), KAL_TZ, 'HH:mm'); }

/** events.list med pageToken-loop (4.6). Kastar E_CALENDAR vid API-fel. */
function listGoogleEvents_(calendarId, timeMin, timeMax) {
  const out = [];
  let pageToken = null, guard = 0;
  try {
    do {
      const params = { timeMin, timeMax, singleEvents: true, orderBy: 'startTime', maxResults: 2500, showDeleted: false };
      if (pageToken) params.pageToken = pageToken;
      const res = Calendar.Events.list(calendarId, params);
      (res.items || []).forEach(ev => out.push(ev));
      pageToken = res.nextPageToken || null;
    } while (pageToken && guard++ < 50);
  } catch (err) {
    throw kalFel_('E_CALENDAR', 'Kalendern kunde inte läsas');
  }
  return out;
}
/** events.list för avstämningen (4.11, A52): avgränsad till [timeMin, timeMax) med singleEvents och bara de fält som behövs
 *  (id, status, updated, start, end, summary, private.bokningId) – aldrig updatedMin utan tidsgräns (ett aldrig slutande
 *  återkommande möte i en delad kalender skulle annars expanderas till 50 × 2 500 poster). Raderade filtreras bort. Kastar E_CALENDAR. */
function listGoogleEventsAvstamning_(calendarId, timeMin, timeMax) {
  const out = [];
  let pageToken = null, guard = 0;
  try {
    do {
      const params = { timeMin, timeMax, singleEvents: true, maxResults: 2500, showDeleted: false,
        fields: 'nextPageToken,items(id,status,updated,start,end,summary,extendedProperties/private/bokningId)' };
      if (pageToken) params.pageToken = pageToken;
      const res = Calendar.Events.list(calendarId, params);
      (res.items || []).forEach(ev => { if (ev && ev.status !== 'cancelled') out.push(ev); });
      pageToken = res.nextPageToken || null;
    } while (pageToken && guard++ < 50);
  } catch (err) {
    throw kalFel_('E_CALENDAR', 'Kalendern kunde inte läsas');
  }
  return out;
}
/** events.list på privateExtendedProperty bokningId=<id> (purge 4.4: händelse vars event-id inte är känt). Raderade och redan
 *  anonymiserade händelser ("Möte (borttaget)", A19 – ifall bryggan behållit bokningId, V13) filtreras bort. Kastar E_CALENDAR. */
function listGoogleEventsByBokningId_(calendarId, bokningId) {
  try {
    const res = Calendar.Events.list(calendarId, { privateExtendedProperty: 'bokningId=' + String(bokningId), singleEvents: true, maxResults: 50, showDeleted: false });
    return (res.items || []).filter(ev => ev && ev.id && ev.status !== 'cancelled' && String(ev.summary || '') !== 'Möte (borttaget)');
  } catch (err) {
    throw kalFel_('E_CALENDAR', 'Kalendern kunde inte läsas');
  }
}

/** Hämtar ICS-texten. Returnerar null vid nätverks-/HTTP-fel (URL:en loggas aldrig). */
function hamtaIcs_(url) {
  try {
    const res = UrlFetchApp.fetch(url, { muteHttpExceptions: true, followRedirects: true, validateHttpsCertificates: true });
    if (res.getResponseCode() !== 200) return null;
    return res.getContentText('UTF-8');
  } catch (err) {
    return null;
  }
}

/** Aktiva reservationer ur CacheService (res:index + res:<id>, 4.8). Utgångna filtreras (rensas av reservationsmodulen). */
function lasReservationer_() {
  try {
    const cache = kalCache_();
    const raw = cache.get('res:index');
    if (!raw) return [];
    const lista = JSON.parse(raw);
    if (!Array.isArray(lista) || !lista.length) return [];
    const nu = kalNu_().getTime();
    const ids = lista.map(r => 'res:' + r.id);
    const finns = cache.getAll(ids) || {};
    return lista.filter(r => {
      if (!r || !r.id || !finns['res:' + r.id]) return false;
      if (r.expires === undefined || r.expires === null) return true;
      const exp = typeof r.expires === 'number' ? r.expires : kalMsOf(r.expires);
      return !(exp < nu);
    });
  } catch (err) {
    return [];
  }
}

/** ICS-reserv i cache-filen (4.1 icsReserv). Filhanteringen ägs av Code.gs: readIcsReserv()/writeIcsReserv(obj). */
function lasIcsReserv_() {
  try { return typeof readIcsReserv === 'function' ? (readIcsReserv() || null) : null; } catch (err) { return null; }
}
// icsReserv skrivs till cache-filen högst var 15:e minut (KAL_ICS_RESERV_MIN_ALDER_MS): först grindas på meta.reservTs i
// CacheService (ingen Drive-läsning), därefter på filens egen hamtadTs (writeIcsReserv, Availability.gs). Ett flöde som
// inte ryms i CacheService läses annars live vid varje anrop och skulle skriva filen varje gång.
// Returnerar den reservTs som gäller efter anropet (ny eller befintlig).
function sparaIcsReserv_(reserv, meta) {
  const nu = kalNu_().getTime();
  const senast = meta && typeof meta.reservTs === 'string' && meta.reservTs ? kalMsOf(meta.reservTs) : NaN;
  if (!isNaN(senast) && nu - senast < KAL_ICS_RESERV_MIN_ALDER_MS) return meta.reservTs;
  try {
    if (typeof writeIcsReserv === 'function' && writeIcsReserv(reserv, { minAlderMs: KAL_ICS_RESERV_MIN_ALDER_MS })) return reserv.hamtadTs;
  } catch (err) { /* best effort – fäller aldrig läsningen */ }
  return meta && typeof meta.reservTs === 'string' ? meta.reservTs : '';
}

/** Konfig och inkorg ägs av Code.gs (loadConfig / readInbox). */
// Blockkalenderns id (version 11, Code.gs blockKalenderId_ → Script Property BLOCK_KALENDER_ID); '' när funktionen saknas (Node-test) eller inget id finns.
function kalBlockKalenderId_() {
  try { return typeof blockKalenderId_ === 'function' ? String(blockKalenderId_() || '') : ''; } catch (err) { return ''; }
}
function kalConfig_(opts) {
  if (opts && opts.config) return opts.config;
  if (typeof loadConfig !== 'function') throw kalFel_('E_SETUP', 'Konfigurationen är inte tillgänglig');
  return loadConfig();
}
function kalInbox_(opts) {
  if (opts && opts.inbox) return opts.inbox;
  if (typeof readInbox !== 'function') return null;
  return readInbox();
}

// =====================================================================================
// 3. SAMMANSÄTTNING
// =====================================================================================

/** Marginal efter varje möte (version 10, installningar.marginalFysisktMin/marginalOnlineMin, defaults 15/5) → { fysisktMin, onlineMin }.
 *  finalizeBusy höjer cooldownMin till minst detta (fysiskt = restidsankare, online = platslös händelse). */
function kalMarginal_(config) {
  const inst = config && config.installningar ? config.installningar : {};
  const num = (v, d) => (typeof v === 'number' && isFinite(v)) ? v : d;
  return { fysisktMin: num(inst.marginalFysisktMin, 15), onlineMin: num(inst.marginalOnlineMin, 5) };
}
/** cooldownMin per mötestyp (även inaktiva – bokade möten med borttagen typ ska behålla sin cooldown). */
function kalCooldownFn_(config) {
  const map = {};
  ((config && config.motestyper) || []).forEach(m => { if (m && m.id) map[m.id] = m.cooldownMin | 0; });
  return id => map[id] || 0;
}
/** restid per mötestyp (Teams-fix, version 7): motestypId → typ.restid === true. Okänd/borttagen typ → true (hellre ett ankare
 *  för mycket än en dubbelbokad resa). Används av normalizeGoogleEvent ('bokningar' med extendedProperties.private.motestypId)
 *  och inboxBookingToBusy: restidFor(motestypId) === false → hasPlace:false (plats/omrade får finnas kvar för visning, inget ankare). */
function kalRestidFn_(config) {
  const map = {};
  ((config && config.motestyper) || []).forEach(m => { if (m && m.id) map[m.id] = m.restid === true; });
  return id => (id && Object.prototype.hasOwnProperty.call(map, id) ? map[id] : true);
}
function kalHorisontVeckor_(config) {
  const v = config && config.installningar ? parseInt(config.installningar.horisontVeckor, 10) : 0;
  return v > 0 ? v : 6;
}
function kalFiltreraDatum_(handelser, fran, till) {
  return (handelser || []).filter(h => {
    const s = String(h.start).slice(0, 10), e = String(h.slut).slice(0, 10);
    const slutDatum = h.heldag ? addDays(e, -1) : (String(h.slut).slice(11, 16) === '00:00' ? addDays(e, -1) : e);
    return s <= till && slutDatum >= fran;
  });
}

/**
 * readIcs(config, opts) → { ok, handelser:[reducerad], varningar:[], hamtadTs, kalla:'ingen'|'cache'|'live'|'reserv' }
 * Cache 15 min i CacheService (ics:busy-index + ics:busy:<n>, gzip+base64 i bitar ≤ 90 KB – M5), filtrerad till [idag−1, horisont+1]
 * och reducerad (uid, start, slut, plats ≤ 200, summary ≤ 160, status, preliminar, heldag, varning) före cachning; fler än
 * KAL_ICS_MAX_CHUNKS bitar → ingen cache. Misslyckad hämtning → icsReserv ur cache-filen + varning "Outlook-flödet kunde inte läsas
 * kl HH:MM". Långsam hämtning (> 5 s) → i 30 min används en färsk icsReserv (< 60 min) vid cache-miss i stället för ny hämtning (A46).
 * opts: { farsk:bool }
 * Memo per körning (KAL_ICS_MEMO): andra anropet i samma request (t.ex. under låset i reserve/book) får en kopia av
 * första resultatet – aldrig UrlFetch under låset. opts.farsk läser om och förnyar memot.
 */
function readIcs(config, opts) {
  opts = opts || {};
  const inst = (config && config.installningar) || {};
  const url = String(inst.outlookIcsUrl || '').trim();
  if (!url) return { ok: true, handelser: [], varningar: [], hamtadTs: '', kalla: 'ingen' };
  if (!opts.farsk && KAL_ICS_MEMO && KAL_ICS_MEMO.url === url) return kalKopieraIcsRes_(KAL_ICS_MEMO.res);
  const res = readIcsUncached_(config, url, opts);
  KAL_ICS_MEMO = { url, res: kalKopieraIcsRes_(res) };
  return res;
}
function kalKopieraIcsRes_(res) {
  return { ok: res.ok, handelser: JSON.parse(JSON.stringify(res.handelser || [])), varningar: (res.varningar || []).slice(), hamtadTs: res.hamtadTs || '', kalla: res.kalla };
}
function readIcsUncached_(config, url, opts) {
  const inst = (config && config.installningar) || {};
  const res = { ok: true, handelser: [], varningar: [], hamtadTs: '', kalla: 'ingen' };
  if (!/^https:\/\/\S+$/i.test(url)) { res.ok = false; res.varningar.push('Fältet Outlook-ICS är inte en https-adress'); return res; }
  const cache = kalCache_();
  const idag = todayStr();
  const fran = addDays(idag, -1), till = addDays(addDays(idag, 7 * kalHorisontVeckor_(config)), 1);
  let meta = null;
  try { const m = cache.get(KAL_ICS_META_KEY); meta = m ? JSON.parse(m) : null; } catch (err) { meta = null; }
  const nuMs = kalNu_().getTime();

  if (!opts.farsk) {
    const c = kalIcsCacheLas_(cache);
    if (c) {
      res.handelser = kalFiltreraDatum_(c.handelser, fran, till);
      res.kalla = 'cache'; res.hamtadTs = (meta && meta.hamtadTs) || c.hamtadTs || '';
      res.varningar = meta && Array.isArray(meta.varningar) ? meta.varningar.slice() : [];
      return res;
    }
    if (meta && meta.felTs && (nuMs - kalMsOf(meta.felTs)) < KAL_ICS_FEL_CACHE_S * 1000) {
      return kalIcsReservSvar_(res, meta, fran, till);        // nyligen misslyckat – vänta med nytt försök
    }
    // Långsamt Outlook nyligen (A46): färsk reserv i cache-filen i stället för ny hämtning.
    if (meta && meta.langsamTs && (nuMs - kalMsOf(meta.langsamTs)) < KAL_ICS_LANGSAM_S * 1000) {
      const reserv = lasIcsReserv_();
      const alder = reserv && typeof reserv.hamtadTs === 'string' && reserv.hamtadTs ? nuMs - kalMsOf(reserv.hamtadTs) : NaN;
      if (reserv && Array.isArray(reserv.handelser) && !isNaN(alder) && alder >= 0 && alder < KAL_ICS_RESERV_MAX_ALDER_MS) {
        res.handelser = kalFiltreraDatum_(reserv.handelser, fran, till);
        res.hamtadTs = reserv.hamtadTs; res.kalla = 'reserv';
        res.varningar = (meta && Array.isArray(meta.varningar) ? meta.varningar : []).filter(v => !/^Outlook-flödet svarade långsamt/.test(v));
        res.varningar.push('Outlook-flödet svarade långsamt kl ' + (meta.langsamKlockslag || '') + ' – kopian från kl ' + String(reserv.hamtadTs).slice(11, 16) + ' används');
        kalIcsCacheSkriv_(cache, res.handelser, reserv.hamtadTs);
        try { cache.put(KAL_ICS_META_KEY, JSON.stringify(Object.assign({}, meta, { varningar: res.varningar.slice(0, 20), hamtadTs: reserv.hamtadTs })), 6 * 3600); } catch (err) { /* ignore */ }
        return res;
      }
    }
  }

  const t0 = kalNu_().getTime();
  const text = hamtaIcs_(url);
  const hamtningMs = kalNu_().getTime() - t0;
  if (text === null) {
    const nyMeta = Object.assign({}, meta || {}, { ok: false, felTs: rfc3339_(kalNu_()), felKlockslag: kalKlockslagNu_() });
    try { cache.put(KAL_ICS_META_KEY, JSON.stringify(nyMeta), 6 * 3600); } catch (err) { /* ignore */ }
    return kalIcsReservSvar_(res, nyMeta, fran, till);
  }

  let parsed, inst2;
  try {
    parsed = parseIcs(text);
    inst2 = icsInstances(parsed, fran, till, { telexiaEpost: inst.telexiaEpost });
  } catch (err) {
    const nyMeta = Object.assign({}, meta || {}, { ok: false, felTs: rfc3339_(kalNu_()), felKlockslag: kalKlockslagNu_() });
    try { cache.put(KAL_ICS_META_KEY, JSON.stringify(nyMeta), 6 * 3600); } catch (e2) { /* ignore */ }
    return kalIcsReservSvar_(res, nyMeta, fran, till);
  }
  const hamtadTs = rfc3339_(kalNu_());
  // Filtrera till [idag−1, horisont+1] FÖRE cachning/reserv (4.6): enstaka händelser utanför fönstret (icsInstances filtrerar
  // bara serier och RECURRENCE-ID-instanser) ska varken ta cacheplats eller skrivas till cache-filen.
  res.handelser = kalFiltreraDatum_(inst2.handelser, fran, till); res.varningar = inst2.varningar; res.hamtadTs = hamtadTs; res.kalla = 'live';
  const cachad = kalIcsCacheSkriv_(cache, res.handelser, hamtadTs);
  const langsam = hamtningMs > KAL_ICS_LANGSAM_MS;
  const nyMeta = {
    ok: true, hamtadTs, felTs: '', felKlockslag: '', antal: res.handelser.length,
    medPlats: res.handelser.filter(h => kalLooksLikePlace(h.plats)).length,
    preliminara: res.handelser.filter(h => h.preliminar).length, varningar: res.varningar.slice(0, 20),
    hamtningMs: hamtningMs, cachad: cachad,
    langsamTs: langsam ? hamtadTs : '', langsamKlockslag: langsam ? kalKlockslagNu_() : '',
    reservTs: sparaIcsReserv_({ hamtadTs, handelser: res.handelser }, meta)
  };
  try { cache.put(KAL_ICS_META_KEY, JSON.stringify(nyMeta), 6 * 3600); } catch (err) { /* ignore */ }
  return res;
}
// --- Komprimerad, chunkad CacheService-cache för ICS-resultatet (M5) ---
// kalIcsPacka_(handelser) → { delar:[base64-bitar], langd, jsonBytes } | null (för stort). Rena Utilities-anrop, ingen I/O.
function kalIcsPacka_(handelser) {
  const json = JSON.stringify(handelser);
  const gz = Utilities.gzip(Utilities.newBlob(json, 'application/json'));
  const b64 = Utilities.base64Encode(gz.getBytes());
  const delar = [];
  for (let i = 0; i < b64.length; i += KAL_ICS_CHUNK_BYTES) delar.push(b64.slice(i, i + KAL_ICS_CHUNK_BYTES));
  if (!delar.length || delar.length > KAL_ICS_MAX_CHUNKS) return null;
  return { delar, langd: b64.length, jsonBytes: kalByteLength_(json) };
}
function kalIcsPackaUpp_(delar) {
  const bytes = Utilities.base64Decode(delar.join(''));
  const json = Utilities.ungzip(Utilities.newBlob(bytes, 'application/x-gzip')).getDataAsString('UTF-8');
  const lista = JSON.parse(json);
  return Array.isArray(lista) ? lista : null;
}
/** Skriver ics:busy (index) + ics:busy:<n> (bitar) med samma TTL. → true om cachat. Kastar aldrig. */
function kalIcsCacheSkriv_(cache, handelser, hamtadTs) {
  let paket = null;
  try { paket = kalIcsPacka_(handelser); } catch (err) { paket = null; }
  if (!paket) return false;
  const put = {};
  paket.delar.forEach((d, i) => { put[KAL_ICS_CACHE_KEY + ':' + i] = d; });
  put[KAL_ICS_CACHE_KEY] = JSON.stringify({ v: KAL_ICS_CACHE_VERSION, delar: paket.delar.length, langd: paket.langd, hamtadTs: hamtadTs || '', antal: handelser.length });
  try { cache.putAll(put, KAL_ICS_CACHE_S); return true; } catch (err) { return false; }
}
/** Läser cachen → { handelser, hamtadTs } | null (saknas, ofullständig – t.ex. en bit avvisad/utgången – eller trasig).
 *  Tål det äldre formatet (ren JSON-lista under ics:busy). */
function kalIcsCacheLas_(cache) {
  let raw = null;
  try { raw = cache.get(KAL_ICS_CACHE_KEY); } catch (err) { raw = null; }
  if (!raw) return null;
  try {
    if (raw.charAt(0) === '[') { const l = JSON.parse(raw); return Array.isArray(l) ? { handelser: l, hamtadTs: '' } : null; }
    const idx = JSON.parse(raw);
    if (!idx || idx.v !== KAL_ICS_CACHE_VERSION || !(idx.delar >= 1) || idx.delar > KAL_ICS_MAX_CHUNKS) return null;
    const nycklar = [];
    for (let i = 0; i < idx.delar; i++) nycklar.push(KAL_ICS_CACHE_KEY + ':' + i);
    const hit = cache.getAll(nycklar) || {};
    const delar = nycklar.map(k => hit[k]);
    if (delar.some(d => typeof d !== 'string' || !d)) return null;
    if (delar.join('').length !== idx.langd) return null;
    const handelser = kalIcsPackaUpp_(delar);
    return handelser ? { handelser, hamtadTs: idx.hamtadTs || '' } : null;
  } catch (err) { return null; }
}
/** Tömmer ICS-cachen (index + bitar). Felsökning/tester – ingen produktionsväg behöver den. */
function kalIcsCacheRensa_() {
  const cache = kalCache_(), nycklar = [KAL_ICS_CACHE_KEY];
  for (let i = 0; i < KAL_ICS_MAX_CHUNKS; i++) nycklar.push(KAL_ICS_CACHE_KEY + ':' + i);
  try { cache.removeAll(nycklar); } catch (err) { /* ignore */ }
}
function kalIcsReservSvar_(res, meta, fran, till) {
  res.ok = false; res.kalla = 'reserv';
  res.varningar.push('Outlook-flödet kunde inte läsas kl ' + (meta && meta.felKlockslag ? meta.felKlockslag : kalKlockslagNu_()));
  const reserv = lasIcsReserv_();
  if (reserv && Array.isArray(reserv.handelser)) {
    res.handelser = kalFiltreraDatum_(reserv.handelser, fran, till);
    res.hamtadTs = reserv.hamtadTs || '';
  }
  return res;
}

/** Status för ping.icsStatus (4.4): { ok, hamtadTs, antal, medPlats, preliminara }. Läser bara cache-meta, gör inga anrop. */
function getIcsStatus() {
  let meta = null;
  try { const m = kalCache_().get(KAL_ICS_META_KEY); meta = m ? JSON.parse(m) : null; } catch (err) { meta = null; }
  if (!meta) {
    const reserv = lasIcsReserv_();
    return { ok: !!reserv, hamtadTs: reserv ? reserv.hamtadTs || '' : '', antal: reserv && reserv.handelser ? reserv.handelser.length : 0,
      medPlats: 0, preliminara: 0 };
  }
  // langsam = samma villkor som readIcsUncached_ använder för reservvägen (A46): markeringen ligger kvar i ics:meta (TTL 6 h)
  // tills nästa live-hämtning, men gäller bara i KAL_ICS_LANGSAM_S efter hämtningen.
  const langsam = !!meta.langsamTs && (kalNu_().getTime() - kalMsOf(meta.langsamTs)) < KAL_ICS_LANGSAM_S * 1000;
  return { ok: !!meta.ok, hamtadTs: meta.hamtadTs || '', antal: meta.antal | 0, medPlats: meta.medPlats | 0, preliminara: meta.preliminara | 0,
    hamtningMs: meta.hamtningMs | 0, cachad: meta.cachad === true, langsam: langsam };
}

/**
 * readBusy(fran, till, opts) → BusyItem-segment (ej sammanslagna) för Google-kalendrarna i
 * config.installningar.kalendrar + Outlook-ICS. `fran`/`till` = 'YYYY-MM-DD' (inklusive).
 * Cache busy:<datum> 60 s; opts.farsk = true läser färskt (book/rebook).
 * Returnerar array med egenskapen `varningar` (ICS-fel m.m.).
 * Kastar E_CALENDAR vid API-fel (hellre ingen bokning än dubbelbokning, 5.13).
 */
function readBusy(fran, till, opts) {
  opts = opts || {};
  const config = kalConfig_(opts);
  const inst = config.installningar || {};
  const cache = kalCache_();
  const dagar = [];
  for (let d = fran, g = 0; d <= till && g < 400; d = addDays(d, 1), g++) dagar.push(d);
  const nycklar = dagar.map(d => 'busy:' + d);
  let varningar = [];

  if (!opts.farsk && dagar.length) {
    try {
      const hit = cache.getAll(nycklar) || {};
      if (nycklar.every(k => hit[k] !== undefined && hit[k] !== null)) {
        const items = [];
        nycklar.forEach(k => { JSON.parse(hit[k]).forEach(x => items.push(x)); });
        try { const m = cache.get(KAL_ICS_META_KEY); const meta = m ? JSON.parse(m) : null; if (meta && Array.isArray(meta.varningar)) varningar = meta.varningar.slice(); if (meta && meta.ok === false) varningar.push('Outlook-flödet kunde inte läsas kl ' + (meta.felKlockslag || '')); } catch (err) { /* ignore */ }
        items.varningar = varningar;
        return items;
      }
    } catch (err) { /* trasig cache → läs */ }
  }

  const cooldownFor = kalCooldownFn_(config), restidFor = kalRestidFn_(config);
  const timeMin = rfc3339_(new Date(toIsoWithOffset(fran, '00:00')));
  const timeMax = rfc3339_(new Date(toIsoWithOffset(addDays(till, 1), '00:00')));
  const items = [];
  const blockId = kalBlockKalenderId_();
  (inst.kalendrar || []).forEach(k => {
    if (!k || !k.id) return;
    if (blockId && String(k.id) === blockId) return;   // version 11 (K6): modulens egen blockkalender läses aldrig, oavsett läge
    const lage = k.lage || 'ingen';
    if (lage !== 'tider' && lage !== 'fullt') return;
    const kalla = lage === 'fullt' ? 'bokningar' : 'privat';
    listGoogleEvents_(String(k.id), timeMin, timeMax).forEach(ev => {
      normalizeGoogleEvent(ev, kalla, { cooldownFor, restidFor }).forEach(seg => { if (seg.datum >= fran && seg.datum <= till) items.push(seg); });
    });
  });

  const ics = readIcs(config, { farsk: false });
  varningar = varningar.concat(ics.varningar || []);
  ics.handelser.forEach(h => {
    normalizeIcsItem(h, { raknaPreliminara: !!inst.raknaPreliminaraOutlook }).forEach(seg => { if (seg.datum >= fran && seg.datum <= till) items.push(seg); });
  });

  try {
    const perDag = {};
    dagar.forEach(d => { perDag['busy:' + d] = []; });
    items.forEach(x => { perDag['busy:' + x.datum].push(x); });
    const put = {};
    Object.keys(perDag).forEach(k => { put[k] = JSON.stringify(perDag[k]); });
    cache.putAll(put, KAL_BUSY_CACHE_S);
  } catch (err) { /* cache är en optimering */ }

  items.varningar = varningar;
  return items;
}

/**
 * buildBusyList(from, to, opts) → sammanslagen, ignorera-filtrerad lista av BusyItem-segment (spec 5.2):
 *   readBusy + bekräftade bokningar ur inkorgen (ny/importerad, framtida) + aktiva reservationer
 *   → mergeBusy → applyIgnore (ignorera/räkna + restid-override, 3.5) → finalizeBusy (härledda fält + effektiv buffert, version 10).
 * opts: { config, inbox, farsk, reservationId (anropande bokarens egen), bokareId (för egen/kundnamn),
 *         undantaBokningId (ombokning: alla poster med samma bokningId tas bort helt, samt ICS-poster vars UID är bokningens
 *         Google-iCalUID – Outlooks accepterade kopia; se kalUndantaBokning_) }
 * Returnerar array med egenskapen `varningar`.
 */
/** Tar bort bokningens egna segment (bokningId) och Outlook-ICS-kopian av dem (uid = Google-händelsens iCalUID, eller
 *  '<kalenderhändelse-id>@google.com' som Google ger händelser skapade via API:t) – körs före mergeBusy. */
function kalUndantaBokning_(items, bokningId) {
  const uids = {};
  items.forEach(x => {
    if (x.bokningId !== bokningId) return;
    if (x.iCalUID) uids[String(x.iCalUID)] = true;
    if (x.eventId) uids[String(x.eventId) + '@google.com'] = true;
  });
  return items.filter(x => x.bokningId !== bokningId && !(x.kalla === 'ics' && x.uid && uids[String(x.uid)]));
}
function buildBusyList(from, to, opts) {
  opts = opts || {};
  const config = kalConfig_(opts);
  const cooldownFor = kalCooldownFn_(config), restidFor = kalRestidFn_(config);
  const busy = readBusy(from, to, { config, farsk: !!opts.farsk });
  const varningar = (busy.varningar || []).slice();
  let items = busy.slice();

  // Bekräftade bokningar ur inkorgen (framtida eller inom fönstret) – slås ihop med kalenderhändelsen via bokningId.
  let inbox = null;
  try { inbox = kalInbox_(opts); } catch (err) { inbox = null; varningar.push('Inkorgen kunde inte läsas – bara kalendern används'); }
  const kundnamn = {};
  ((inbox && inbox.bokningar) || []).forEach(b => {
    if (!b) return;
    if (b.bokningId && b.kund && b.kund.namn) kundnamn[b.bokningId] = String(b.kund.namn);
    inboxBookingToBusy(b, { cooldownFor, restidFor }).forEach(seg => { if (seg.datum >= from && seg.datum <= to) items.push(seg); });
  });
  items.forEach(x => { if (x.kalla === 'bokningar' && x.bokningId && !x.kundnamn && kundnamn[x.bokningId]) x.kundnamn = kundnamn[x.bokningId]; });

  // Aktiva reservationer (CacheService)
  (opts.reservationer || lasReservationer_()).forEach(rs => {
    reservationToBusy(rs, { reservationId: opts.reservationId, bokareId: opts.bokareId })
      .forEach(seg => { if (seg.datum >= from && seg.datum <= to) items.push(seg); });
  });

  // Undantag för ombokning (4.4): bokningens egna poster tas bort FÖRE sammanslagningen – Google-händelsen, inkorgsposten och
  // Outlooks accepterade ICS-kopia (modulens inbyggda dubblett, 4.6: ICS-UID = Googles iCalUID, saknar eget bokningId).
  // Medvetet inte "filtrera efter mergeBusy": regel 2 (≥ 90 % överlapp) kan slå ihop en FRÄMMANDE händelse (t.ex. privat
  // 30 min inuti bokningen) med bokningens post, och den får inte försvinna som hinder bara för att bokningen flyttas.
  if (opts.undantaBokningId) items = kalUndantaBokning_(items, opts.undantaBokningId);

  let out = mergeBusy(items);
  out = applyIgnore(out, config.ignorerade || []);
  out = finalizeBusy(out, { bokareId: opts.bokareId, restidFor, marginal: kalMarginal_(config) });
  out.varningar = varningar;
  return out;
}
