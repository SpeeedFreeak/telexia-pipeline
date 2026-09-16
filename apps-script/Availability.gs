// =====================================================================================
// Availability.gs — Tillgänglighet och restid för bokningsmodulen (spec 5.1–5.13, 4.5, A2, A5, A10–A12, A56–A57 steg 2c)
//
// Uppbyggnad (uppifrån och ned):
//   1. Rena funktioner utan Google-tjänster: mapCfg, swedishHolidays, isRedDay, firstBookableDay, dayStatus,
//      travelWithMargin, placeTravel, availBusyForDay, buildTravelTable, dayPlan, computeAvailabilityCore.
//      Alla tar busy-lista, cfg och travel-/geokodningsfunktioner som parametrar (injektion) och körs i Node
//      (module.exports längst ned) – testfallen i spec 5.14 finns i runAvailabilityTests().
//   2. Wrappers mot Google-tjänster: CacheService, Script Properties (via Code.gs), Drive-cachefilen, Geocoding API,
//      Distance Matrix. Isolerade så att de rena funktionerna aldrig rör dem.
//   3. Ingångar som Code.gs anropar: computeAvailability(req) (kastar ApiError-kompatibla fel), geocodeAddress(adress, opts?),
//      hamtaAdressforslag(q, sessionToken) (steg 2b, Places API (New) Autocomplete), travelMinutes(a, b, restidCfg),
//      readIcsReserv()/writeIcsReserv(obj) (Calendar.gs), swedishHolidays(year), geokodaAnkare(busy, geocodeFn) + previewResor(busy, cfg, parFn)
//      + travelSecondsForPairs_(par, maxNya) (steg 2c: restid mellan ankarpar i calendar-preview), backfillOmrade_(max) (dailyMaintenance).
//   Områdesetikett (steg 2c, A56): geokodningen härleder omrade = { stad, stadsdel, etikett } ur Geocoding address_components
//   (locality/postal_town → stad; sublocality_level_1/sublocality/neighborhood → stadsdel; etikett = 'Stad · Stadsdel'). Etiketten är
//   det ENDA om platsen som når bokarna (availability-block.omrade) – aldrig gatuadress, titel, koordinater eller källa.
//
// Delas med andra filer (deklareras INTE här – dubbla const/function i Apps Script bryter projektet):
//   Code.gs      tidshjälpen APP_TZ, SV_WEEKDAYS, SV_MONTHS, tzParts, todayStr, addDays, weekdayOf, tzOffsetMinutes,
//                toIsoWithOffset, fromIso, longDateLabel (spec 3.4) · sha256hex · readCacheFile/writeCacheFile ·
//                getProp/PROP · mapsDailyCap/mapsElementsToday/addMapsElements · MAX_GEOCODE_PER_KOD_H m.fl.
//   Calendar.gs  buildBusyList(from, to, opts) → BusyItem-segment per dag (spec 5.2)
// Inga hemligheter i koden: MAPS_API_KEY läses enbart ur Script Properties. Inget som loggas innehåller adresser.
// =====================================================================================

// ---------- Konstanter för algoritmen ----------
const AVAIL_MAX_DAGAR_PER_FRAGA = 14;          // to − from ≤ 14 dagar (spec 4.4)
const AVAIL_AVRUNDNING_MIN = 5;                // marginalavrundning, fast (spec 5.1)
const AVAIL_FAGELVAG_MAX_KM = 150;             // fågelväg > 150 km → "för långt" utan Maps-anrop (spec 5.8)
const AVAIL_FAGELVAG_KMH = 70;                 // uppskattad medelhastighet för "för långt"-par (ger alltid > maxEnkelRestid)
const AVAIL_MATRIX_BATCH = 25;                 // max destinationer per Distance Matrix-anrop (spec 5.8)
const AVAIL_MATRIX_MAX_PER_FRAGA = 50;         // skydd: fler nya par än så i en förfrågan → schablon för resten
const AVAIL_PREVIEW_MAX_PAR = 60;              // steg 2c: högst 60 nya (ocachade) ankarpar per calendar-preview-anrop – resten 'okand' till nästa anrop
const AVAIL_PREVIEW_MAX_GEO = 60;              // steg 2c: högst 60 nya Geocoding-anrop (ocachade platstexter) per calendar-preview-anrop – resten nästa anrop
const AVAIL_OMRADE_MAX = 60;                   // steg 2c: områdesetikett klipps till 60 tecken
const AVAIL_CACHE_TTL_RESTID_S = 21600;        // CacheService-max 6 h (spec 5.8: TTL 6 h)
const AVAIL_CACHE_TTL_GEO_OK_S = 21600;
const AVAIL_CACHE_TTL_GEO_OKAND_S = 3600;      // ej tolkad adress: kort cache så upprepade anrop inte kostar
const AVAIL_BACKFILL_FEL_MAX = 3;              // steg 2c: backfillOmrade_ avbryter natten efter så många icke-ZERO_RESULTS-fel i rad
const AVAIL_GEO_OKAND_FIL_DAGAR = 30;          // ZERO_RESULTS sparas i cache-filen som { status:'okand', ts } och gäller så länge (kalendertexter Google inte tolkar kostar annars ett element per timme)
const AVAIL_MAPS_BLOCK_S = 60;                 // OVER_QUERY_LIMIT → inga nya Maps-anrop i 60 s (CacheService maps:block)
const AVAIL_MAPS_VARNING_S = 21600;            // maps:varning (ping läser den ur CacheService; 6 h är CacheService-max, spec säger 24 h)
const AVAIL_AC_CACHE_S = 21600;                // adressförslag per normaliserad fråga (steg 2b säger 24 h – CacheService-max är 6 h)
const AVAIL_AC_ANTAL = 5;                      // högst 5 förslag per svar (bokningssidan visar max 5)
const AVAIL_AC_TEXT_MAX = 160;                 // klippning av förslagstexter (text/huvud/detalj) – 5 förslag × (3×160 + placeId ≤ 300) < 5 KB per cachepost
const AVAIL_PLACE_ID_RE = /^[A-Za-z0-9_-]{10,300}$/;   // samma mönster som PLACE_ID_RE i Code.gs (deklareras inte om där)
const AVAIL_PLACES_URL = 'https://places.googleapis.com/v1/places:autocomplete';
const AVAIL_PLACES_VARNING = 'Places API ej aktiverat';   // maps:varning-text (statisk – ping visar den i Drift-panelen)
const AVAIL_STATISKA_FEL = {                   // E_VALIDATION-texter är statiska och ekar aldrig indata (spec 9.6)
  datum: 'Ogiltigt datumintervall',
  horisont: 'Datumet ligger utanför bokningshorisonten',
  motestyp: 'Mötestypen är inte tillgänglig',
  adress: 'Ogiltig adress'
};

// Läser en konstant som deklareras i Code.gs utan att deklarera om den här (reserv om filen laddas ensam, t.ex. i Node).
function availKonst(getter, reserv) { try { const v = getter(); return typeof v === 'number' ? v : reserv; } catch (e) { return reserv; } }
function availFel(code, message, details) { return { ok: false, error: { code, message, details: details || {} } }; }
// Gör ett felobjekt kastbart: Code.gs errorCode() läser .code, kuvertet .message/.details.
function availThrow(error) { const e = new Error(error.message || error.code); e.code = error.code; e.details = error.details || {}; return e; }

