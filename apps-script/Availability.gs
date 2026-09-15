// =====================================================================================
// Availability.gs — Tillgänglighet och restid för bokningsmodulen (spec 5.1–5.13, 4.5, A2, A5, A10–A12)
//
// Uppbyggnad (uppifrån och ned):
//   1. Rena funktioner utan Google-tjänster: mapCfg, swedishHolidays, isRedDay, firstBookableDay, dayStatus,
//      travelWithMargin, placeTravel, availBusyForDay, buildTravelTable, dayPlan, computeAvailabilityCore.
//      Alla tar busy-lista, cfg och travel-/geokodningsfunktioner som parametrar (injektion) och körs i Node
//      (module.exports längst ned) – testfallen i spec 5.14 finns i runAvailabilityTests().
//   2. Wrappers mot Google-tjänster: CacheService, Script Properties (via Code.gs), Drive-cachefilen, Geocoding API,
//      Distance Matrix. Isolerade så att de rena funktionerna aldrig rör dem.
//   3. Ingångar som Code.gs anropar: computeAvailability(req) (kastar ApiError-kompatibla fel), geocodeAddress(adress),
//      travelMinutes(a, b, restidCfg), readIcsReserv()/writeIcsReserv(obj) (Calendar.gs), swedishHolidays(year).
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
const AVAIL_CACHE_TTL_RESTID_S = 21600;        // CacheService-max 6 h (spec 5.8: TTL 6 h)
const AVAIL_CACHE_TTL_GEO_OK_S = 21600;
const AVAIL_CACHE_TTL_GEO_OKAND_S = 3600;      // ej tolkad adress: kort cache så upprepade anrop inte kostar
const AVAIL_MAPS_BLOCK_S = 60;                 // OVER_QUERY_LIMIT → inga nya Maps-anrop i 60 s (CacheService maps:block)
const AVAIL_MAPS_VARNING_S = 21600;            // maps:varning (ping läser den ur CacheService; 6 h är CacheService-max, spec säger 24 h)
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
function buildTravelTable(X, platser, cfg, travelSekFn) {
  const schablon = { min: cfg.restid.schablonMin, kalla: 'schablon' };
  const tabell = {};
  if (platsGeokodad(X) && platser.length && typeof travelSekFn === 'function') {
    const svar = travelSekFn(X, platser) || {};
    platser.forEach(p => {
      const v = svar[cachenyckel(X, p)];
      if (typeof v === 'number' && isFinite(v) && v >= 0) tabell[platsnyckel(p)] = { min: travelWithMargin(v, cfg.restid), kalla: 'maps' };
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
          slot.restid = { inBlock: [minToHhmm(inBlock[0]), minToHhmm(inBlock[1])], utBlock: [minToHhmm(utBlock[0]), minToHhmm(utBlock[1])] };
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
// Block för rendering: möte + cooldown sammanslaget; aldrig titel, adress eller källa (spec 5.12).
// egen:true + kundnamn/bokningId bara för anropande bokarens egna bokningar/reservation.
function blockFor(aktiva, at, bokareId) {
  const block = aktiva.map(b => {
    const o = { typ: 'upptaget', start: minToHhmm(b._s), slut: minToHhmm(Math.min(1440, b._e + (b.cooldownMin || 0))), egen: false };
    const egenKalla = b.kalla === 'bokningar' || b.kalla === 'reservation';
    if (egenKalla && (b.egen === true || (!!bokareId && b.bokareId === bokareId))) {
      o.egen = true;
      if (b.kundnamn) o.kundnamn = String(b.kundnamn);
      if (b.bokningId) o.bokningId = String(b.bokningId);
    }
    return o;
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
    // Ankare vars plats bara är text (privat Google-kalender, Bokningar utan inkorgspost, Outlook-ICS) geokodas här
    // (spec 5.2 hasPlace = platsen geokodas, 4.6 bara händelser som räknas, 5.8 par mot varje unik plats). Misslyckas
    // geokodningen förblir ankaret ett ankare med schablon (5.13). Går via samma cachekedja som bokarens adress och
    // räknar bara mot MAPS_DAILY_CAP – per-kod-gränserna gäller enbart bokarens adress (Code.gs checkAdressLimits).
    if (X && X.geokodad) busy = geokodaAnkare(busy, deps.geocode);
    T = buildTravelTable(X, X && X.geokodad ? unikaPlatser(busy, cfg) : [], cfg, deps.travelSek);
  }

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
        ? { lat: g.lat, lng: g.lng } : null;
    }
    const p = perText[text];
    if (!p) return b;
    return Object.assign({}, b, { plats: Object.assign({}, b.plats, { lat: p.lat, lng: p.lng, geokodad: true }) });
  });
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
function readCacheFileSafe() { try { return readCacheFile(); } catch (e) { return null; } }   // tillgängligheten ska aldrig falla på cachen
// Läs-ändra-skriv utan eget lås: filen är en ren cache (alla värden kan räknas om), och ett eget LockService-anrop inuti
// book/reserve (som redan håller scriptlåset) skulle riskera att släppa deras lås. En förlorad uppdatering är ofarlig.
// mutator(obj) returnerar true när något ändrats. Returnerar true om filen skrevs.
function updateCacheFile(mutator) {
  try {
    const obj = readCacheFile();
    if (!mutator(obj)) return false;
    writeCacheFile(obj);
    return true;
  } catch (e) { return false; }
}
// ICS-reserv (spec 4.1 icsReserv) – anropas av Calendar.gs (lasIcsReserv_/sparaIcsReserv_).
function readIcsReserv() { const c = readCacheFileSafe(); return c ? (c.icsReserv || null) : null; }
function writeIcsReserv(reserv) { return updateCacheFile(obj => { obj.icsReserv = reserv || null; return true; }); }

// --- Geokodning (spec 5.8) ---
// Normaliserad adressnyckel: gemener, utan skiljetecken, ett mellanslag, utan "sverige" (spec 4.1).
function normalizeAdressKey(adress) {
  return String(adress || '').toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\bsverige\b/g, ' ')
    .replace(/\s+/g, ' ').trim();
}
// geocodeAddress(adress) → { status:'ok', lat, lng, formaterad } | { status:'okand' } | { status:'saknas' }.
// Cachekedja: CacheService geo:<hash> → cache-filens geokod[nyckel] → Geocoding API (region=se, components=country:SE).
// Per-kod-gränserna (20 geokodningar/h, 20 adresser/dag) kontrolleras av Code.gs (checkAdressLimits) före anropet;
// här räknas bara dagstaket MAPS_DAILY_CAP. Kastar aldrig – fel ger 'okand' (schablon).
function geocodeAddress(adress) {
  const key = normalizeAdressKey(adress);
  if (!key) return { status: 'saknas' };
  const cacheKey = 'geo:' + sha256hex(key);
  const hit = cacheGetJson(cacheKey);
  if (hit && (hit.status === 'ok' || hit.status === 'okand')) return hit;
  const fil = readCacheFileSafe();
  const post = fil && fil.geokod ? fil.geokod[key] : null;
  if (post && post.status === 'ok' && typeof post.lat === 'number' && typeof post.lng === 'number') {
    const ut = { status: 'ok', lat: post.lat, lng: post.lng, formaterad: String(post.formaterad || '') };
    cachePutJson(cacheKey, ut, AVAIL_CACHE_TTL_GEO_OK_S);
    return ut;
  }
  if (!mapsKanAnropa(1)) return { status: 'okand' };
  const svar = geocodeViaApi(adress);
  if (svar.status === 'ok') {
    cachePutJson(cacheKey, svar, AVAIL_CACHE_TTL_GEO_OK_S);
    updateCacheFile(obj => { obj.geokod[key] = { lat: svar.lat, lng: svar.lng, formaterad: svar.formaterad, status: 'ok', ts: availNowIso() }; return true; });
  } else if (svar.status === 'okand') {
    cachePutJson(cacheKey, { status: 'okand' }, AVAIL_CACHE_TTL_GEO_OKAND_S);
  }
  // nyttAnrop:true = Geocoding-API:t anropades (Code.gs räknar MAX_GEOCODE_PER_KOD_H bara på sådana; cachas aldrig).
  return Object.assign({ nyttAnrop: true }, svar);
}
// Rent API-anrop. Räknar 1 element mot dagstaket oavsett utfall. Fel/undantag → 'okand' (ingen cache).
function geocodeViaApi(adress) {
  const url = 'https://maps.googleapis.com/maps/api/geocode/json?address=' + encodeURIComponent(String(adress).slice(0, 200)) +
    '&region=se&components=country:SE&language=sv&key=' + encodeURIComponent(mapsApiKey());
  let json = null;
  try {
    addMapsElements(1);
    const res = UrlFetchApp.fetch(url, { muteHttpExceptions: true, followRedirects: true });
    json = JSON.parse(res.getContentText());
  } catch (e) { return { status: 'okand' }; }
  if (!json || mapsHanteraToppstatus(json.status, json.error_message)) return { status: 'okand' };
  const r = json.status === 'OK' && Array.isArray(json.results) && json.results[0];
  const loc = r && r.geometry && r.geometry.location;
  if (!loc || typeof loc.lat !== 'number' || typeof loc.lng !== 'number') return { status: 'okand' };
  return { status: 'ok', lat: loc.lat, lng: loc.lng, formaterad: String(r.formatted_address || '').replace(/[<>]/g, ' ').slice(0, 200) };
}

// --- Restid via Distance Matrix (spec 5.8, A2) ---
// Cachekedja per par: CacheService (6 h) → cache-filens restid[nyckel] → Distance Matrix (batch ≤ 25, symmetriantagande).
// Returnerar { <cachenyckel>: sek | { sek, forLangt:true } | null }. null = schablon.
function travelSecondsFor(X, platser) {
  const ut = {}, saknas = [];
  platser.forEach(p => {
    const key = cachenyckel(X, p);
    if (ut[key] !== undefined) return;
    const hit = cacheGetJson('restid:' + key);
    if (hit && typeof hit.sek === 'number') ut[key] = hit.sek; else saknas.push({ key, p });
  });
  if (!saknas.length) return ut;

  const fil = readCacheFileSafe();
  const attAnropa = [];
  saknas.forEach(s => {
    const post = fil && fil.restid ? fil.restid[s.key] : null;
    if (post && typeof post.sek === 'number') { ut[s.key] = post.sek; cachePutJson('restid:' + s.key, { sek: post.sek }, AVAIL_CACHE_TTL_RESTID_S); return; }
    const km = haversineKm(X, s.p);
    if (km > AVAIL_FAGELVAG_MAX_KM) { ut[s.key] = { sek: Math.round(km / AVAIL_FAGELVAG_KMH * 3600), forLangt: true }; return; }   // "för långt" utan anrop
    attAnropa.push(s);
  });
  if (!attAnropa.length) return ut;

  const nya = {};
  const batchLista = attAnropa.slice(0, AVAIL_MATRIX_MAX_PER_FRAGA);
  for (let i = 0; i < batchLista.length; i += AVAIL_MATRIX_BATCH) {
    const batch = batchLista.slice(i, i + AVAIL_MATRIX_BATCH);
    if (!mapsKanAnropa(batch.length)) break;
    const svar = distanceBatch(X, batch.map(b => b.p));
    if (!svar) break;
    batch.forEach((b, j) => {
      const sek = svar[j];
      if (typeof sek === 'number') {
        ut[b.key] = sek; nya[b.key] = sek;
        cachePutJson('restid:' + b.key, { sek }, AVAIL_CACHE_TTL_RESTID_S);
      }
    });
  }
  attAnropa.forEach(s => { if (ut[s.key] === undefined) ut[s.key] = null; });
  if (Object.keys(nya).length) {
    const ts = availNowIso();
    updateCacheFile(obj => { Object.keys(nya).forEach(k => { obj.restid[k] = { sek: nya[k], ts }; }); return true; });
  }
  return ut;
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
//    computeAvailability({ bokare, config, typ, motestypId, adress, from, to, reservationId, undantaBokningId, farsk, intern })
//    → data enligt 5.12. intern:true behåller slot.restidMin { fore, efter, kalla } för inkorgspostens restid (restidFromSlot).
//    Fel kastas som Error med .code/.details (E_VALIDATION, E_RATE, E_CALENDAR, E_SETUP) – route() gör kuvertet.
//    Code.gs har redan gjort E_KEY, anropsgränser, honoredUndanta, resolveMotestyp, checkAdressLimits och egen-reservation.
// =====================================================================================
function computeAvailability(req) {
  const bokare = req.bokare, config = req.config;
  const deps = {
    config, bokare, typ: req.typ || null, now: new Date(),
    undantaHonorerad: !!req.undantaBokningId,
    buildBusy: (from, to) => buildBusyList(from, to, {
      config, bokareId: bokare.id, reservationId: req.reservationId || '', undantaBokningId: req.undantaBokningId || '', farsk: !!req.farsk
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
  ok(slot(r, '10:00').status === 'upptaget' && upptagetBlock(r).egen === false && upptagetBlock(r).slut === '11:30', 'test8 Bo ser upptaget (inkl. cooldown), ej egen');
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
  ok(slot(r, '14:00').status === 'upptaget' && upptagetBlock(r).egen === true && upptagetBlock(r).kundnamn === 'Firma AB' && upptagetBlock(r).slut === '15:30', 'test13 utan undantag → upptaget, egen med kundnamn, block inkl. cooldown');
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
    normalizeAdressKey, runAvailabilityTests };
}