// ---------- Minut-hjälp ----------
function hhmmToMin(t) { return (+String(t).slice(0, 2)) * 60 + (+String(t).slice(3, 5)); }
function minToHhmm(m) { m = Math.max(0, Math.min(1440, Math.round(m))); return String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0'); }
function ceilTo(n, m) { return Math.ceil(n / m) * m; }
function overlappar(a, b) { return Math.min(a[1], b[1]) - Math.max(a[0], b[0]) > 0; }   // kant mot kant tillåtet
function giltigtDatum(s) { return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && addDays(s, 0) === s; }
function giltigtKlockslag(s) { return typeof s === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(s); }
function dagarMellan(a, b) { return Math.round((Date.UTC(+b.slice(0,4), +b.slice(5,7)-1, +b.slice(8,10)) - Date.UTC(+a.slice(0,4), +a.slice(5,7)-1, +a.slice(8,10))) / 86400000); }
function availNowIso(d) { const p = tzParts(d || new Date()); return toIsoWithOffset(p.datum, p.tid); }

// ---------- 1a. cfg-mappning från config.installningar (spec 5.1) ----------
function mapCfg(inst) {
  inst = inst || {};
  const num = (v, d) => (typeof v === 'number' && isFinite(v)) ? v : d;
  const lunch = (inst.lunch && giltigtKlockslag(inst.lunch.start) && giltigtKlockslag(inst.lunch.slut) && inst.lunch.start < inst.lunch.slut)
    ? { start: inst.lunch.start, slut: inst.lunch.slut } : null;
  const arbetstider = {};
  for (let d = 0; d <= 6; d++) {
    const at = inst.arbetstider ? inst.arbetstider[String(d)] : null;
    arbetstider[d] = (at && giltigtKlockslag(at.start) && giltigtKlockslag(at.slut) && at.start < at.slut)
      ? { start: at.start, slut: at.slut, lunch } : null;   // null = stängd dag
  }
  const basLat = inst.basLat, basLng = inst.basLng;
  const basGeokodad = typeof basLat === 'number' && typeof basLng === 'number' && isFinite(basLat) && isFinite(basLng);
  return {
    arbetstider,
    basadress: { text: String(inst.basadress || ''), lat: basGeokodad ? basLat : null, lng: basGeokodad ? basLng : null, geokodad: basGeokodad },
    framforhallning: { fysiskArbetsdagar: Math.max(0, num(inst.framforhallningFysiskDagar, 2)), teamsArbetsdagar: Math.max(0, num(inst.framforhallningTeamsDagar, 1)) },
    rasterMin: Math.max(5, num(inst.startintervallMin, 30)),
    maxEnkelRestidMin: num(inst.maxEnkelResaMin, 90),
    restid: { schablonMin: num(inst.schablonRestidMin, 45), marginalMin: num(inst.marginalMinstMin, 15), marginalProcent: num(inst.marginalProcent, 25), avrundningMin: AVAIL_AVRUNDNING_MIN },
    rodaDagar: { auto: inst.rodaDagar !== false, extra: Array.isArray(inst.rodaDagarExtra) ? inst.rodaDagarExtra.filter(giltigtDatum) : [], undantag: Array.isArray(inst.rodaDagarUndantag) ? inst.rodaDagarUndantag.filter(giltigtDatum) : [] },
    horisontVeckor: Math.max(1, num(inst.horisontVeckor, 6)),
    maxFysiskaPerDag: Math.max(0, num(inst.maxFysiskaPerDag, 3)),
    restidTillForsta: inst.restidTillForsta !== false,
    restidEfterSista: inst.restidEfterSista !== false,
    paus: { aktiv: !!(inst.paus && inst.paus.aktiv), tom: (inst.paus && giltigtDatum(inst.paus.tom)) ? inst.paus.tom : '', meddelande: String(inst.paus && inst.paus.meddelande || '') },
    raknaPreliminaraOutlook: !!inst.raknaPreliminaraOutlook
  };
}

// ---------- 1b. Röda dagar (spec 5.10, A11) ----------
const SWEDISH_HOLIDAY_CACHE = {};   // år → array av 'YYYY-MM-DD'
function easterSunday(year) {       // Meeus/Jones/Butcher (gregoriansk)
  const a = year % 19, b = Math.floor(year / 100), c = year % 100, d = Math.floor(b / 4), e = b % 4,
        f = Math.floor((b + 8) / 25), g = Math.floor((b - f + 1) / 3), h = (19 * a + b - d - g + 15) % 30,
        i = Math.floor(c / 4), k = c % 4, l = (32 + 2 * e + 2 * i - h - k) % 7, m = Math.floor((a + 11 * h + 22 * l) / 451),
        month = Math.floor((h + l - 7 * m + 114) / 31), day = ((h + l - 7 * m + 114) % 31) + 1;
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}
function lordagInom(year, m1, d1, m2, d2) {   // första lördagen i intervallet (samma år)
  let D = `${year}-${String(m1).padStart(2, '0')}-${String(d1).padStart(2, '0')}`;
  const slut = `${year}-${String(m2).padStart(2, '0')}-${String(d2).padStart(2, '0')}`;
  while (D <= slut) { if (weekdayOf(D) === 6) return D; D = addDays(D, 1); }
  return null;
}
// Svenska helgdagar + de facto lediga aftnar (midsommar-, jul-, nyårsafton) enligt A11. Cachad per år.
function swedishHolidays(year) {
  year = +year;
  if (SWEDISH_HOLIDAY_CACHE[year]) return SWEDISH_HOLIDAY_CACHE[year].slice();
  const y = String(year), pask = easterSunday(year);
  const list = [
    `${y}-01-01`, `${y}-01-06`, `${y}-05-01`, `${y}-06-06`, `${y}-12-25`, `${y}-12-26`,     // fasta
    addDays(pask, -2), pask, addDays(pask, 1), addDays(pask, 39), addDays(pask, 49),           // långfredag, påskdagen, annandag påsk, Kristi himmelsfärd, pingstdagen
    lordagInom(year, 6, 20, 6, 26),                                                            // midsommardagen
    lordagInom(year, 10, 31, 11, 6),                                                           // alla helgons dag (31/10–6/11)
    addDays(lordagInom(year, 6, 20, 6, 26), -1), `${y}-12-24`, `${y}-12-31`                    // de facto: midsommarafton, julafton, nyårsafton
  ].filter(Boolean);
  const unika = Array.from(new Set(list)).sort();
  SWEDISH_HOLIDAY_CACHE[year] = unika;
  return unika.slice();
}
function isRedDay(D, cfg) {
  const r = cfg.rodaDagar;
  if (r.undantag.indexOf(D) >= 0) return false;
  if (r.extra.indexOf(D) >= 0) return true;
  return r.auto && swedishHolidays(+D.slice(0, 4)).indexOf(D) >= 0;
}

// ---------- 1c. Dagsstatus, framförhållning, paus (spec 5.4) ----------
function isWorkingDay(D, cfg) { return !!cfg.arbetstider[weekdayOf(D)] && !isRedDay(D, cfg); }
// Framförhållning räknas i hela arbetsdagar oavsett klockslag.
function firstBookableDay(cfg, typ, idag) {
  const n = typ.restid ? cfg.framforhallning.fysiskArbetsdagar : cfg.framforhallning.teamsArbetsdagar;
  let D = idag, raknare = 0, skydd = 0;
  while (raknare < n && skydd++ < 400) { D = addDays(D, 1); if (isWorkingDay(D, cfg)) raknare++; }
  return D;
}
function sistaDagFor(cfg, idag) { return addDays(idag, cfg.horisontVeckor * 7); }
function dayStatus(D, cfg, forstaDag, sistaDag, busyDay) {
  if (!cfg.arbetstider[weekdayOf(D)]) return { status: 'stangd', reason: 'helg' };
  if (isRedDay(D, cfg)) return { status: 'stangd', reason: 'rodDag' };
  if ((busyDay || []).some(b => b.heldag && !b.ignore)) return { status: 'stangd', reason: 'heldag' };
  // paus.aktiv utan slutdatum tolkas som paus tills vidare (samma tolkning som pausCheck i Code.gs)
  if (cfg.paus.aktiv && (!cfg.paus.tom || D <= cfg.paus.tom)) return { status: 'paus', reason: null };
  if (D < forstaDag) return { status: 'forTidigt', reason: null };
  if (D > sistaDag) return { status: 'utanforHorisont', reason: null };
  return { status: 'oppen', reason: null };
}

// ---------- 1d. Restidsmarginal (spec 5.8) ----------
// 32 min → max(15, 8) = 15 → 47 → 50. 80 min → max(15, 20) → 100.
function travelWithMargin(sek, restidCfg) {
  const bas = Math.ceil(sek / 60);
  const marg = Math.max(restidCfg.marginalMin, Math.ceil(bas * restidCfg.marginalProcent / 100));
  return ceilTo(bas + marg, restidCfg.avrundningMin || AVAIL_AVRUNDNING_MIN);
}

// ---------- 1e. placeTravel (spec 5.6, A10) ----------
// Resan är ett sammanhängande block närmast mötet som hoppar bakåt (in) / framåt (ut) över platslösa händelser.
// obstacles = [[start, slut], …] i minuter. Returnerar [start, slut] eller null när resan inte får plats.
function subtraheraIntervall(obstacles, gap) {
  const sorted = obstacles.map(o => [Math.max(o[0], gap[0]), Math.min(o[1], gap[1])]).filter(o => o[1] > o[0]).sort((a, b) => a[0] - b[0]);
  const fria = []; let pos = gap[0];
  sorted.forEach(o => { if (o[0] > pos) fria.push([pos, o[0]]); pos = Math.max(pos, o[1]); });
  if (pos < gap[1]) fria.push([pos, gap[1]]);
  return fria;
}
function placeTravel(gapStart, gapEnd, obstacles, minutes, side) {
  if (minutes === 0) return [gapEnd, gapEnd];
  if (gapEnd <= gapStart) return null;
  const fria = subtraheraIntervall(obstacles || [], [gapStart, gapEnd]);
  const kandidater = side === 'in' ? fria.slice().reverse() : fria;
  for (const f of kandidater) {
    if (f[1] - f[0] >= minutes) return side === 'in' ? [f[1] - minutes, f[1]] : [f[0], f[0] + minutes];
  }
  return null;
}

// ---------- 1f. Busy-poster per dag (spec 5.13: händelse över midnatt delas per dag) ----------
function isoDatumTid(v) {   // ISO med offset eller rent datum ('YYYY-MM-DD' = heldag)
  if (typeof v === 'string' && v.length === 10) return { datum: v, tid: '00:00' };
  return fromIso(v);
}
// Returnerar kopior av de poster som berör dagen D med _s/_e (minuter från midnatt, klippta till 0–1440).
// Calendar.gs levererar redan dag-segment med datum/startMin/slutMin – de används direkt; andra poster delas här.
function availBusyForDay(busy, D) {
  const ut = [];
  (busy || []).forEach(b => {
    if (!b) return;
    if (typeof b.datum === 'string' && typeof b.startMin === 'number' && typeof b.slutMin === 'number') {
      if (b.datum !== D || b.slutMin <= b.startMin) return;
      ut.push(Object.assign({}, b, { _s: Math.max(0, b.startMin), _e: Math.min(1440, b.slutMin) }));
      return;
    }
    if (!b.start || !b.slut) return;
    const s = isoDatumTid(b.start), e = isoDatumTid(b.slut);
    if (b.heldag) {
      let ed = e.datum;
      if (e.tid === '00:00' && ed > s.datum) ed = addDays(ed, -1);   // exklusivt slut vid midnatt
      if (D < s.datum || D > ed) return;
      ut.push(Object.assign({}, b, { _s: 0, _e: 1440 }));
      return;
    }
    if (e.datum < D || s.datum > D) return;
    const _s = s.datum < D ? 0 : hhmmToMin(s.tid);
    const _e = e.datum > D ? 1440 : hhmmToMin(e.tid);
    if (_e <= _s) return;
    ut.push(Object.assign({}, b, { _s, _e }));
  });
  return ut.sort((a, b) => a._s - b._s);
}

// ---------- 1g. Restidstabell (spec 5.7–5.8, A2) ----------
function platsnyckel(p) { return (+p.lat).toFixed(4) + ',' + (+p.lng).toFixed(4); }
function cachenyckel(a, b) { return [platsnyckel(a), platsnyckel(b)].sort().join('|'); }
function platsGeokodad(p) { return !!p && p.geokodad !== false && typeof p.lat === 'number' && typeof p.lng === 'number' && isFinite(p.lat) && isFinite(p.lng); }
function haversineKm(a, b) {
  const R = 6371, rad = x => x * Math.PI / 180;
  const dLat = rad(b.lat - a.lat), dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
// Unika geokodade platser bland ankare + bas (spec 5.8 "Par").
function unikaPlatser(busy, cfg) {
  const map = {};
  (busy || []).forEach(b => { if (b.isTravelMeeting && !b.ignore && platsGeokodad(b.plats)) map[platsnyckel(b.plats)] = { lat: b.plats.lat, lng: b.plats.lng, geokodad: true }; });
  if (cfg.basadress.geokodad && (cfg.restidTillForsta || cfg.restidEfterSista)) map[platsnyckel(cfg.basadress)] = { lat: cfg.basadress.lat, lng: cfg.basadress.lng, geokodad: true };
  return Object.keys(map).map(k => map[k]);
}
// Bygger T(plats) → { min, kalla:'maps'|'forLangt'|'schablon' }. travelSekFn(X, platser) returnerar
// { <cachenyckel>: sek | { sek, forLangt:true } | null } och anropas bara när X är geokodad och platser finns.
// 0 sekunder (samma koordinater – travelSecondsForPairs_ ger 0 utan anrop) → 0 min UTAN marginal (version 7, K3): ingen resa
// sker, så dayPlan får inBlock/utBlock tomma och restidMin.fore/efter = 0 (placeTravel returnerar [gapEnd, gapEnd] för 0).
function buildTravelTable(X, platser, cfg, travelSekFn) {
  const schablon = { min: cfg.restid.schablonMin, kalla: 'schablon' };
  const tabell = {};
  if (platsGeokodad(X) && platser.length && typeof travelSekFn === 'function') {
    const svar = travelSekFn(X, platser) || {};
    platser.forEach(p => {
      const v = svar[cachenyckel(X, p)];
      if (v === 0) tabell[platsnyckel(p)] = { min: 0, kalla: 'maps' };
      else if (typeof v === 'number' && isFinite(v) && v >= 0) tabell[platsnyckel(p)] = { min: travelWithMargin(v, cfg.restid), kalla: 'maps' };
      else if (v && typeof v === 'object' && typeof v.sek === 'number') tabell[platsnyckel(p)] = { min: travelWithMargin(v.sek, cfg.restid), kalla: v.forLangt ? 'forLangt' : 'maps' };
    });
  }
  return function T(plats) {
    if (!platsGeokodad(X) || !platsGeokodad(plats)) return schablon;
    return tabell[platsnyckel(plats)] || schablon;
  };
}

// ---------- 1h. dayPlan (spec 5.5, 5.7) ----------
// busyDay = availBusyForDay(...) (poster med _s/_e). T = funktion plats → { min, kalla } (null för typer utan restid).
// Lediga slots med restid får restidMin { fore, efter, kalla:'ok'|'schablon' } (råa minuter för inkorgsposten, spec 5.5);
// fältet tas bort före export till bokaren (spec 5.12: råa restidsminuter exporteras inte).
function dayPlan(D, cfg, typ, X, busyDay, T) {
  const at = cfg.arbetstider[weekdayOf(D)];
  const L = typ.langdMin, C = typ.cooldownMin || 0;
  const aktiva = busyDay.filter(b => !b.ignore && !b.heldag);
  const hinder = aktiva.map(b => [b._s, b._e + (b.cooldownMin || 0)]);
  const fysiska = aktiva.filter(b => b.isTravelMeeting && !b.egenReservation);
  const ankare = aktiva.filter(b => b.isTravelMeeting);
  const platslos = aktiva.filter(b => !b.isTravelMeeting).map(b => [b._s, b._e + (b.cooldownMin || 0)]);
  const dagsgransNadd = !!typ.restid && fysiska.length >= cfg.maxFysiskaPerDag;
  const atStart = hhmmToMin(at.start), atSlut = hhmmToMin(at.slut);
  const lunch = at.lunch ? [hhmmToMin(at.lunch.start), hhmmToMin(at.lunch.slut)] : null;
  const bas = cfg.basadress;
  const slots = [];

  for (let S = atStart; S + L <= atSlut; S += cfg.rasterMin) {
    const tid = minToHhmm(S);
    const slot = { tid, start: toIsoWithOffset(D, tid), status: 'ledig', reason: null };
    const mote = [S, S + L], moteCool = [S, S + L + C];
    if (lunch && overlappar(mote, lunch)) { slot.status = 'utanfor'; slot.reason = 'lunch'; }
    else if (S + L > atSlut) { slot.status = 'utanfor'; slot.reason = 'arbetstid'; }
    else if (hinder.some(h => overlappar(moteCool, h))) { slot.status = 'upptaget'; slot.reason = 'upptaget'; }
    else if (!typ.restid) { /* ledig utan restid */ }
    else if (dagsgransNadd) { slot.status = 'dold'; slot.reason = 'maxFysiska'; }
    else {
      // prev = senaste ankare vars slut + cooldown ≤ S, annars bas (om restidTillForsta), annars null
      let prev = null;
      ankare.forEach(b => { const e = b._e + (b.cooldownMin || 0); if (e <= S && (!prev || e > prev._e + (prev.cooldownMin || 0))) prev = b; });
      let next = null;
      ankare.forEach(b => { if (b._s >= S + L + C && (!next || b._s < next._s)) next = b; });
      const prevArBas = !prev && cfg.restidTillForsta && !!bas;
      const nextArBas = !next && cfg.restidEfterSista && !!bas;
      const tIn = prev ? T(prev.plats) : (prevArBas ? T(bas) : { min: 0, kalla: 'ingen' });
      const tUt = next ? T(next.plats) : (nextArBas ? T(bas) : { min: 0, kalla: 'ingen' });
      if (tIn.min > cfg.maxEnkelRestidMin || tUt.min > cfg.maxEnkelRestidMin) { slot.status = 'dold'; slot.reason = 'maxRestid'; }
      else {
        const inBlock = placeTravel(prev ? prev._e + (prev.cooldownMin || 0) : atStart, S, platslos, tIn.min, 'in');
        const utBlock = placeTravel(S + L + C, next ? next._s : atSlut, platslos, tUt.min, 'ut');
        if (!inBlock) { slot.status = 'restid'; slot.reason = 'restidIn'; }
        else if (!utBlock) { slot.status = 'restid'; slot.reason = 'restidUt'; }
        else {
          slot.restidOkand = (tIn.kalla === 'schablon' || tUt.kalla === 'schablon');
          // Block med längd 0 (inget ankare/ingen bas åt det hållet, eller restid 0) utelämnas – klienterna ritar bara block
          // med slut > start, och inkorgspostens foreMin/efterMin kommer ur restidMin.
          slot.restid = {};
          if (inBlock[1] > inBlock[0]) slot.restid.inBlock = [minToHhmm(inBlock[0]), minToHhmm(inBlock[1])];
          if (utBlock[1] > utBlock[0]) slot.restid.utBlock = [minToHhmm(utBlock[0]), minToHhmm(utBlock[1])];
          slot.restidMin = { fore: tIn.min, efter: tUt.min, kalla: slot.restidOkand ? 'schablon' : 'ok' };
        }
      }
    }
    slots.push(slot);
  }

  return {
    datum: D, veckodag: weekdayOf(D), status: 'oppen', reason: null,
    arbetstid: arbetstidFor(at),
    fysiska: fysiska.length, maxFysiska: cfg.maxFysiskaPerDag,
    block: blockFor(aktiva, at, null),
    slots
  };
}
function arbetstidFor(at) { return at ? { start: at.start, slut: at.slut, lunch: at.lunch ? [at.lunch.start, at.lunch.slut] : null } : undefined; }
// Block för rendering (spec 5.12, K1 version 7): 'upptaget' = mötets egen tid [_s, _e]; har källan cooldownMin > 0 följer ett
// eget block { typ:'paus', start:<mötets slut>, slut:<slut + cooldown> } direkt efter (samma egen/kundnamn/bokningId som
// upptaget-blocket om egen – aldrig omrade på paus), så att klienterna kan rita pausen ljusare än mötet. Förut var möte + cooldown
// ett sammanslaget upptaget-block; äldre klienter som bara ritar upptaget/lunch ignorerar den okända typen och ser mötet kortare
// (pausen är ändå hinder i dayPlan). Aldrig titel, adress eller källa. omrade (steg 2c) = områdesetikett när platsen är geokodad
// (även egna bokningar och reservationer) – men ALDRIG för kalla 'privat' (kalender i läge "bara tider": den exporterar tider, inte
// var CJ befinner sig; platsen används bara för restiden). egen:true + kundnamn/bokningId bara för anropande bokarens egna
// bokningar/reservation. Sortering på start som förut.
function blockFor(aktiva, at, bokareId) {
  const block = [];
  aktiva.forEach(b => {
    const o = { typ: 'upptaget', start: minToHhmm(b._s), slut: minToHhmm(Math.min(1440, b._e)), egen: false };
    // Områdesetikett (steg 2c, A56): stad · stadsdel för geokodade platser – det enda om platsen som når bokaren (aldrig adress/titel/källa);
    // privat ('tider') → aldrig omrade.
    const omrade = b.kalla === 'privat' ? '' : platsOmrade(b.plats);
    if (omrade) o.omrade = omrade;
    const egenKalla = b.kalla === 'bokningar' || b.kalla === 'reservation';
    const egen = egenKalla && (b.egen === true || (!!bokareId && b.bokareId === bokareId));
    if (egen) {
      o.egen = true;
      if (b.kundnamn) o.kundnamn = String(b.kundnamn);
      if (b.bokningId) o.bokningId = String(b.bokningId);
    }
    block.push(o);
    const cooldown = b.cooldownMin | 0;
    if (cooldown > 0 && b._e < 1440) {
      const p = { typ: 'paus', start: minToHhmm(b._e), slut: minToHhmm(Math.min(1440, b._e + cooldown)), egen: egen };
      if (egen) { if (b.kundnamn) p.kundnamn = String(b.kundnamn); if (b.bokningId) p.bokningId = String(b.bokningId); }
      block.push(p);
    }
  });
  if (at && at.lunch) block.push({ typ: 'lunch', start: at.lunch.start, slut: at.lunch.slut });
  return block.sort((a, b) => a.start < b.start ? -1 : a.start > b.start ? 1 : 0);
}

// ---------- 1i. Mötestyp och bokare ----------
function typTillatenForBokare(typ, bokare) {
  if (!typ || typ.aktiv === false) return false;
  if (!(typ.global === true || typ.pipelineId === bokare.pipelineId)) return false;
  const lista = Array.isArray(bokare.tillatnaMotestypIds) ? bokare.tillatnaMotestypIds : [];
  return lista.length === 0 || lista.indexOf(typ.id) >= 0;
}

// ---------- 1j. computeAvailabilityCore (spec 5.3) — ren funktion, allt injiceras via deps ----------
// req  = { motestypId, adress?, from, to, reservationId?, undantaBokningId? }  (k är redan validerad → deps.bokare)
// deps = { config, bokare, now:Date, typ? (redan uppslagen – hoppar över typkontrollen), undantaHonorerad? (redan kontrollerad),
//          busy?:[] | buildBusy(from,to), geocode(adress) → { status:'ok'|'okand'|'saknas'|'rate', lat, lng, formaterad, typ },
//          travelSek(X, platser) → { cachenyckel: sek|{sek,forLangt}|null }, findBokning?(bokningId) → { bokareId, motestypId }|null }
// Returnerar { ok:true, data } (slots har restidMin) eller { ok:false, error:{ code, message, details } }.
function computeAvailabilityCore(req, deps) {
  req = req || {};
  const config = deps.config || {}, bokare = deps.bokare;
  if (!bokare) return availFel('E_KEY', 'Koden är ogiltig eller avstängd');
  const cfg = mapCfg(config.installningar);
  const now = deps.now || new Date();
  const idag = tzParts(now).datum;
  const sistaDag = sistaDagFor(cfg, idag);

  // 1. Datum och intervall
  const from = req.from, to = req.to;
  if (!giltigtDatum(from) || !giltigtDatum(to) || to < from || dagarMellan(from, to) > AVAIL_MAX_DAGAR_PER_FRAGA)
    return availFel('E_VALIDATION', AVAIL_STATISKA_FEL.datum, { falt: { from: AVAIL_STATISKA_FEL.datum } });
  // Inom horisont: intervallet måste skära [idag, sistaDag]; en veckovy får börja före idag (dagarna blir forTidigt).
  if (to < addDays(idag, -7) || from > sistaDag)
    return availFel('E_VALIDATION', AVAIL_STATISKA_FEL.horisont, { falt: { from: AVAIL_STATISKA_FEL.horisont } });

  // 2. Kalender (E_CALENDAR hellre än dubbelbokning, spec 5.13)
  let busy;
  try { busy = Array.isArray(deps.busy) ? deps.busy.slice() : deps.buildBusy(from, to); }
  catch (err) {
    if (err && typeof err.code === 'string' && /^E_[A-Z_]+$/.test(err.code)) return availFel(err.code, err.message || 'Kalendern kunde inte läsas', err.details);
    return availFel('E_CALENDAR', 'Kalendern kunde inte läsas just nu');
  }
  busy = (busy || []).filter(b => b && (b.start || typeof b.startMin === 'number'));

  // 3. undantaBokningId honoreras bara för CJ-bokare eller bokningens egen bokare (spec 4.4)
  let undantaTyp = null;
  const undanta = typeof req.undantaBokningId === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(req.undantaBokningId) ? req.undantaBokningId : '';
  if (undanta) {
    let bk = null;
    try { bk = typeof deps.findBokning === 'function' ? deps.findBokning(undanta) : null; } catch (e) { bk = null; }
    if (!bk) { const b = busy.find(x => x.bokningId === undanta); if (b) bk = { bokareId: b.bokareId, motestypId: b.motestypId || null }; }
    const honoreras = deps.undantaHonorerad === true || !!bokare.arCj || (!!bk && bk.bokareId === bokare.id);
    if (honoreras) { busy = busy.filter(b => b.bokningId !== undanta); undantaTyp = bk ? (bk.motestypId || null) : null; }
  }

  // 4. Mötestyp (hoppas över när Code.gs redan slagit upp den via resolveMotestyp)
  let typ = deps.typ || null;
  if (!typ) {
    const motestypId = typeof req.motestypId === 'string' ? req.motestypId : '';
    typ = (config.motestyper || []).find(t => t && t.id === motestypId) || null;
    const typOk = typ && (typTillatenForBokare(typ, bokare) || (undantaTyp !== null && undantaTyp === typ.id));
    if (!typOk) return availFel('E_VALIDATION', AVAIL_STATISKA_FEL.motestyp, { falt: { motestypId: AVAIL_STATISKA_FEL.motestyp } });
  }
  if (typeof typ.langdMin !== 'number' || !(typ.langdMin > 0))
    return availFel('E_VALIDATION', AVAIL_STATISKA_FEL.motestyp, { falt: { motestypId: AVAIL_STATISKA_FEL.motestyp } });

  // 5. Egen reservation undantas (spec 5.11) – Calendar.gs markerar den dessutom ignore:true/egenReservation
  const reservationId = typeof req.reservationId === 'string' ? req.reservationId : '';
  if (reservationId) busy = busy.filter(b => !(b.kalla === 'reservation' && b.id === reservationId));

  const forstaDag = firstBookableDay(cfg, typ, idag);

  // 6. Geokodning av bokarens adress och restidstabell
  let geo = { status: 'saknas', formaterad: '' }, X = null, T = null;
  if (typ.restid) {
    const adress = typeof req.adress === 'string' ? req.adress.replace(/[\u0000-\u001F\u007F]/g, ' ').trim() : '';
    if (adress.length > 200) return availFel('E_VALIDATION', AVAIL_STATISKA_FEL.adress, { falt: { adress: AVAIL_STATISKA_FEL.adress } });
    if (adress) {
      const g = deps.geocode(adress) || { status: 'okand' };
      if (g.status === 'rate') return availFel('E_RATE', g.typ === 'adresser' ? 'För många adresser – kontakta CJ' : 'För många adressuppslag – vänta en stund', { typ: g.typ || 'geocode' });
      geo = { status: g.status === 'ok' ? 'ok' : 'okand', formaterad: g.status === 'ok' ? String(g.formaterad || '') : '' };
      X = g.status === 'ok' ? { lat: g.lat, lng: g.lng, geokodad: true } : { geokodad: false };
    }
  }
  // Ankare vars plats bara är text (privat Google-kalender, Bokningar utan inkorgspost, Outlook-ICS) geokodas här
  // (spec 5.2 hasPlace = platsen geokodas, 4.6 bara händelser som räknas, 5.8 par mot varje unik plats). Misslyckas
  // geokodningen förblir ankaret ett ankare med schablon (5.13). Går via samma cachekedja som bokarens adress och
  // räknar bara mot MAPS_DAILY_CAP – per-kod-gränserna gäller enbart bokarens adress (Code.gs checkAdressLimits).
  // Körs oberoende av mötestyp och av om bokarens adress tolkats (efter bokarens adress, så att den får dagstaket först):
  // områdesetiketten (A56) ska visas på samma block oavsett vilken mötestyp bokaren tittar på – calendar-preview geokodar
  // samma texter till cache-filen, så anropet är i regel en cache-träff.
  if (typeof deps.geocode === 'function') busy = geokodaAnkare(busy, deps.geocode);
  if (typ.restid) T = buildTravelTable(X, X && X.geokodad ? unikaPlatser(busy, cfg) : [], cfg, deps.travelSek);

  // 7. Dag för dag
  const dagar = [];
  let restidOkand = !!typ.restid && geo.status !== 'ok';
  for (let D = from; D <= to; D = addDays(D, 1)) {
    const busyDay = availBusyForDay(busy, D);
    const st = dayStatus(D, cfg, forstaDag, sistaDag, busyDay);
    if (st.status === 'oppen') {
      const plan = dayPlan(D, cfg, typ, X, busyDay, T);
      plan.block = blockFor(busyDay.filter(b => !b.ignore && !b.heldag), cfg.arbetstider[weekdayOf(D)], bokare.id);
      if (plan.slots.some(s => s.status === 'ledig' && s.restidOkand)) restidOkand = true;
      dagar.push(plan);
    } else {
      const at = cfg.arbetstider[weekdayOf(D)];
      const d = { datum: D, veckodag: weekdayOf(D), status: st.status, reason: st.reason, block: [], slots: [] };
      if (at) { d.arbetstid = arbetstidFor(at); d.fysiska = 0; d.maxFysiska = cfg.maxFysiskaPerDag; }
      dagar.push(d);
    }
  }

  return {
    ok: true,
    data: {
      paus: { aktiv: cfg.paus.aktiv, tom: cfg.paus.tom, meddelande: cfg.paus.meddelande },
      tz: APP_TZ,
      genererad: availNowIso(now),
      forstaBokningsbaraDag: forstaDag,
      sistaDag,
      restidOkand,
      geo,
      dagar
    }
  };
}
// Geokodar ankare med platstext men utan koordinater (kopior – indata muteras inte). Samma platstext geokodas en gång.
function geokodaAnkare(busy, geocodeFn) {
  if (typeof geocodeFn !== 'function') return busy;
  const perText = {};
  return busy.map(b => {
    if (!b || !b.hasPlace || b.ignore || b.heldag || platsGeokodad(b.plats)) return b;
    const text = b.plats && typeof b.plats.text === 'string' ? b.plats.text.trim() : '';
    if (!text) return b;
    if (perText[text] === undefined) {
      let g = null;
      try { g = geocodeFn(text); } catch (e) { g = null; }
      perText[text] = g && g.status === 'ok' && typeof g.lat === 'number' && typeof g.lng === 'number' && isFinite(g.lat) && isFinite(g.lng)
        ? { lat: g.lat, lng: g.lng, omrade: omradeRensa_(g.omrade && g.omrade.etikett) } : null;
    }
    const p = perText[text];
    if (!p) return b;
    const plats = Object.assign({}, b.plats, { lat: p.lat, lng: p.lng, geokodad: true });
    if (p.omrade) plats.omrade = p.omrade;
    return Object.assign({}, b, { plats });
  });
}
// Områdesetikett ur en BusyItem-plats (steg 2c): bara geokodade platser, rensad och klippt; '' annars.
function platsOmrade(plats) {
  if (!platsGeokodad(plats)) return '';
  const o = plats.omrade;
  return omradeRensa_(o && typeof o === 'object' ? o.etikett : o);
}
function omradeRensa_(s) {
  return String(s || '').replace(/[<>]/g, ' ').replace(/[\u0000-\u001F\u007F]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, AVAIL_OMRADE_MAX);
}
// omrade-objekt ur en cachad post/inkorgens geo (sträng = etikett) → { stad, stadsdel, etikett } eller null när inget finns.
function omradeObj_(v) {
  if (v && typeof v === 'object') return { stad: omradeRensa_(v.stad), stadsdel: omradeRensa_(v.stadsdel), etikett: omradeRensa_(v.etikett) };
  if (typeof v === 'string' && v.trim()) return { stad: '', stadsdel: '', etikett: omradeRensa_(v) };
  return null;
}
// Områdesfält ur Geocoding address_components (steg 2c, A56): locality (annars postal_town) → stad; sublocality_level_1 (annars
// sublocality, annars neighborhood) → stadsdel; etikett 'Stad · Stadsdel' (bara stad när stadsdel saknas eller är samma som staden).
function omradeFranComponents_(comps) {
  if (!Array.isArray(comps)) return { stad: '', stadsdel: '', etikett: '' };
  const av = typer => {
    for (let i = 0; i < typer.length; i++) {
      const c = comps.find(x => x && Array.isArray(x.types) && x.types.indexOf(typer[i]) >= 0 && typeof x.long_name === 'string' && x.long_name.trim());
      if (c) return omradeRensa_(c.long_name).slice(0, 40);
    }
    return '';
  };
  const stad = av(['locality', 'postal_town']);
  let stadsdel = av(['sublocality_level_1', 'sublocality', 'neighborhood']);
  if (stadsdel && stad && stadsdel.toLowerCase() === stad.toLowerCase()) stadsdel = '';
  return { stad, stadsdel, etikett: omradeRensa_([stad, stadsdel].filter(Boolean).join(' · ')) };
}
// ---------- 1k. previewResor (steg 2c, A57) – restid mellan dagens restidsankare för Kalenderkoll (calendar-preview) ----------
// busy = BusyItem-segment i Calendar.gs-form (datum/startMin/slutMin, gärna efter geokodaAnkare), cfg = mapCfg(inst),
// parFn(par:[{ a, b }]) → { svar:{ cachenyckel: sek | { sek, forLangt } | null }, overCap } (travelSecondsForPairs_ eller stubb).
// Kedja per dag: på varandra följande ankare (isTravelMeeting, ej ignorerade, ej heldag) i starttidsordning; platslösa händelser
// (Teams m.fl.) hoppas över utan att bryta kedjan men är hinder för resans placering (placeTravel, 5.6). Plus bas→första när
// cfg.restidTillForsta och sista→bas när cfg.restidEfterSista – som i dayPlan: är basen inte geokodad blir bas-benet schablon
// (samma tid som bokarna blockeras av). Ett segment som börjar 00:00 eller slutar 24:00 (händelse över midnatt, splitToDays) får
// inget bas-ben vid dygnsgränsen – händelsen fortsätter från/in i grannsdagen, ingen resa hem/hit sker där.
// Resa: { datum, franId|'bas', tillId|'bas', start:'HH:MM', slut:'HH:MM', minuter, status:'ok'|'schablon'|'okand', konflikt }.
//   minuter: Distance Matrix + marginal (5.8) → 'ok'; "för långt" (fågelväg > 150 km) → uppskattning (fågelväg/70 km/h + marginal,
//   samma som availability) → 'ok'; ogeokodad ändpunkt → schablonminuter → 'schablon'; par som inte fick beräknas (taket
//   AVAIL_PREVIEW_MAX_PAR, dagstak, API-fel) → schablonminuter + 'okand'. Samma koordinater i båda ändar (0 s) → benet UTELÄMNAS
//   ur resor (version 7, K3 – ingen resa, ingen marginal; klienterna ska ändå tåla minuter 0 om det kommer).
//   Placering: inresa slutar vid mötets start (hoppar bakåt över platslösa hinder); utresa efter sista mötet börjar vid mötets slut
//   + cooldown. Ryms resan inte mellan föregående mötes slut + cooldown och nästa mötes start (för tajt) → konflikt:true och resan
//   ritas ändå närmast mötet (överlappar föregående möte/cooldown).
// → { resor:[…], overCap }. Ren funktion (inga Google-tjänster).
function previewResor(busy, cfg, parFn) {
  const perDag = {};
  (busy || []).forEach(b => {
    if (!b || b.ignore || b.heldag || typeof b.datum !== 'string' || typeof b.startMin !== 'number' || typeof b.slutMin !== 'number') return;
    (perDag[b.datum] = perDag[b.datum] || []).push(b);
  });
  const bas = cfg.basadress ? { lat: cfg.basadress.lat, lng: cfg.basadress.lng, geokodad: !!cfg.basadress.geokodad } : null;
  const ben = [];
  Object.keys(perDag).sort().forEach(D => {
    const dag = perDag[D].slice().sort((x, y) => x.startMin - y.startMin || x.slutMin - y.slutMin);
    const ankare = dag.filter(b => b.isTravelMeeting);
    if (!ankare.length) return;
    const platslos = dag.filter(b => !b.isTravelMeeting).map(b => [b.startMin, b.slutMin + (b.cooldownMin || 0)]);
    const forsta = ankare[0], sista = ankare[ankare.length - 1];
    if (bas && cfg.restidTillForsta && forsta.startMin > 0) ben.push({ datum: D, fran: 'bas', till: forsta, platslos });
    for (let i = 1; i < ankare.length; i++) ben.push({ datum: D, fran: ankare[i - 1], till: ankare[i], platslos });
    if (bas && cfg.restidEfterSista && sista.slutMin < 1440) ben.push({ datum: D, fran: sista, till: 'bas', platslos });
  });
  const platsAv = x => x === 'bas' ? bas : (x.plats || null);
  const par = [];
  ben.forEach(l => {
    const a = platsAv(l.fran), b = platsAv(l.till);
    if (!platsGeokodad(a) || !platsGeokodad(b)) return;
    par.push(l.till === 'bas' ? { a: b, b: a } : { a, b });   // basen som origin när den ingår → färre Distance Matrix-anrop
  });
  let svar = {}, overCap = 0;
  if (par.length && typeof parFn === 'function') { const r = parFn(par) || {}; svar = r.svar || {}; overCap = r.overCap | 0; }
  const schablon = cfg.restid.schablonMin;
  const resor = ben.map(l => {
    const a = platsAv(l.fran), b = platsAv(l.till);
    let minuter = schablon, status = 'schablon';
    if (platsGeokodad(a) && platsGeokodad(b)) {
      const v = svar[cachenyckel(a, b)];
      if (v === 0) return null;   // samma koordinater → 0 min, ingen resa: benet UTELÄMNAS (version 7, K3)
      if (typeof v === 'number' && isFinite(v) && v >= 0) { minuter = travelWithMargin(v, cfg.restid); status = 'ok'; }
      else if (v && typeof v === 'object' && typeof v.sek === 'number') { minuter = travelWithMargin(v.sek, cfg.restid); status = 'ok'; }   // "för långt" = uppskattning, inte schablon
      else status = 'okand';
    }
    let start, slut, konflikt = false, block = null;
    if (l.till !== 'bas') {
      slut = l.till.startMin; start = slut - minuter;
      const gapStart = l.fran === 'bas' ? 0 : l.fran.slutMin + (l.fran.cooldownMin || 0);
      block = placeTravel(gapStart, slut, l.platslos, minuter, 'in');
    } else {
      start = l.fran.slutMin + (l.fran.cooldownMin || 0); slut = start + minuter;
      block = placeTravel(start, 1440, l.platslos, minuter, 'ut');
    }
    if (block) { start = block[0]; slut = block[1]; } else konflikt = true;
    return {
      datum: l.datum, franId: l.fran === 'bas' ? 'bas' : String(l.fran.id || ''), tillId: l.till === 'bas' ? 'bas' : String(l.till.id || ''),
      start: minToHhmm(Math.max(0, start)), slut: minToHhmm(Math.min(1440, slut)), minuter, status, konflikt
    };
  }).filter(Boolean);
  return { resor, overCap };
}
// Tar bort råa restidsminuter (restidMin) före export till bokaren (spec 5.12).
function stripInternAvailability(data) {
  return Object.assign({}, data, { dagar: data.dagar.map(d => Object.assign({}, d, { slots: d.slots.map(s => { const c = Object.assign({}, s); delete c.restidMin; return c; }) })) });
}

// =====================================================================================
// 2. Wrappers mot Google-tjänster (isolerade så att de rena funktionerna ovan aldrig rör dem)
// =====================================================================================
function availCache() { return CacheService.getScriptCache(); }
function cacheGetJson(key) { try { const v = availCache().get(key); return v ? JSON.parse(v) : null; } catch (e) { return null; } }
function cachePutJson(key, obj, ttlS) { try { availCache().put(key, JSON.stringify(obj), Math.min(21600, ttlS)); } catch (e) { /* cache är best effort */ } }

// --- Maps-nyckel, dagstak, block och varning (spec 4.2, 5.8, A5). Räknaren maps_elements_<YYYYMMDD> ägs av Code.gs. ---
function mapsApiKey() { return getProp(PROP.MAPS_API_KEY); }
function mapsKanAnropa(antalElement) {
  if (!mapsApiKey()) return false;
  if (availCache().get('maps:block')) return false;
  return mapsElementsToday() + antalElement <= mapsDailyCap();
}
function mapsSetBlock() { try { availCache().put('maps:block', '1', AVAIL_MAPS_BLOCK_S); } catch (e) {} }
// Varningen läses av ping (Code.gs) ur CacheService 'maps:varning' och visas i Inställningar › Maps-status.
function mapsSetVarning(msg) { try { availCache().put('maps:varning', String(msg || '').slice(0, 200), AVAIL_MAPS_VARNING_S); } catch (e) {} }
// Toppnivåstatus från Geocoding/Distance Matrix; returnerar true om anropet ska ge schablon.
function mapsHanteraToppstatus(status, errorMessage) {
  if (status === 'OK' || status === 'ZERO_RESULTS') return false;
  if (status === 'OVER_QUERY_LIMIT') { mapsSetBlock(); return true; }
  if (status === 'REQUEST_DENIED' || status === 'INVALID_REQUEST' || status === 'OVER_DAILY_LIMIT') { mapsSetVarning('Nyckeln avvisad: ' + (errorMessage || status)); return true; }
  return true;
}

// --- Cache-filen telexia-bokning-cache.json (spec 4.1). readCacheFile/writeCacheFile ägs av Code.gs (getFileById + getBlob/setContent). ---
// Memo per körning (A51): cache-filen läses högst en gång per anrop. Utan memot gjorde varje geokod-miss i CacheService
// (geo:<hash>, TTL 6 h – alla nycklar går ut ungefär samtidigt) en egen Drive-läsning (~0,3–1 s), och ett availability-anrop
// med ~100 ICS-platser tog tiotals sekunder efter varje 6 h-fönster (bokningssidans timeout är 15 s). doPost nollställer memot
// (availResetMemo_) så att varje request läser filen färskt; updateCacheFile läser alltid färskt före skrivning och sätter memot
// till det skrivna objektet. Ett fel vid läsning memoiseras inte (nästa försök läser igen) – tillgängligheten ska aldrig falla
// på cachen. Nya geokodposter samlas i AVAIL_GEOKOD_PENDING och skrivs EN gång per körning (availFlushGeokod_, anropas av
// doPost efter handlern) i stället för en läsning + skrivning per ny adress – första anropet med många nya ICS-platser gjorde
// annars tiotals Drive-omgångar. Version 7: även nya restidspar (Distance Matrix, travelSecondsForPairs_) samlas i
// AVAIL_RESTID_PENDING och skrivs i SAMMA läs-ändra-skriv – förut skrev travelSecondsForPairs_ filen direkt vid varje anrop med
// nya par (en extra Drive-omgång per availability/preview utöver geokod-skrivningen). dailyMaintenance och refreshIcsCache
// (Code.gs) anropar availFlushGeokod_ i finally precis som doPost, så pending tappas aldrig.
let AVAIL_FIL_MEMO = null;
let AVAIL_GEOKOD_PENDING = {};
let AVAIL_RESTID_PENDING = {};
// AVAIL_GEO_MEMO: körningens geokodningsresultat per normaliserad adressnyckel. Behövs för placeId-flödet (steg 2b): reserve/book/
// availability geokodar med placeId FÖRE låset/beräkningen, och computeAvailability/findSlot/warmSlotCaches (som bara har adressen)
// träffar memot i samma körning utan att resultatet cachas under den skrivna adressen (se geocodeAddress).
let AVAIL_GEO_MEMO = {};
function availResetMemo_() { AVAIL_FIL_MEMO = null; AVAIL_GEOKOD_PENDING = {}; AVAIL_RESTID_PENDING = {}; AVAIL_GEO_MEMO = {}; }
// Skriver körningens nya geokod- OCH restidsposter till cache-filen (färsk läsning + en skrivning; namnet behålls – doPost anropar det).
// → true om filen skrevs. Kastar aldrig.
function availFlushGeokod_() {
  const geoNycklar = Object.keys(AVAIL_GEOKOD_PENDING), restidNycklar = Object.keys(AVAIL_RESTID_PENDING);
  if (!geoNycklar.length && !restidNycklar.length) return false;
  const pendGeo = AVAIL_GEOKOD_PENDING, pendRestid = AVAIL_RESTID_PENDING;
  AVAIL_GEOKOD_PENDING = {}; AVAIL_RESTID_PENDING = {};
  return updateCacheFile(obj => {
    if (!obj.geokod || typeof obj.geokod !== 'object') obj.geokod = {};
    if (!obj.restid || typeof obj.restid !== 'object') obj.restid = {};
    geoNycklar.forEach(k => { obj.geokod[k] = pendGeo[k]; });
    restidNycklar.forEach(k => { obj.restid[k] = pendRestid[k]; });
    return true;
  });
}
function readCacheFileSafe() {
  if (AVAIL_FIL_MEMO) return AVAIL_FIL_MEMO;
  try { AVAIL_FIL_MEMO = readCacheFile(); } catch (e) { AVAIL_FIL_MEMO = null; }
  return AVAIL_FIL_MEMO;
}
// Läs-ändra-skriv utan eget lås: filen är en ren cache (alla värden kan räknas om), och ett eget LockService-anrop inuti
// book/reserve (som redan håller scriptlåset) skulle riskera att släppa deras lås. En förlorad uppdatering är ofarlig.
// Läser alltid färskt (aldrig memot) så att en annan körnings skrivning inte skrivs över i onödan; memot sätts till objektet.
// mutator(obj) returnerar true när något ändrats. Returnerar true om filen skrevs.
function updateCacheFile(mutator) {
  try {
    const obj = readCacheFile();
    if (!mutator(obj)) { AVAIL_FIL_MEMO = obj; return false; }
    writeCacheFile(obj);
    AVAIL_FIL_MEMO = obj;
    return true;
  } catch (e) { AVAIL_FIL_MEMO = null; return false; }
}
// ICS-reserv (spec 4.1 icsReserv) – anropas av Calendar.gs (lasIcsReserv_/sparaIcsReserv_).
function readIcsReserv() { const c = readCacheFileSafe(); return c ? (c.icsReserv || null) : null; }
// writeIcsReserv(reserv, opts?) – opts.minAlderMs: skriv bara om filens befintliga icsReserv.hamtadTs är äldre än så
// (Calendar.gs använder 15 min så att ett stort, ocachat ICS-flöde inte skriver cache-filen vid varje anrop).
// Returnerar true om filen skrevs.
function writeIcsReserv(reserv, opts) {
  const minAlderMs = opts && Number(opts.minAlderMs) > 0 ? Number(opts.minAlderMs) : 0;
  return updateCacheFile(obj => {
    if (minAlderMs && obj.icsReserv && typeof obj.icsReserv.hamtadTs === 'string' && obj.icsReserv.hamtadTs) {
      const ts = new Date(obj.icsReserv.hamtadTs).getTime();
      if (!isNaN(ts) && Date.now() - ts < minAlderMs) return false;
    }
    obj.icsReserv = reserv || null;
    return true;
  });
}

// --- Geokodning (spec 5.8) ---
// Normaliserad adressnyckel: gemener, utan skiljetecken, ett mellanslag, utan "sverige" (spec 4.1).
function normalizeAdressKey(adress) {
  return String(adress || '').toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\bsverige\b/g, ' ')
    .replace(/\s+/g, ' ').trim();
}
// geocodeAddress(adress, opts?) → { status:'ok', lat, lng, formaterad, omrade?:{ stad, stadsdel, etikett } } | { status:'okand' } | { status:'saknas' }.
// omrade (steg 2c, A56) följer med genom hela cachekedjan (memo, CacheService geo:, cache-filens geokodpost); saknas det i en äldre
// cachepost utelämnas fältet (etikett '') tills dailyMaintenance backfillOmrade_ geokodat om posten.
// Cachekedja (adress): körningens memo (AVAIL_GEO_MEMO) → CacheService geo:<hash(nyckel)> → cache-filens geokod[nyckel]
// → Geocoding API (region=se, components=country:SE). Resultatet cachas under den skrivna adressens nyckel (Google tolkade texten).
// opts.placeId (steg 2b, från adressforslag): Geocoding API anropas med place_id=… i stället för address=… – exakt träff, ingen
// tolkning (samma Geocoding-SKU som adressgeokodning – vinsten är exakthet, inte pris). Kedja: memo → CacheService geo:pid:<hash(placeId)>
// (6 h) → API. Resultatet cachas ALDRIG under den SKRIVNA adressens nyckel (varken CacheService eller cache-filen): adress och placeId
// kommer båda från klienten och scriptet kan inte verifiera att texten hör till id:t – annars kunde en bokare (eller en klientbugg)
// skicka { adress:'Kungsgatan 1, Stockholm', placeId:<id för Kiruna> } och binda den adresstexten till fel koordinater för ALLA bokare
// (cache-filen läses för alltid). I stället cachas: (a) geo:pid (id → koordinater är Googles sanning), (b) den FORMATERADE adressens
// nyckel (Googles egen text) i CacheService och cache-filen – steg 2b: "cache-nyckeln i cache-filen blir den formaterade adressen",
// (c) körningens memo under den skrivna nyckeln så att computeAvailability/findSlot/warmSlotCaches i SAMMA request (som bara har
// adressen) träffar utan nytt anrop; nästa request (availability → reserve → book) bär placeId igen → geo:pid-träff.
// Inaktuellt place-id (Google: place-id:n kan bli inaktuella; INVALID_REQUEST/NOT_FOUND) → adressgeokodning i samma anrop (ett
// element till) – det resultatet är Googles tolkning av texten och cachas som vanlig adressgeokodning.
// ZERO_RESULTS (Google tolkade frågan men fann inget – kalendertexter som 'Konferensrum 3') sparas i cache-filen som
// { status:'okand', ts } och gäller AVAIL_GEO_OKAND_FIL_DAGAR (gallraCacheFil rensar > 180 dagar); en sådan filpost ger 'okand' utan
// API-anrop. Andra fel ('okand' utan ingaTraffar) memoiseras bara 1 h i CacheService.
// opts.utanApi (calendar-preview-taket AVAIL_PREVIEW_MAX_GEO): hela cachekedjan som vanligt men INGET API-anrop – i stället
// { status:'okand', overCap:true } (cachas inte; nästa anrop försöker igen).
// Per-kod-gränserna (20 geokodningar/h, 20 adresser/dag) kontrolleras av Code.gs (checkAdressLimits) före anropet;
// här räknas bara dagstaket MAPS_DAILY_CAP. Kastar aldrig – fel ger 'okand' (schablon).
function geocodeAddress(adress, opts) {
  const placeId = opts && typeof opts.placeId === 'string' && AVAIL_PLACE_ID_RE.test(opts.placeId) ? opts.placeId : '';
  const key = normalizeAdressKey(adress);
  if (!key) return { status: 'saknas' };
  const memo = AVAIL_GEO_MEMO[key];
  if (memo && (memo.status === 'ok' || (memo.status === 'okand' && !placeId))) return memo;
  if (placeId) return geocodeViaPlaceId_(adress, key, placeId);
  const cacheKey = 'geo:' + sha256hex(key);
  const hit = cacheGetJson(cacheKey);
  if (hit && (hit.status === 'ok' || hit.status === 'okand')) { AVAIL_GEO_MEMO[key] = hit; return hit; }
  const fil = readCacheFileSafe();
  const post = fil && fil.geokod ? fil.geokod[key] : null;
  if (post && post.status === 'ok' && typeof post.lat === 'number' && typeof post.lng === 'number') {
    const ut = { status: 'ok', lat: post.lat, lng: post.lng, formaterad: String(post.formaterad || '') };
    const om = omradeObj_(post.omrade); if (om) ut.omrade = om;   // äldre poster utan omrade → ingen etikett tills nattens backfill
    cachePutJson(cacheKey, ut, AVAIL_CACHE_TTL_GEO_OK_S);
    AVAIL_GEO_MEMO[key] = ut;
    return ut;
  }
  if (post && post.status === 'okand' && geoOkandPostGiltig_(post)) {
    const ut = { status: 'okand' };
    cachePutJson(cacheKey, ut, AVAIL_CACHE_TTL_GEO_OKAND_S);
    AVAIL_GEO_MEMO[key] = ut;
    return ut;
  }
  if (opts && opts.utanApi === true) return { status: 'okand', overCap: true };
  if (!mapsApiKey()) {   // ingen nyckel: memoisera 1 h så att inte varje availability-anrop läser cache-filen för samma ankartexter
    cachePutJson(cacheKey, { status: 'okand' }, AVAIL_CACHE_TTL_GEO_OKAND_S);
    AVAIL_GEO_MEMO[key] = { status: 'okand' };
    return { status: 'okand' };
  }
  if (!mapsKanAnropa(1)) return { status: 'okand' };
  const svar = geocodeViaApi(adress);
  if (svar.status === 'ok') {
    cachePutJson(cacheKey, svar, AVAIL_CACHE_TTL_GEO_OK_S);
    AVAIL_GEO_MEMO[key] = svar;
    geoSparaPost_(key, svar);
  } else if (svar.status === 'okand') {
    cachePutJson(cacheKey, { status: 'okand' }, AVAIL_CACHE_TTL_GEO_OKAND_S);
    AVAIL_GEO_MEMO[key] = { status: 'okand' };
    if (svar.ingaTraffar === true) geoSparaOkand_(key);
  }
  // nyttAnrop:true = Geocoding-API:t anropades (Code.gs räknar MAX_GEOCODE_PER_KOD_H bara på sådana; cachas aldrig).
  return Object.assign({ nyttAnrop: true }, svar);
}
// Filpost { status:'okand', ts } gäller AVAIL_GEO_OKAND_FIL_DAGAR från ts; utan/ogiltig ts → ogiltig (geokodas om).
function geoOkandPostGiltig_(post) {
  const t = post && typeof post.ts === 'string' ? new Date(post.ts).getTime() : NaN;
  return !isNaN(t) && Date.now() - t < AVAIL_GEO_OKAND_FIL_DAGAR * 86400000;
}
// place_id-grenen av geocodeAddress (se kommentaren ovan). key = den skrivna adressens normaliserade nyckel (bara memo).
function geocodeViaPlaceId_(adress, key, placeId) {
  const pidKey = 'geo:pid:' + sha256hex(placeId);
  const hit = cacheGetJson(pidKey);
  if (hit && hit.status === 'ok' && typeof hit.lat === 'number' && typeof hit.lng === 'number') { AVAIL_GEO_MEMO[key] = hit; return hit; }
  if (!mapsKanAnropa(1)) return { status: 'okand' };
  const svar = geocodeViaApi(adress, placeId);
  // Ogiltigt/inaktuellt place-id → en gång till med adressen som förut (vanlig kedja; nyttAnrop gäller redan place_id-anropet).
  if (svar.placeIdOgiltigt === true) return Object.assign({ nyttAnrop: true }, geocodeAddress(adress));
  if (svar.status === 'ok') {
    const ut = { status: 'ok', lat: svar.lat, lng: svar.lng, formaterad: svar.formaterad };
    if (svar.omrade) ut.omrade = svar.omrade;
    cachePutJson(pidKey, ut, AVAIL_CACHE_TTL_GEO_OK_S);
    AVAIL_GEO_MEMO[key] = ut;
    const fk = normalizeAdressKey(svar.formaterad);
    if (fk) {   // Googles formaterade adress → vanlig adresspost (den texten hör bevisligen till koordinaterna)
      cachePutJson('geo:' + sha256hex(fk), ut, AVAIL_CACHE_TTL_GEO_OK_S);
      AVAIL_GEO_MEMO[fk] = ut;
      geoSparaPost_(fk, ut);
    }
  }
  return Object.assign({ nyttAnrop: true }, svar);
}
// Primar körningens geokodmemo med en redan känd geokodning – inkorgspostens geo vid ren tidsflytt i rebook/egen-rebook (bokningens
// egen, exakta geokodning) – så att findSlot/computeAvailability (som bara har adressen) träffar utan Geocoding-anrop. Skriver
// inget i CacheService eller cache-filen (posten kan ha geokodats via placeId – adresstexten binds inte till koordinaterna).
// → true om memot primades (geo.status 'ok' med numeriska lat/lng), annars false (anroparen geokodar som vanligt).
function geoPrimeMemo_(adress, geo) {
  const key = normalizeAdressKey(adress);
  if (!key || !geo || geo.status !== 'ok' || typeof geo.lat !== 'number' || typeof geo.lng !== 'number' || !isFinite(geo.lat) || !isFinite(geo.lng)) return false;
  const memo = { status: 'ok', lat: geo.lat, lng: geo.lng, formaterad: String(geo.formaterad || '') };
  const om = omradeObj_(geo.omrade); if (om) memo.omrade = om;
  AVAIL_GEO_MEMO[key] = memo;
  return true;
}
// Ny geokodpost till cache-filen (skrivs samlat av availFlushGeokod_ i doPost) + körningens fil-memo.
function geoSparaPost_(k, svar) {
  const post = { lat: svar.lat, lng: svar.lng, formaterad: svar.formaterad, status: 'ok', ts: availNowIso(), omrade: omradeObj_(svar.omrade) || { stad: '', stadsdel: '', etikett: '' } };
  AVAIL_GEOKOD_PENDING[k] = post;
  if (AVAIL_FIL_MEMO && AVAIL_FIL_MEMO.geokod && typeof AVAIL_FIL_MEMO.geokod === 'object') AVAIL_FIL_MEMO.geokod[k] = post;
}
// ZERO_RESULTS-post till cache-filen: { status:'okand', ts } (giltig AVAIL_GEO_OKAND_FIL_DAGAR; backfillOmrade_ rör aldrig sådana).
function geoSparaOkand_(k) {
  const post = { status: 'okand', ts: availNowIso() };
  AVAIL_GEOKOD_PENDING[k] = post;
  if (AVAIL_FIL_MEMO && AVAIL_FIL_MEMO.geokod && typeof AVAIL_FIL_MEMO.geokod === 'object') AVAIL_FIL_MEMO.geokod[k] = post;
}
// Rent API-anrop. Räknar 1 element mot dagstaket oavsett utfall. Fel/undantag → 'okand' (ingen cache).
// placeId (valfri, redan validerad) → place_id=… (Geocoding API:s "place ID lookup": bara place_id, language och key –
// region/components hör till adressgeokodning); annars address=… som förut. Nyckeln ligger i URL:en (Geocoding API tar den
// bara så) och loggas aldrig.
function geocodeViaApi(adress, placeId) {
  const url = 'https://maps.googleapis.com/maps/api/geocode/json?' +
    (placeId ? 'place_id=' + encodeURIComponent(String(placeId)) + '&language=sv'
             : 'address=' + encodeURIComponent(String(adress).slice(0, 200)) + '&region=se&components=country:SE&language=sv') +
    '&key=' + encodeURIComponent(mapsApiKey());
  let json = null;
  try {
    addMapsElements(1);
    const res = UrlFetchApp.fetch(url, { muteHttpExceptions: true, followRedirects: true });
    json = JSON.parse(res.getContentText());
  } catch (e) { return { status: 'okand' }; }
  if (!json) return { status: 'okand' };
  // place_id som Google inte känner igen svarar INVALID_REQUEST/NOT_FOUND (inaktuellt id) – ingen "Nyckeln avvisad"-varning,
  // geocodeAddress faller tillbaka på adressgeokodning.
  if (placeId && (json.status === 'INVALID_REQUEST' || json.status === 'NOT_FOUND' || json.status === 'ZERO_RESULTS')) return { status: 'okand', placeIdOgiltigt: true };
  if (mapsHanteraToppstatus(json.status, json.error_message)) return { status: 'okand', toppfel: true };   // nyckel/kvot-fel (backfillOmrade_ avbryter natten)
  if (json.status === 'ZERO_RESULTS') return { status: 'okand', ingaTraffar: true };   // tolkningsbart svar utan träff (backfillOmrade_ skiljer det från fel)
  const r = json.status === 'OK' && Array.isArray(json.results) && json.results[0];
  const loc = r && r.geometry && r.geometry.location;
  if (!loc || typeof loc.lat !== 'number' || typeof loc.lng !== 'number') return { status: 'okand' };
  return { status: 'ok', lat: loc.lat, lng: loc.lng, formaterad: String(r.formatted_address || '').replace(/[<>]/g, ' ').slice(0, 200),
    omrade: omradeFranComponents_(r.address_components) };
}
// Engångs-backfill (steg 2c, dailyMaintenance): geokodposter i cache-filen som saknar omrade geokodas om (Googles formaterade adress,
// annars nyckeln), högst max per körning, räknat mot MAPS_DAILY_CAP (stopp när taket/blocket hindrar). Poster märkta gallrad:true
// (adress till gallrad bokning, på väg bort) och status:'okand'-poster hoppas över. ZERO_RESULTS → tomt omrade (försöks inte igen);
// nyckel/kvot-fel (toppfel) → natten avbryts; annat fel (undantag, svar utan geometri) → posten lämnas till nästa natt och nästa post
// försöks – efter AVAIL_BACKFILL_FEL_MAX sådana fel i rad avbryts natten (en enstaka trasig post får inte stoppa alla andra).
// Skriver filen en gång. → antal omgeokodade poster. Kastar aldrig.
function backfillOmrade_(max) {
  let fil = null;
  try { fil = readCacheFile(); } catch (e) { return 0; }
  if (!fil || !fil.geokod || typeof fil.geokod !== 'object') return 0;
  const nycklar = Object.keys(fil.geokod).filter(k => {
    const p = fil.geokod[k];
    return p && typeof p === 'object' && p.status === 'ok' && typeof p.lat === 'number' && p.gallrad !== true && (p.omrade === undefined || p.omrade === null);
  }).slice(0, Math.max(0, max | 0));
  const nya = {};
  let fel = 0;
  for (let i = 0; i < nycklar.length; i++) {
    if (!mapsKanAnropa(1)) break;
    const k = nycklar[i], p = fil.geokod[k];
    const svar = geocodeViaApi(typeof p.formaterad === 'string' && p.formaterad.trim() ? p.formaterad : k);
    if (svar.status === 'ok') { nya[k] = omradeObj_(svar.omrade) || { stad: '', stadsdel: '', etikett: '' }; fel = 0; }
    else if (svar.ingaTraffar === true) { nya[k] = { stad: '', stadsdel: '', etikett: '' }; fel = 0; }
    else if (svar.toppfel === true || ++fel >= AVAIL_BACKFILL_FEL_MAX) break;
  }
  const antal = Object.keys(nya).length;
  if (!antal) return 0;
  updateCacheFile(obj => {
    if (!obj.geokod || typeof obj.geokod !== 'object') return false;
    let andrad = false;
    Object.keys(nya).forEach(k => { if (obj.geokod[k] && typeof obj.geokod[k] === 'object') { obj.geokod[k].omrade = nya[k]; andrad = true; } });
    return andrad;
  });
  return antal;
}

// --- Adressförslag via Places API (New) Autocomplete (steg 2b) ---
// hamtaAdressforslag(q, sessionToken) → { forslag:[{ text, placeId, huvud, detalj }], kalla:'places'|'ingen'[, varning:'places'] }.
// Kedja: CacheService ac:<hash(normaliserad q)> (6 h) → Places (räknas som 1 element mot MAPS_DAILY_CAP, som geokodning).
// Ingen nyckel, dagstak nått, block (429, 60 s) eller fel → { forslag:[], kalla:'ingen' } – aldrig ett fel till klienten (sidan
// faller tillbaka på fritext). 403/PERMISSION_DENIED (Places API (New) inte aktiverat, eller nyckeln API-begränsad utan Places)
// → dessutom varning:'places', CacheService maps:varning = AVAIL_PLACES_VARNING (ping.mapsVarning → Drift-panelen; en befintlig
// Geocoding/Distance Matrix-varning "Nyckeln avvisad …" skrivs INTE över – den är allvarligare och gäller även restiden) och
// places:nekad i 60 s: under tiden svarar scriptet samma sak utan nytt Places-anrop (varje klients minutförsök skulle annars göra
// ett nekat anrop som räknas mot MAPS_DAILY_CAP). q som normaliseras till tomt (t.ex. 'Sverige', '...') → tom lista med kalla
// 'places' när nyckel finns (= vanligt "inga träffar"; 'ingen' får klienterna att pausa/stänga av förslagen).
// Per-kod-gränserna (60/min, 600/dag) kontrolleras av Code.gs (handleAdressforslag) före anropet. Kastar aldrig; q loggas aldrig.
function hamtaAdressforslag(q, sessionToken) {
  const key = normalizeAdressKey(q);
  if (!key) return { forslag: [], kalla: mapsApiKey() ? 'places' : 'ingen' };
  const cacheKey = 'ac:' + sha256hex(key);
  const hit = cacheGetJson(cacheKey);
  if (hit && Array.isArray(hit.forslag)) return { forslag: hit.forslag, kalla: 'places' };
  if (availCache().get('places:nekad')) return { forslag: [], kalla: 'ingen', varning: 'places' };
  if (!mapsApiKey() || availCache().get('places:block') || !mapsKanAnropa(1)) return { forslag: [], kalla: 'ingen' };
  const svar = placesAutocomplete_(q, sessionToken);
  if (svar.status === 'ok') {
    cachePutJson(cacheKey, { forslag: svar.forslag }, AVAIL_AC_CACHE_S);
    return { forslag: svar.forslag, kalla: 'places' };
  }
  if (svar.status === 'nekad') {
    try {
      const nu = availCache().get('maps:varning');
      if (!nu || nu === AVAIL_PLACES_VARNING) mapsSetVarning(AVAIL_PLACES_VARNING);
      availCache().put('places:nekad', '1', AVAIL_MAPS_BLOCK_S);
    } catch (e) {}
    return { forslag: [], kalla: 'ingen', varning: 'places' };
  }
  if (svar.status === 'kvot') { try { availCache().put('places:block', '1', AVAIL_MAPS_BLOCK_S); } catch (e) {} }
  return { forslag: [], kalla: 'ingen' };
}
// Rent API-anrop mot Places API (New) – isolerat så att det kan stubbas. Räknar 1 element mot dagstaket oavsett utfall.
// → { status:'ok', forslag:[…] } | { status:'nekad' } (403/PERMISSION_DENIED/REQUEST_DENIED) | { status:'kvot' } (429) | { status:'fel' }.
// Fältnamn enligt Googles dokumentation (Places API (New) › "Autocomplete (New)" › Place Autocomplete requests/responses):
//   POST https://places.googleapis.com/v1/places:autocomplete, header X-Goog-Api-Key: <nyckel> (aldrig i URL:en),
//   Content-Type: application/json, body { input, includedRegionCodes:['se'], languageCode:'sv', sessionToken? }
//   (sessionToken = klientens UUID, ≤ 36 tecken; samma token för alla tangenttryck i en session. OBS: sessionen avslutas bara av
//   Place Details (New)/Address Validation – Geocoding gör det inte, så i dagens design faktureras varje anrop per förfrågan; se README).
//   Svar: { suggestions:[ { placePrediction:{ place:'places/<id>', placeId, text:{ text, matches }, structuredFormat:{ mainText:{ text },
//   secondaryText:{ text } }, types:[…] } } ] } – tomt objekt {} utan träffar. Fel: HTTP 4xx/5xx med { error:{ code, message,
//   status:'PERMISSION_DENIED'|'INVALID_ARGUMENT'|'RESOURCE_EXHAUSTED'|… } }. Ingen X-Goog-FieldMask krävs för autocomplete.
//   Googles feltext ekas aldrig till klienten (statisk varning) och loggas inte.
function placesAutocomplete_(q, sessionToken) {
  const body = { input: String(q).slice(0, 120), includedRegionCodes: ['se'], languageCode: 'sv' };
  if (typeof sessionToken === 'string' && sessionToken) body.sessionToken = sessionToken;
  let code = 0, json = null;
  try {
    addMapsElements(1);
    const res = UrlFetchApp.fetch(AVAIL_PLACES_URL, {
      method: 'post', contentType: 'application/json', payload: JSON.stringify(body),
      headers: { 'X-Goog-Api-Key': mapsApiKey() }, muteHttpExceptions: true, followRedirects: false
    });
    code = Number(res.getResponseCode()) || 0;
    json = JSON.parse(res.getContentText() || '{}');
  } catch (e) { return { status: 'fel' }; }
  const felStatus = json && json.error ? String(json.error.status || '') : '';
  if (code === 403 || felStatus === 'PERMISSION_DENIED' || (json && json.status === 'REQUEST_DENIED')) return { status: 'nekad' };
  if (code === 429 || felStatus === 'RESOURCE_EXHAUSTED' || (json && json.status === 'OVER_QUERY_LIMIT')) return { status: 'kvot' };
  if (code !== 200 || !json || typeof json !== 'object') return { status: 'fel' };
  const rensa = v => String(v || '').replace(/[<>]/g, ' ').replace(/[\u0000-\u001F\u007F]/g, '').replace(/\s+/g, ' ').trim().slice(0, AVAIL_AC_TEXT_MAX);
  const forslag = [];
  (Array.isArray(json.suggestions) ? json.suggestions : []).forEach(s => {
    const p = s && s.placePrediction;
    if (!p || forslag.length >= AVAIL_AC_ANTAL) return;
    const placeId = typeof p.placeId === 'string' ? p.placeId : (typeof p.place === 'string' ? p.place.replace(/^places\//, '') : '');
    if (!AVAIL_PLACE_ID_RE.test(placeId)) return;
    const text = rensa(p.text && p.text.text);
    if (!text) return;
    const sf = p.structuredFormat || {};
    forslag.push({ text: text, placeId: placeId, huvud: rensa(sf.mainText && sf.mainText.text) || text, detalj: rensa(sf.secondaryText && sf.secondaryText.text) });
  });
  return { status: 'ok', forslag: forslag };
}
// Körs i Apps Script-editorn efter att Places API (New) aktiverats (README, nyckelguiden): loggar status och antal förslag –
// aldrig nyckeln eller förslagstexterna. Förväntat { status:'ok', antal > 0 }. Räknar 1 element mot MAPS_DAILY_CAP.
function debugPlaces(q) {
  const svar = placesAutocomplete_(String(q || 'Storgatan 1'), '');
  let varning = ''; try { varning = availCache().get('maps:varning') || ''; } catch (e) {}
  console.log(JSON.stringify({ status: svar.status, antal: svar.status === 'ok' ? svar.forslag.length : 0, nyckel: !!mapsApiKey(), varning: varning }));
  if (svar.status === 'nekad') console.log('Places API (New) är inte aktiverat i Cloud-projektet eller inte tillåtet på nyckeln (403 PERMISSION_DENIED).');
  if (!mapsApiKey()) console.log('MAPS_API_KEY saknas i Script Properties.');
  return svar.status;
}

// --- Restid via Distance Matrix (spec 5.8, A2) ---
// Cachekedja per par: CacheService (6 h) → cache-filens restid[nyckel] → Distance Matrix (batch ≤ 25, symmetriantagande).
// Returnerar { <cachenyckel>: sek | { sek, forLangt:true } | null }. null = schablon.
function travelSecondsFor(X, platser) {
  return travelSecondsForPairs_(platser.map(p => ({ a: X, b: p })), AVAIL_MATRIX_MAX_PER_FRAGA).svar;
}
// Generisk parversion (steg 2c, A57 – delas av availability och calendar-preview): par = [{ a, b }] med geokodade platser.
// Samma cachekedja per par; bara par som saknas i CacheService/cache-filen (och inte är "för långt") anropar Distance Matrix,
// högst maxNya per körning – resten blir null (schablon/okand) och räknas i overCap. Anropen grupperas per origin (den punkt som
// förekommer i flest par, vid lika den första i paret) i batchar om ≤ 25 destinationer; taket/blocket eller ett toppnivåfel avbryter
// resterande anrop. → { svar:{ <cachenyckel>: sek | { sek, forLangt:true } | null }, overCap:antal }.
function travelSecondsForPairs_(par, maxNya) {
  const ut = {}, saknas = [], sett = {};
  (par || []).forEach(p => {
    if (!p || !platsGeokodad(p.a) || !platsGeokodad(p.b)) return;
    const key = cachenyckel(p.a, p.b);
    if (sett[key]) return;
    sett[key] = true;
    const hit = cacheGetJson('restid:' + key);
    if (hit && typeof hit.sek === 'number') ut[key] = hit.sek; else saknas.push({ key, a: p.a, b: p.b });
  });
  if (!saknas.length) return { svar: ut, overCap: 0 };

  const fil = readCacheFileSafe();
  const attAnropa = [];
  saknas.forEach(s => {
    const post = fil && fil.restid ? fil.restid[s.key] : null;
    if (post && typeof post.sek === 'number') { ut[s.key] = post.sek; cachePutJson('restid:' + s.key, { sek: post.sek }, AVAIL_CACHE_TTL_RESTID_S); return; }
    // Samma plats i båda ändar (två möten på samma adress, eller bokarens adress = ett ankare) → 0 s utan anrop. Version 7 (K3):
    // 0 s blir 0 min UTAN marginal i buildTravelTable/previewResor – ingen resa sker, så ingen marginal behövs.
    if (platsnyckel(s.a) === platsnyckel(s.b)) { ut[s.key] = 0; cachePutJson('restid:' + s.key, { sek: 0 }, AVAIL_CACHE_TTL_RESTID_S); return; }
    const km = haversineKm(s.a, s.b);
    if (km > AVAIL_FAGELVAG_MAX_KM) { ut[s.key] = { sek: Math.round(km / AVAIL_FAGELVAG_KMH * 3600), forLangt: true }; return; }   // "för långt" utan anrop
    attAnropa.push(s);
  });
  if (!attAnropa.length) return { svar: ut, overCap: 0 };

  const nya = {};
  const gransNya = typeof maxNya === 'number' && maxNya >= 0 ? maxNya : AVAIL_MATRIX_MAX_PER_FRAGA;
  const batchLista = attAnropa.slice(0, gransNya);
  const overCap = attAnropa.length - batchLista.length;
  // Gruppera per origin: punkten som förekommer i flest par (vid lika: a) – kedjor runt bas/ett nav blir få anrop.
  const frekvens = {};
  batchLista.forEach(s => { [platsnyckel(s.a), platsnyckel(s.b)].forEach(k => { frekvens[k] = (frekvens[k] || 0) + 1; }); });
  const grupper = {}, ordning = [];
  batchLista.forEach(s => {
    const ka = platsnyckel(s.a), kb = platsnyckel(s.b);
    const origin = frekvens[kb] > frekvens[ka] ? s.b : s.a, dest = origin === s.b ? s.a : s.b, ko = platsnyckel(origin);
    if (!grupper[ko]) { grupper[ko] = { origin, lista: [] }; ordning.push(ko); }
    grupper[ko].lista.push({ key: s.key, p: dest });
  });
  let stopp = false;
  ordning.forEach(ko => {
    if (stopp) return;
    const g = grupper[ko];
    for (let i = 0; i < g.lista.length && !stopp; i += AVAIL_MATRIX_BATCH) {
      const batch = g.lista.slice(i, i + AVAIL_MATRIX_BATCH);
      if (!mapsKanAnropa(batch.length)) { stopp = true; break; }
      const svar = distanceBatch(g.origin, batch.map(b => b.p));
      if (!svar) { stopp = true; break; }
      batch.forEach((b, j) => {
        const sek = svar[j];
        if (typeof sek === 'number') {
          ut[b.key] = sek; nya[b.key] = sek;
          cachePutJson('restid:' + b.key, { sek }, AVAIL_CACHE_TTL_RESTID_S);
        }
      });
    }
  });
  attAnropa.forEach(s => { if (ut[s.key] === undefined) ut[s.key] = null; });
  // Nya par → cache-filen samlat (AVAIL_RESTID_PENDING, skrivs av availFlushGeokod_ i slutet av körningen – version 7) + körningens fil-memo,
  // så att ett andra anrop i samma körning (findSlot under låset) inte ser paret som saknat.
  if (Object.keys(nya).length) {
    const ts = availNowIso();
    Object.keys(nya).forEach(k => {
      const post = { sek: nya[k], ts };
      AVAIL_RESTID_PENDING[k] = post;
      if (AVAIL_FIL_MEMO && AVAIL_FIL_MEMO.restid && typeof AVAIL_FIL_MEMO.restid === 'object') AVAIL_FIL_MEMO.restid[k] = post;
    });
  }
  return { svar: ut, overCap };
}
// Ett Distance Matrix-anrop: mode=driving, statisk duration (utan departure_time), units=metric, region=se, language=sv.
// Returnerar array (sek | null per destination) eller null vid toppnivåfel/undantag. Elementen räknas mot dagstaket oavsett utfall.
function distanceBatch(origin, destinations) {
  const url = 'https://maps.googleapis.com/maps/api/distancematrix/json?origins=' + encodeURIComponent(origin.lat + ',' + origin.lng) +
    '&destinations=' + encodeURIComponent(destinations.map(d => d.lat + ',' + d.lng).join('|')) +
    '&mode=driving&units=metric&region=se&language=sv&key=' + encodeURIComponent(mapsApiKey());
  let json = null;
  try {
    addMapsElements(destinations.length);
    const res = UrlFetchApp.fetch(url, { muteHttpExceptions: true, followRedirects: true });
    json = JSON.parse(res.getContentText());
  } catch (e) { return null; }
  if (!json || mapsHanteraToppstatus(json.status, json.error_message)) return null;
  const rad = json.rows && json.rows[0] && Array.isArray(json.rows[0].elements) ? json.rows[0].elements : [];
  return destinations.map((d, i) => {
    const el = rad[i];
    if (!el || el.status !== 'OK' || !el.duration || typeof el.duration.value !== 'number') return null;   // ZERO_RESULTS/NOT_FOUND → schablon
    return el.duration.value;
  });
}
// Enskilt par med marginal: travelMinutes(a, b, restidCfg) → { min, kalla:'maps'|'forLangt'|'schablon' }.
// a/b = { lat, lng, geokodad }; restidCfg = mapCfg(inst).restid (utelämnas → defaults ur DEFAULT_BOKNINGSINSTALLNINGAR-värdena).
function travelMinutes(a, b, restidCfg) {
  const rc = restidCfg || mapCfg({}).restid;
  if (!platsGeokodad(a) || !platsGeokodad(b)) return { min: rc.schablonMin, kalla: 'schablon' };
  const T = buildTravelTable(a, [b], { restid: rc }, travelSecondsFor);
  return T(b);
}

// =====================================================================================
// 3. Ingång från Code.gs (handleAvailability / findSlot):
//    computeAvailability({ bokare, config, typ, motestypId, adress, from, to, reservationId, undantaBokningId, farsk, intern, inbox? })
//    → data enligt 5.12. intern:true behåller slot.restidMin { fore, efter, kalla } för inkorgspostens restid (restidFromSlot).
//    inbox (valfri) = redan läst inkorg (book under låset) – vidarebefordras till buildBusyList så att filen läses en gång.
//    Fel kastas som Error med .code/.details (E_VALIDATION, E_RATE, E_CALENDAR, E_SETUP) – route() gör kuvertet.
//    Code.gs har redan gjort E_KEY, anropsgränser, honoredUndanta, resolveMotestyp, checkAdressLimits och egen-reservation.
// =====================================================================================
function computeAvailability(req) {
  const bokare = req.bokare, config = req.config;
  const deps = {
    config, bokare, typ: req.typ || null, now: new Date(),
    undantaHonorerad: !!req.undantaBokningId,
    buildBusy: (from, to) => buildBusyList(from, to, {
      config, bokareId: bokare.id, reservationId: req.reservationId || '', undantaBokningId: req.undantaBokningId || '', farsk: !!req.farsk,
      inbox: req.inbox || null
    }),
    geocode: adress => geocodeAddress(adress),
    travelSek: (X, platser) => travelSecondsFor(X, platser),
    findBokning: null
  };
  const r = computeAvailabilityCore(req, deps);
  if (!r.ok) throw availThrow(r.error);
  return req.intern ? r.data : stripInternAvailability(r.data);
}

// =====================================================================================
// 4. Enhetstest – spec 5.14 med fasta BusyItem-listor (ingen kalender, inga Maps-anrop). Körs i Apps Script (Logger) eller Node.
// =====================================================================================
function runAvailabilityTests() {
  const fel = []; let antal = 0;
  const ok = (villkor, text) => { antal++; if (!villkor) fel.push(text); };

  // Förutsättningar (5.14): arbetstid 08–17, lunch 12–13, raster 30, "Timpunkts Möte" 60+30 restid, bas geokodad, max 3 fysiska, max 90 min, schablon 45.
  const BAS = { lat: 59.3293, lng: 18.0686 }, X = { lat: 59.3000, lng: 18.0000 }, A = { lat: 59.4000, lng: 18.1000 }, B = { lat: 59.2000, lng: 17.9000 };
  const inst = () => ({ arbetstider: { '1': { start: '08:00', slut: '17:00' }, '2': { start: '08:00', slut: '17:00' }, '3': { start: '08:00', slut: '17:00' }, '4': { start: '08:00', slut: '17:00' }, '5': { start: '08:00', slut: '17:00' }, '6': null, '0': null },
    lunch: { start: '12:00', slut: '13:00' }, basadress: 'Bas', basLat: BAS.lat, basLng: BAS.lng, restidTillForsta: true, restidEfterSista: true,
    framforhallningFysiskDagar: 2, framforhallningTeamsDagar: 1, horisontVeckor: 6, startintervallMin: 30, maxFysiskaPerDag: 3, maxEnkelResaMin: 90,
    schablonRestidMin: 45, marginalMinstMin: 15, marginalProcent: 25, rodaDagar: true, rodaDagarExtra: [], rodaDagarUndantag: [], paus: { aktiv: false, tom: '', meddelande: '' } });
  const MOTE = { id: 'mt_mote', titel: 'Timpunkts Möte', langdMin: 60, cooldownMin: 30, restid: true, pipelineId: 'p1', global: false, aktiv: true };
  const TEAMS = { id: 'mt_teams', titel: 'Timpunkt Teams', langdMin: 60, cooldownMin: 0, restid: false, pipelineId: 'p1', global: false, aktiv: true };
  const ANNA = { id: 'bokare_anna', pipelineId: 'p1', tillatnaMotestypIds: [], aktiv: true, arCj: false };
  const BO = { id: 'bokare_bo', pipelineId: 'p1', tillatnaMotestypIds: [], aktiv: true, arCj: false };
  const NOW = new Date('2026-09-14T16:00:00+02:00');   // måndag
  // Busy-hjälpare (ISO-form; Calendar.gs-formen med datum/startMin/slutMin testas separat)
  const bi = (datum, s, e, o) => Object.assign({ id: 'b_' + datum + s, kalla: 'privat', start: toIsoWithOffset(datum, s), slut: toIsoWithOffset(datum, e),
    hasPlace: false, plats: null, isTravelMeeting: false, cooldownMin: 0, heldag: false, ignore: false, preliminar: false }, o || {});
  const med = (plats, o) => Object.assign({ hasPlace: true, plats: { text: 'x', lat: plats.lat, lng: plats.lng, geokodad: true }, isTravelMeeting: true }, o || {});
  // Restidsstub: sekunder valda så att marginalen ger testfallens minuter (40, 30, 50, 95)
  const sekTabell = {};
  const sattSek = (a, b, sek) => { sekTabell[cachenyckel(a, b)] = sek; };
  sattSek(X, A, 1500); sattSek(X, B, 900); sattSek(X, BAS, 2100);
  let travelAnrop = 0;
  const travelSek = (x, platser) => { travelAnrop++; const ut = {}; platser.forEach(p => { ut[cachenyckel(x, p)] = sekTabell[cachenyckel(x, p)] !== undefined ? sekTabell[cachenyckel(x, p)] : null; }); return ut; };
  const geoOk = () => ({ status: 'ok', lat: X.lat, lng: X.lng, formaterad: 'X' });
  const kor = (req, busy, o) => computeAvailabilityCore(Object.assign({ motestypId: 'mt_mote', adress: 'X', from: '2026-09-22', to: '2026-09-22' }, req),
    Object.assign({ config: { installningar: (o && o.inst) || inst(), motestyper: [MOTE, TEAMS] }, bokare: ANNA, now: NOW, busy, geocode: geoOk, travelSek, findBokning: () => null }, o || {}));
  const slot = (r, tid, dag) => (r.data.dagar[dag || 0].slots.find(s => s.tid === tid) || {});
  const upptagetBlock = (r, i) => r.data.dagar[i || 0].block.find(b => b.typ === 'upptaget') || {};
  const pausBlock = (r, i) => r.data.dagar[i || 0].block.find(b => b.typ === 'paus') || {};

  // Marginal (5.8)
  ok(travelWithMargin(32 * 60, mapCfg(inst()).restid) === 50, 'marginal 32 → 50');
  ok(travelWithMargin(80 * 60, mapCfg(inst()).restid) === 100, 'marginal 80 → 100');
  ok(travelWithMargin(1500, mapCfg(inst()).restid) === 40 && travelWithMargin(900, mapCfg(inst()).restid) === 30 && travelWithMargin(2100, mapCfg(inst()).restid) === 50, 'stubbens sekunder → 40/30/50');

  // placeTravel-exemplet (5.6): A slutar 09:00 (+30), Teams 11:00–11:45, S=12:00, 40 min → 10:20–11:00
  const pt = placeTravel(9 * 60 + 30, 12 * 60, [[11 * 60, 11 * 60 + 45]], 40, 'in');
  ok(pt && pt[0] === 10 * 60 + 20 && pt[1] === 11 * 60, 'placeTravel hoppar över Teams');

  // 1. Teams mellan två fysiska (tis 22/9)
  let busy = [bi('2026-09-22', '08:00', '09:00', med(A)), bi('2026-09-22', '11:00', '11:45'), bi('2026-09-22', '15:00', '16:00', med(B))];
  let r = kor({}, busy);
  ok(r.ok, 'test1 ok');
  ok(slot(r, '12:00').status === 'utanfor' && slot(r, '12:00').reason === 'lunch', 'test1 12:00 lunch');
  ok(slot(r, '13:00').status === 'ledig' && slot(r, '13:00').restid.inBlock[0] === '12:20' && slot(r, '13:00').restid.utBlock[1] === '15:00', 'test1 13:00 ledig 12:20–13:00 / 14:30–15:00');
  ok(slot(r, '13:00').restidMin.fore === 40 && slot(r, '13:00').restidMin.efter === 30 && slot(r, '13:00').restidMin.kalla === 'ok', 'test1 restidMin råa minuter');
  ok(slot(r, '10:00').status === 'upptaget', 'test1 10:00 upptaget (cooldown mot Teams)');
  ok(slot(r, '09:30').status === 'restid' && slot(r, '09:30').reason === 'restidIn', 'test1 09:30 restidIn');
  ok(r.data.dagar[0].fysiska === 2 && r.data.dagar[0].block.length === 4, 'test1 fysiska=2, 3 block + lunch');
  ok(r.data.dagar[0].block.every(b => !('plats' in b) && !('kalla' in b) && !('titel' in b)), 'test1 block läcker inget');

  // 1b. Ankare med bara platstext (privat kalender/ICS) geokodas via deps.geocode → Maps-restid, inte schablon
  let geoAnrop = [];
  const geoTextOk = adress => { geoAnrop.push(adress); if (adress === 'X') return geoOk(); if (adress === 'Storgatan 9') return { status: 'ok', lat: A.lat, lng: A.lng, formaterad: 'A' }; return { status: 'okand' }; };
  const textAnkare = bi('2026-09-22', '08:00', '09:00', { hasPlace: true, isTravelMeeting: true, plats: { text: 'Storgatan 9', lat: null, lng: null, geokodad: false } });
  r = kor({}, [textAnkare, Object.assign({}, textAnkare, { id: 'b2', start: toIsoWithOffset('2026-09-22', '15:00'), slut: toIsoWithOffset('2026-09-22', '16:00') })], { geocode: geoTextOk });
  ok(r.ok && geoAnrop.filter(a => a === 'Storgatan 9').length === 1 && slot(r, '10:00').status === 'ledig' && slot(r, '10:00').restidOkand === false && slot(r, '10:00').restid.inBlock[0] === '09:20', 'test1b textankare geokodas en gång → Maps-restid A→X 40 (09:20–10:00)');
  ok(textAnkare.plats.lat === null, 'test1b indata muteras inte');
  r = kor({}, [textAnkare], { geocode: a => (a === 'X' ? geoOk() : { status: 'okand' }) });
  ok(r.ok && slot(r, '10:00').status === 'ledig' && slot(r, '10:00').restidOkand === true && slot(r, '10:00').restidMin.kalla === 'schablon', 'test1b misslyckad ankargeokodning → ankare med schablon');

  // 2. Adress ej tolkad → schablon, inga Matrix-anrop
  travelAnrop = 0;
  r = kor({}, [bi('2026-09-22', '08:00', '09:00', med(A))], { geocode: () => ({ status: 'okand' }) });
  ok(r.ok && r.data.geo.status === 'okand' && r.data.restidOkand === true && travelAnrop === 0, 'test2 okand utan Matrix-anrop');
  ok(slot(r, '10:00').status === 'ledig' && slot(r, '10:00').restidOkand === true && slot(r, '10:00').restid.inBlock[0] === '09:15' && slot(r, '10:00').restidMin.kalla === 'schablon', 'test2 schablon 45 (09:15–10:00)');

  // 3. Dagsgräns: tre ankare → dold/maxFysiska; Teams → ledig mellan hindren
  busy = [bi('2026-09-23', '08:00', '09:00', med(A)), bi('2026-09-23', '10:00', '11:00', med(B)), bi('2026-09-23', '15:00', '16:00', med(A))];
  r = kor({ from: '2026-09-23', to: '2026-09-23' }, busy);
  ok(slot(r, '13:00').status === 'dold' && slot(r, '13:00').reason === 'maxFysiska', 'test3 dold/maxFysiska');
  r = kor({ from: '2026-09-23', to: '2026-09-23', motestypId: 'mt_teams' }, busy);
  ok(slot(r, '13:00').status === 'ledig' && slot(r, '13:00').restid === undefined, 'test3 Teams ledig');

  // 4. Lunchgräns (tom dag)
  r = kor({}, []);
  ok(slot(r, '11:00').status === 'ledig' && slot(r, '11:30').reason === 'lunch' && slot(r, '13:00').status === 'ledig', 'test4 lunchgräns');

  // 5. Max enkel restid: bas→X 95
  sattSek(X, BAS, 4560);
  r = kor({}, []);
  ok(r.data.dagar[0].slots.every(s => (s.status === 'dold' && s.reason === 'maxRestid') || s.reason === 'lunch'), 'test5 alla dold/maxRestid');
  sattSek(X, A, 2100);
  r = kor({}, [bi('2026-09-22', '08:00', '09:00', med(A))]);
  ok(slot(r, '10:30').status === 'dold' && slot(r, '10:30').reason === 'maxRestid', 'test5 10:30 dold (utresa mot bas 95)');
  const inst5 = inst(); inst5.restidEfterSista = false;
  r = kor({}, [bi('2026-09-22', '08:00', '09:00', med(A))], { inst: inst5 });
  ok(slot(r, '10:30').status === 'ledig' && slot(r, '10:30').restidMin.efter === 0, 'test5 restidEfterSista=false → ledig');
  sattSek(X, BAS, 2100); sattSek(X, A, 1500);

  // 6. Första mötet mot bas (bas→X 50)
  r = kor({}, []);
  ok(slot(r, '08:00').reason === 'restidIn' && slot(r, '08:30').reason === 'restidIn', 'test6 08:00/08:30 restidIn');
  ok(slot(r, '09:00').status === 'ledig' && slot(r, '09:00').restid.inBlock[0] === '08:10', 'test6 09:00 ledig 08:10–09:00');
  ok(slot(r, '16:00').status === 'restid' && slot(r, '16:00').reason === 'restidUt', 'test6 16:00 restidUt');

  // 8. Reservation: Annas reservation tor 24/9 med X1 = A. Bo ser upptaget; Anna med reservationId ser ledig.
  const res = bi('2026-09-24', '10:00', '11:00', med(A, { id: 'rs_1', kalla: 'reservation', bokareId: 'bokare_anna', cooldownMin: 30 }));
  r = kor({ from: '2026-09-24', to: '2026-09-24' }, [res], { bokare: BO });
  ok(slot(r, '10:00').status === 'upptaget' && upptagetBlock(r).egen === false && upptagetBlock(r).slut === '11:00', 'test8 Bo ser upptaget (mötets egen tid), ej egen');
  // K1 (version 7): cooldown som eget paus-block direkt efter mötet – samma egen-regel, aldrig omrade; sorterat på start; hindret oförändrat
  ok(pausBlock(r).start === '11:00' && pausBlock(r).slut === '11:30' && pausBlock(r).egen === false && !('omrade' in pausBlock(r)) && !('kundnamn' in pausBlock(r)), 'test8 paus-block 11:00–11:30 efter upptaget, ej egen, utan omrade');
  ok(r.data.dagar[0].block.length === 3 && r.data.dagar[0].block.map(b => b.typ).join(',') === 'upptaget,paus,lunch' && slot(r, '11:00').status === 'upptaget', 'test8 block upptaget,paus,lunch i startordning; 11:00 fortfarande upptaget (cooldown-hinder)');
  const res1115 = Object.assign({}, res, { start: toIsoWithOffset('2026-09-24', '11:15'), slut: toIsoWithOffset('2026-09-24', '12:15') });
  r = kor({ from: '2026-09-24', to: '2026-09-24' }, [res1115], { bokare: BO });
  ok(slot(r, '09:00').status === 'ledig' && slot(r, '09:00').restid.utBlock[0] === '10:30' && slot(r, '09:00').restid.utBlock[1] === '11:10', 'test8 Bo 09:00 kräver utresa X2→X1 (10:30–11:10)');
  const res1045 = Object.assign({}, res, { start: toIsoWithOffset('2026-09-24', '10:45'), slut: toIsoWithOffset('2026-09-24', '11:45') });
  r = kor({ from: '2026-09-24', to: '2026-09-24' }, [res1045], { bokare: BO });
  ok(slot(r, '09:00').status === 'restid' && slot(r, '09:00').reason === 'restidUt', 'test8 Bo 09:00 utresa ryms inte → restidUt');
  r = kor({ from: '2026-09-24', to: '2026-09-24' }, [res], { bokare: ANNA });
  ok(upptagetBlock(r).egen === true, 'test8 Anna ser egen reservation');
  r = kor({ from: '2026-09-24', to: '2026-09-24', reservationId: 'rs_1' }, [res], { bokare: ANNA });
  ok(slot(r, '10:00').status === 'ledig', 'test8 Anna med reservationId ser ledig');
  // Calendar.gs-form: egen reservation levereras med ignore:true/egenReservation:true → varken hinder eller ankare
  const resEgen = Object.assign({}, res, { ignore: true, egenReservation: true, egen: true, datum: '2026-09-24', startMin: 600, slutMin: 660 });
  r = kor({ from: '2026-09-24', to: '2026-09-24' }, [resEgen], { bokare: ANNA });
  ok(slot(r, '10:00').status === 'ledig' && r.data.dagar[0].fysiska === 0 && r.data.dagar[0].block.length === 1, 'test8 egen reservation (Calendar.gs-form) ignoreras');

  // 9. Röd dag: fre 2027-06-25 midsommarafton, lör 26/6 helg; undantag öppnar fredagen
  const inst9 = inst(); inst9.horisontVeckor = 60;
  r = kor({ from: '2027-06-25', to: '2027-06-26' }, [], { inst: inst9 });
  ok(r.ok && r.data.dagar[0].status === 'stangd' && r.data.dagar[0].reason === 'rodDag' && r.data.dagar[1].reason === 'helg', 'test9 rodDag + helg');
  inst9.rodaDagarUndantag = ['2027-06-25'];
  r = kor({ from: '2027-06-25', to: '2027-06-25' }, [], { inst: inst9 });
  ok(r.data.dagar[0].status === 'oppen', 'test9 undantag öppnar');
  ok(swedishHolidays(2026).indexOf('2026-04-03') >= 0 && swedishHolidays(2026).indexOf('2026-05-14') >= 0 && swedishHolidays(2026).indexOf('2026-06-20') >= 0 && swedishHolidays(2026).indexOf('2026-10-31') >= 0, 'helgdagar 2026: långfredag, Kristi himmelsfärd, midsommardagen, alla helgons dag');

  // 10. Ignorerad händelse
  const tand = bi('2026-09-22', '14:00', '15:00', med(A, { ignore: true }));
  r = kor({}, [tand]);
  ok(slot(r, '14:00').status === 'ledig' && r.data.dagar[0].block.length === 1 && r.data.dagar[0].fysiska === 0, 'test10 ignorerad: inget block, inget ankare');
  r = kor({}, [bi('2026-09-22', '14:00', '15:00', med(A))]);
  ok(slot(r, '14:00').status === 'upptaget' && r.data.dagar[0].block.length === 2, 'test10 utan ignore: block + upptaget');

  // 11. Framförhållning: mån 14/9 → fysiskt ons 16/9, Teams tis 15/9; tis röd → tor 17/9 resp. ons 16/9
  ok(firstBookableDay(mapCfg(inst()), MOTE, '2026-09-14') === '2026-09-16' && firstBookableDay(mapCfg(inst()), TEAMS, '2026-09-14') === '2026-09-15', 'test11 framförhållning');
  const inst11 = inst(); inst11.rodaDagarExtra = ['2026-09-15'];
  ok(firstBookableDay(mapCfg(inst11), MOTE, '2026-09-14') === '2026-09-17' && firstBookableDay(mapCfg(inst11), TEAMS, '2026-09-14') === '2026-09-16', 'test11 med röd tisdag');
  r = kor({ from: '2026-09-14', to: '2026-09-16' }, []);
  ok(r.data.dagar[0].status === 'forTidigt' && r.data.dagar[1].status === 'forTidigt' && r.data.dagar[2].status === 'oppen' && r.data.forstaBokningsbaraDag === '2026-09-16', 'test11 dagsstatus');

  // 12. Sommartid: sön 25/10 stängd; mån 26/10 ankare 09–10 (+01:00), slots utan förskjutning
  r = kor({ from: '2026-10-25', to: '2026-10-26' }, [bi('2026-10-26', '09:00', '10:00', med(A))]);
  ok(r.data.dagar[0].reason === 'helg' && upptagetBlock(r, 1).start === '09:00' && slot(r, '10:00', 1).start === '2026-10-26T10:00:00+01:00' && slot(r, '16:00', 1).tid === '16:00', 'test12 sommartid');
  ok(toIsoWithOffset('2026-10-24', '10:00') === '2026-10-24T10:00:00+02:00', 'test12 offset före omställning');

  // 13. Ombokning undantar egen händelse
  const egen = bi('2026-09-22', '14:00', '15:00', med(A, { id: 'bk_bk1', kalla: 'bokningar', bokningId: 'bk1', bokareId: 'bokare_anna', kundnamn: 'Firma AB', cooldownMin: 30 }));
  r = kor({ undantaBokningId: 'bk1' }, [egen], { findBokning: id => id === 'bk1' ? { bokareId: 'bokare_anna', motestypId: 'mt_mote' } : null });
  ok(slot(r, '14:00').status === 'ledig', 'test13 undantagen → ledig');
  r = kor({}, [egen]);
  ok(slot(r, '14:00').status === 'upptaget' && upptagetBlock(r).egen === true && upptagetBlock(r).kundnamn === 'Firma AB' && upptagetBlock(r).slut === '15:00', 'test13 utan undantag → upptaget, egen med kundnamn, block = mötets tid');
  ok(pausBlock(r).start === '15:00' && pausBlock(r).slut === '15:30' && pausBlock(r).egen === true && pausBlock(r).kundnamn === 'Firma AB' && pausBlock(r).bokningId === 'bk1', 'test13 paus-block 15:00–15:30 egen med kundnamn/bokningId (K1)');
  r = kor({ undantaBokningId: 'bk1' }, [egen], { bokare: BO, findBokning: () => ({ bokareId: 'bokare_anna', motestypId: 'mt_mote' }) });
  ok(slot(r, '14:00').status === 'upptaget' && upptagetBlock(r).egen === false && !('kundnamn' in upptagetBlock(r)), 'test13 annan bokare: ignoreras tyst, inget kundnamn');
  // inaktiv typ accepteras vid ombokning av egen bokning
  const INAKTIV = Object.assign({}, MOTE, { id: 'mt_gammal', aktiv: false });
  r = computeAvailabilityCore({ motestypId: 'mt_gammal', adress: 'X', from: '2026-09-22', to: '2026-09-22', undantaBokningId: 'bk1' },
    { config: { installningar: inst(), motestyper: [MOTE, INAKTIV] }, bokare: ANNA, now: NOW, busy: [egen], geocode: geoOk, travelSek, findBokning: () => ({ bokareId: 'bokare_anna', motestypId: 'mt_gammal' }) });
  ok(r.ok, 'test13 inaktiv typ accepteras vid ombokning');
  r = computeAvailabilityCore({ motestypId: 'mt_gammal', adress: 'X', from: '2026-09-22', to: '2026-09-22' },
    { config: { installningar: inst(), motestyper: [MOTE, INAKTIV] }, bokare: ANNA, now: NOW, busy: [], geocode: geoOk, travelSek, findBokning: () => null });
  ok(!r.ok && r.error.code === 'E_VALIDATION', 'test13 inaktiv typ annars E_VALIDATION');
  // Code.gs-vägen: typ redan uppslagen (deps.typ) + undantaHonorerad
  r = kor({ undantaBokningId: 'bk1' }, [egen], { typ: INAKTIV, undantaHonorerad: true });
  ok(r.ok && slot(r, '14:00').status === 'ledig', 'test13 deps.typ + undantaHonorerad');

  // 14. Paus per dag
  const inst14 = inst(); inst14.paus = { aktiv: true, tom: '2026-09-25', meddelande: 'Semester' };
  r = kor({ from: '2026-09-24', to: '2026-09-28' }, [], { inst: inst14 });
  ok(r.data.dagar[0].status === 'paus' && r.data.dagar[1].status === 'paus' && r.data.dagar[4].status === 'oppen' && r.data.paus.meddelande === 'Semester', 'test14 paus t.o.m. 25/9');

  // Kantfall: händelse över midnatt delas per dag; heldag stänger dagen; Calendar.gs-segment med datum/startMin/slutMin
  r = kor({ from: '2026-09-22', to: '2026-09-23' }, [bi('2026-09-22', '16:00', '16:30', { slut: toIsoWithOffset('2026-09-23', '08:30') })]);
  ok(upptagetBlock(r, 0).start === '16:00' && upptagetBlock(r, 0).slut === '24:00' && upptagetBlock(r, 1).start === '00:00' && upptagetBlock(r, 1).slut === '08:30' && slot(r, '08:00', 1).status === 'upptaget', 'kantfall midnatt');
  r = kor({}, [{ id: 'h', kalla: 'privat', start: '2026-09-22', slut: '2026-09-23', heldag: true, hasPlace: false, isTravelMeeting: false, ignore: false }]);
  ok(r.data.dagar[0].status === 'stangd' && r.data.dagar[0].reason === 'heldag', 'kantfall heldag');
  r = kor({}, [{ id: 's', kalla: 'privat', datum: '2026-09-22', startMin: 540, slutMin: 600, start: toIsoWithOffset('2026-09-22', '09:00'), slut: toIsoWithOffset('2026-09-22', '10:00'), hasPlace: true, plats: { lat: A.lat, lng: A.lng, geokodad: true }, isTravelMeeting: true, cooldownMin: 0, heldag: false, ignore: false }]);
  ok(slot(r, '09:00').status === 'upptaget' && r.data.dagar[0].fysiska === 1 && slot(r, '11:00').status === 'ledig' && slot(r, '11:00').restid.inBlock[0] === '10:20', 'kantfall Calendar.gs-segment (startMin/slutMin)');
  // Validering: intervall > 14 dagar, okänd typ
  ok(!kor({ from: '2026-09-22', to: '2026-10-10' }, []).ok, 'validering > 14 dagar');
  ok(kor({ motestypId: 'finns_ej' }, []).error.code === 'E_VALIDATION', 'validering okänd typ');
  // Kalenderfel → E_CALENDAR; fel med kod bevaras
  ok(kor({}, undefined, { buildBusy: () => { throw new Error('boom'); } }).error.code === 'E_CALENDAR', 'kalenderfel → E_CALENDAR');
  ok(kor({}, undefined, { buildBusy: () => { const e = new Error('x'); e.code = 'E_SETUP'; throw e; } }).error.code === 'E_SETUP', 'fel med kod bevaras');
  // Export läcker inga råa restidsminuter
  const exp = stripInternAvailability(kor({}, []).data);
  ok(exp.dagar[0].slots.every(s => !('restidMin' in s)) && exp.dagar[0].slots.some(s => s.restid), 'export utan restidMin men med restid-block');

  // K3 (version 7): samma koordinater = 0 min utan marginal. Ankare på X:s koordinater 08:00–09:00 (+30 cooldown) → första lediga
  // lucka 09:30 direkt efter mötet + cooldown, utan inresa (inBlock utelämnas, restidMin.fore 0, kalla 'ok'); utresan mot bas som förut.
  sattSek(X, X, 0);
  r = kor({}, [bi('2026-09-22', '08:00', '09:00', med(X, { cooldownMin: 30 }))]);
  ok(slot(r, '09:00').status === 'upptaget' && slot(r, '09:30').status === 'ledig' && slot(r, '09:30').restidMin.fore === 0 && slot(r, '09:30').restidMin.kalla === 'ok' && !('inBlock' in slot(r, '09:30').restid) && slot(r, '09:30').restid.utBlock[0] === '11:00', 'K3 samma koordinater → 09:30 ledig utan inresa (0 min), utresa mot bas 11:00');
  ok(buildTravelTable(X, [X], mapCfg(inst()), () => ({ [cachenyckel(X, X)]: 0 }))(X).min === 0, 'K3 buildTravelTable 0 s → 0 min utan marginal');
  // K3 i previewResor: två ankare på samma koordinater → benet mellan dem utelämnas; bas-benen (50 min) finns kvar.
  const segX = (id, s, e) => ({ id, kalla: 'privat', datum: '2026-09-22', startMin: s, slutMin: e, plats: { text: 'x', lat: X.lat, lng: X.lng, geokodad: true }, hasPlace: true, isTravelMeeting: true, cooldownMin: 0, heldag: false, ignore: false });
  const pr = previewResor([segX('p1', 540, 600), segX('p2', 660, 720)], mapCfg(inst()), par => { const ut = {}; par.forEach(p => { ut[cachenyckel(p.a, p.b)] = sekTabell[cachenyckel(p.a, p.b)] !== undefined ? sekTabell[cachenyckel(p.a, p.b)] : null; }); return { svar: ut, overCap: 0 }; });
  ok(pr.resor.length === 2 && pr.resor[0].franId === 'bas' && pr.resor[0].tillId === 'p1' && pr.resor[0].minuter === 50 && pr.resor[1].franId === 'p2' && pr.resor[1].tillId === 'bas' && !pr.resor.some(x => x.franId === 'p1'), 'K3 previewResor utelämnar 0-benet p1→p2, bas-benen kvar');

  const rapport = fel.length ? `${fel.length} av ${antal} test misslyckades:\n- ${fel.join('\n- ')}` : `Alla ${antal} test OK`;
  if (typeof Logger !== 'undefined') Logger.log(rapport); else console.log(rapport);
  return { antal, fel };
}

// =====================================================================================
// Node: tidshjälpen ligger i Code.gs (Apps Script) – här definieras Intl-versionen från index.html (spec 3.4) bara när
// filen laddas ensam (typeof module !== 'undefined' är alltid false i Apps Script V8).
// =====================================================================================
if (typeof module !== 'undefined' && module.exports) {
  const g = globalThis;
  if (typeof g.tzParts !== 'function') {
    g.APP_TZ = 'Europe/Stockholm';
    g.tzParts = function (d) {
      const p = {};
      new Intl.DateTimeFormat('sv-SE', { timeZone: g.APP_TZ, year:'numeric', month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit', hourCycle:'h23' })
        .formatToParts(d).forEach(x => { p[x.type] = x.value; });
      return { datum: `${p.year}-${p.month}-${p.day}`, tid: `${p.hour}:${p.minute}` };
    };
    g.todayStr = function () { return tzParts(new Date()).datum; };
    g.addDays = function (dateStr, n) { const d = new Date(dateStr + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
    g.weekdayOf = function (dateStr) { return new Date(dateStr + 'T12:00:00Z').getUTCDay(); };
    g.tzOffsetMinutes = function (dateStr, tid) {
      const guess = new Date(`${dateStr}T${tid}:00Z`);
      const p = tzParts(guess);
      const asUtc = Date.UTC(+p.datum.slice(0,4), +p.datum.slice(5,7)-1, +p.datum.slice(8,10), +p.tid.slice(0,2), +p.tid.slice(3,5));
      return Math.round((asUtc - guess.getTime()) / 60000);
    };
    g.toIsoWithOffset = function (dateStr, tid) {
      const off = tzOffsetMinutes(dateStr, tid), s = off < 0 ? '-' : '+', a = Math.abs(off);
      return `${dateStr}T${tid}:00${s}${String(Math.floor(a/60)).padStart(2,'0')}:${String(a%60).padStart(2,'0')}`;
    };
    g.fromIso = function (iso) { return tzParts(new Date(iso)); };
  }
  module.exports = { mapCfg, swedishHolidays, easterSunday, isRedDay, isWorkingDay, firstBookableDay, dayStatus, travelWithMargin, placeTravel,
    availBusyForDay, platsnyckel, cachenyckel, buildTravelTable, dayPlan, computeAvailabilityCore, stripInternAvailability,
    normalizeAdressKey, runAvailabilityTests, geokodaAnkare, previewResor, platsOmrade, omradeFranComponents_ };
}
