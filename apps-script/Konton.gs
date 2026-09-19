/**
 * Konton.gs – bokarkonton (steg 3, SCRIPT_VERSION 13)
 * Spec: "[C] Bokningsmodul - specifikation steg 3 bokarkonton.md" (avsnitt 4). Radhänvisningar "3.x/4.x" nedan avser den.
 *
 * Bokare loggar in med e-post + lösenord i stället för bokarkod (B1). Kontona ägs av SCRIPTET i den fjärde brevlådefilen
 * telexia-bokning-konton.json (4.1) – appen läser dem bara via admin-endpointen konton-list (aldrig hasharna). Bokarens roll i
 * pipelinen (pipeline, kolumn, mötestyper, aktiv) ägs fortfarande av appen (config.bokare) och slås ihop med kontot i
 * effectiveBokare_ (4.5). Konto och bokarpost delar id ('bokare_<uuid>', genererat här vid registreringen).
 *
 * Vem får registrera sig: config.domaner (tillåtelselistan, ägs av appen) – poster är en domän ('byra.se') eller en hel adress
 * ('kalle@gmail.com'); adressträff vinner över domänträff (B13, matchaLista_). Ingen träff → E_DOMAN (B4).
 *
 * Innehåll: konstanter · kontofil (läs/skriv med CacheService-kopia som inkorgen) · hemligheter (SESSION_SECRET, LOSEN_PEPPER)
 * · lösenordshash (itererad HMAC-SHA256 + salt + pepper, 4.4) · sessioner (HMAC-signerad statslös token, 4.5) · tillåtelselista
 * och effektiv bokare · validering (4.7) · missbruksskydd (4.6) · mail (4.8) · endpoints konto-registrera/konto-verifiera/
 * konto-logga-in/konto-glomt/konto-aterstall/konto-byt-losenord/konto-profil (bokare) och konton-list/konto-radera (admin, 4.3)
 * · gallring (4.9) · ping-fält · runKontoTests() (kör i redigeraren efter inklistring – loggar även hashtiden, A-S3-2).
 *
 * Säkerhet (steg 1 avsnitt 9 + steg 3 avsnitt 8): lösenord och tokens loggas aldrig och ekas aldrig i feltexter; alla svar på
 * konto-registrera/konto-glomt är identiska oavsett om kontot finns (undantag E_DOMAN, avsiktligt); mail är plain text; alla
 * fält renderas av klienterna via escapeHtml/textContent.
 */

// ============================================================
// Konstanter (4.4–4.9)
// ============================================================

const KONTO_LOSEN_ITER = 400;                  // itererad HMAC-SHA256; mål ≤ 300 ms per hashning (runKontoTests loggar tiden, A-S3-2 – uppmätt 2026-09-19: 2000 iterationer = 1459 ms i Apps Script, 400 ≈ 290 ms). Lagras i hash-strängen – kan höjas utan att gamla hashar bryts (räknas om vid nästa lyckade inloggning).
const KONTO_LOSEN_MIN = 6;                     // B6: bara längd
const KONTO_LOSEN_MAX = 128;
const KONTO_NAMN_MAX = 60;
const KONTO_DOMAN_MAX = 253;
const KONTO_TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;  // 32 slumpbyte base64url utan '='
const KONTO_ID_RE = /^bokare_[A-Za-z0-9_-]{1,64}$/;
const KONTO_SESSION_RE = /^[A-Za-z0-9_-]{40,400}\.[A-Za-z0-9_-]{43}$/;
const KONTO_SESSION_LANG_S = 30 * 86400;       // "Kom ihåg mig" (B6)
const KONTO_SESSION_KORT_S = 12 * 3600;        // annars – sidan lägger den i sessionStorage (försvinner när fliken stängs)
const KONTO_TOKEN_VERIFIERA_S = 86400;         // 24 h
const KONTO_TOKEN_ATERSTALL_S = 3600;          // 1 h
const KONTO_MAX_LOGIN_FAIL = 8;                // → spärr 15 min per konto (4.6)
const KONTO_SPARR_MS = 15 * 60000;
const KONTO_RL_LOGIN_PER_EPOST_10MIN = 20;     // rl:login:<epostHash16>:<10 min>
const KONTO_RL_PER_10MIN = 60;                 // rl:konto:<10 min> – alla konto-*-anrop globalt
const KONTO_MAX_LOGIN_FAIL_GLOBAL_D = 300;     // Script Property login_fail_<YYYYMMDD>
const KONTO_MAX_MAIL_D = 30;                   // verifierings-/återställningsmail per dygn globalt (Script Property konto_mail_<YYYYMMDD>) – bokningsnotiserna räknas inte här
const KONTO_MAX_MAIL_PER_KONTO_D = 3;          // per konto och dygn (konto.mail { datum, antal })
const KONTO_HISTORIK_MAX = 50;
const KONTO_GALLRING_OVERIFIERAD_DAGAR = 7;    // 4.9
const KONTON_CACHE_S = 21600;
const KONTO_MAIL_AVSANDARE = 'Pipeline bokning';

// ============================================================
// Kontofilen (4.1) – skrivs bara av scriptet under låset; CacheService-kopia med rev-kontroll som inkorgen (Code.gs readInbox).
// ============================================================

function kontonFileId_() {
  const id = getProp(PROP.KONTON_FILE_ID);
  if (!id) fel('E_SETUP', 'Kontofilen saknas – kör Återanslut i appen');
  return id;
}
function kontonAnsluten_() { return !!getProp(PROP.KONTON_FILE_ID); }
function kontonCacheKey_() { return 'konton:' + kontonFileId_(); }
function readKonton() {
  let k = null;
  try { k = cacheChunkedGet_(kontonCacheKey_()); } catch (e) { k = null; }
  if (isPlainObject(k) && String(Number(k.rev) || 0) !== getPropFarsk(PROP.KONTON_REV)) k = null;   // speglar inte senaste skrivning → Drive
  if (!isPlainObject(k)) {
    k = readJsonFile(kontonFileId_());
    if (LAS_HALLS_) kontonCacheSpara_(k);   // bara låshållaren fyller cachen (samma resonemang som inkorgen, version 7)
  }
  if (!Array.isArray(k.konton)) k.konton = [];
  k.konton = k.konton.filter(isPlainObject);
  return k;
}
// Anroparen håller låset.
function writeKonton(k) {
  try { cacheChunkedRemove_(kontonCacheKey_()); } catch (e) { /* best effort */ }
  const ut = writeJsonFile(kontonFileId_(), k);
  kontonCacheSpara_(ut);
  return ut;
}
function kontonCacheSpara_(k) {
  try { setProp(PROP.KONTON_REV, Number(k.rev) || 0); cacheChunkedPut_(kontonCacheKey_(), k, KONTON_CACHE_S); } catch (e) { /* best effort */ }
}
function kontonCacheRensa_() {
  try { const id = getProp(PROP.KONTON_FILE_ID); if (id) cacheChunkedRemove_('konton:' + id); } catch (e) { /* best effort */ }
}
// Läs-ändra-skriv av ETT konto under låset. fn(konto) muterar. → kontot, eller null om det inte finns.
function kontoUppdatera_(id, fn) {
  return withScriptLock(() => {
    const konton = readKonton();
    const k = konton.konton.find(x => x.id === id) || null;
    if (!k) return null;
    fn(k);
    writeKonton(konton);
    return k;
  });
}
function findKontoById_(id) {
  if (typeof id !== 'string' || !KONTO_ID_RE.test(id)) return null;
  return readKonton().konton.find(k => k.id === id) || null;
}
function findKontoByEpost_(konton, epost) {
  const e = normalizeEmail(epost);
  return konton.konton.find(k => normalizeEmail(k.epost) === e) || null;
}

// ============================================================
// Hemligheter och slump (4.2)
// ============================================================

// n slumpbyte: HMAC-SHA256 över två UUID:n med ett tredje som nyckel ger 32 byte per omgång (Apps Script saknar en direkt
// CSPRNG-byte-funktion; Utilities.getUuid är slumpmässig v4).
function slumpBytes_(n) {
  let ut = [];
  while (ut.length < n) ut = ut.concat(Utilities.computeHmacSha256Signature(Utilities.getUuid() + Utilities.getUuid(), Utilities.getUuid()));
  return ut.slice(0, n);
}
function b64url_(bytes) { return Utilities.base64EncodeWebSafe(bytes).replace(/=+$/, ''); }
function b64urlBytes_(s) { const p = (4 - String(s).length % 4) % 4; return Utilities.base64DecodeWebSafe(String(s) + '=='.slice(0, p)); }
function hexAvBytes_(b) { return b.map(x => ('0' + (x & 0xff).toString(16)).slice(-2)).join(''); }
// Skapar SESSION_SECRET och LOSEN_PEPPER om de saknas (install() och setup). → antal skapade. Rotera ALDRIG LOSEN_PEPPER när konton
// finns (alla lösenord blir ogiltiga); SESSION_SECRET-rotation loggar ut alla (medveten nödbroms).
function sakerstallHemligheter_() {
  let n = 0;
  if (!getPropFarsk(PROP.SESSION_SECRET)) { setProp(PROP.SESSION_SECRET, b64url_(slumpBytes_(32))); n++; }
  if (!getPropFarsk(PROP.LOSEN_PEPPER)) { setProp(PROP.LOSEN_PEPPER, b64url_(slumpBytes_(32))); n++; }
  return n;
}
function sessionSecret_() { const v = getProp(PROP.SESSION_SECRET); if (!v) fel('E_SETUP', 'SESSION_SECRET saknas – kör install() i redigeraren'); return v; }
function losenPepper_() { const v = getProp(PROP.LOSEN_PEPPER); if (!v) fel('E_SETUP', 'LOSEN_PEPPER saknas – kör install() i redigeraren'); return v; }

// ============================================================
// Lösenordshash (4.4): 'v1$<iter>$<saltB64url>$<hex>' – itererad HMAC-SHA256, första omgången med saltet som nyckel, därefter
// peppern (Script Property) som nyckel. Jämförelse i konstant tid.
// ============================================================

function hashLosenord_(losenord, saltB64, iter, pepper) {
  const saltBytes = b64urlBytes_(saltB64);
  const pepBytes = Utilities.newBlob(String(pepper)).getBytes();
  let h = Utilities.computeHmacSha256Signature(Utilities.newBlob(String(losenord)).getBytes(), saltBytes);
  for (let i = 1; i < iter; i++) h = Utilities.computeHmacSha256Signature(h, pepBytes);
  return hexAvBytes_(h);
}
function losenordHashStrang_(losenord, pepper, iter) {
  const it = iter || KONTO_LOSEN_ITER;
  const salt = b64url_(slumpBytes_(16));
  return 'v1$' + it + '$' + salt + '$' + hashLosenord_(losenord, salt, it, pepper === undefined ? losenPepper_() : pepper);
}
function losenordOk_(losenord, hashStr, pepper) {
  const m = /^v1\$(\d{1,6})\$([A-Za-z0-9_-]{16,64})\$([0-9a-f]{64})$/.exec(String(hashStr || ''));
  if (!m) return false;
  const iter = parseInt(m[1], 10);
  if (!(iter >= 1)) return false;
  return constantTimeEqual(hashLosenord_(losenord, m[2], iter, pepper === undefined ? losenPepper_() : pepper), m[3]);
}
function losenordIter_(hashStr) { const m = /^v1\$(\d{1,6})\$/.exec(String(hashStr || '')); return m ? parseInt(m[1], 10) : 0; }

// ============================================================
// Sessioner (4.5): base64url(JSON { v, id, pv, exp, iat }) + '.' + base64url(HMAC-SHA256(payloadB64, SESSION_SECRET)).
// Statslös: bunden till kontots losenord.version (pv) – byt lösenord = alla andra sessioner dör.
// ============================================================

function sessionSig_(p, secret) { return b64url_(Utilities.computeHmacSha256Signature(Utilities.newBlob(p).getBytes(), Utilities.newBlob(String(secret)).getBytes())); }
function sessionSkapa_(konto, langS, secret, nuMs) {
  const nu = Math.floor((nuMs === undefined ? Date.now() : nuMs) / 1000);
  const payload = { v: 1, id: String(konto.id), pv: Number(konto.losenord && konto.losenord.version) || 0, exp: nu + langS, iat: nu };
  const p = b64url_(Utilities.newBlob(JSON.stringify(payload)).getBytes());
  return { session: p + '.' + sessionSig_(p, secret === undefined ? sessionSecret_() : secret), exp: isoWithOffset(new Date((nu + langS) * 1000)) };
}
// → payload, annars E_SESSION (fel format, fel signatur, utgången, trasig payload).
function sessionVerifiera_(s, secret, nuMs) {
  if (typeof s !== 'string' || !KONTO_SESSION_RE.test(s)) fel('E_SESSION');
  const i = s.indexOf('.'), p = s.slice(0, i), sig = s.slice(i + 1);
  if (!constantTimeEqual(sessionSig_(p, secret === undefined ? sessionSecret_() : secret), sig)) fel('E_SESSION');
  let payload = null;
  try { payload = JSON.parse(Utilities.newBlob(b64urlBytes_(p)).getDataAsString('UTF-8')); } catch (e) { payload = null; }
  const nu = (nuMs === undefined ? Date.now() : nuMs) / 1000;
  if (!isPlainObject(payload) || payload.v !== 1 || typeof payload.id !== 'string' || !KONTO_ID_RE.test(payload.id) || !(Number(payload.exp) > nu)) fel('E_SESSION');
  return payload;
}
// Anropas av Code.gs authBokare när req.s finns: session → konto → effektiv bokare. E_SESSION / E_INAKTIV.
function authSession_(s, config) {
  const p = sessionVerifiera_(s);
  const konto = findKontoById_(p.id);
  if (!konto || konto.status !== 'aktiv' || !isPlainObject(konto.losenord) || (Number(konto.losenord.version) || 0) !== Number(p.pv)) fel('E_SESSION');
  const bokare = effectiveBokare_(konto, config);
  if (!bokare.aktiv) fel('E_INAKTIV');
  return bokare;
}

// ============================================================
// Tillåtelselistan (3.2, B13) och effektiv bokare (4.5)
// ============================================================

function epostDoman_(e) { const i = String(e).indexOf('@'); return i >= 0 ? String(e).slice(i + 1) : ''; }
// Aktiv post med exakt adressträff först, annars aktiv post med domänträff (allt efter '@', exakt – subdomäner räknas inte, B7). → post | null.
function matchaLista_(epost, lista) {
  const e = normalizeEmail(epost);
  if (!e || !Array.isArray(lista)) return null;
  const d = epostDoman_(e);
  const akt = lista.filter(p => isPlainObject(p) && p.aktiv === true && typeof p.doman === 'string' && p.doman.length <= KONTO_DOMAN_MAX);
  return akt.find(p => normalizeEmail(p.doman) === e) || (d ? akt.find(p => normalizeEmail(p.doman) === d) : null) || null;
}
// Kontot + appens bokarpost (config.bokare, finns efter appens import). Före importen gäller kontots pipeline och tillåtelselistan
// (aktiv = matchar en aktiv post); efter importen gäller CJ:s värden (pipeline, mötestyper, Aktiv-kryssrutan).
function effectiveBokare_(konto, config) {
  const cfgB = (config.bokare || []).find(b => b.id === konto.id) || null;
  const traff = matchaLista_(konto.epost, config.domaner);
  return {
    id: str(konto.id), arCj: false, harKonto: true,
    namn: (str(konto.fornamn) + ' ' + str(konto.efternamn)).trim(), fornamn: str(konto.fornamn), efternamn: str(konto.efternamn),
    epost: str(konto.epost), mobil: str(konto.mobil), organisation: str(konto.doman),
    pipelineId: cfgB ? str(cfgB.pipelineId) : str(konto.pipelineId),
    tillatnaMotestypIds: cfgB && Array.isArray(cfgB.tillatnaMotestypIds) ? cfgB.tillatnaMotestypIds : [],
    aktiv: cfgB ? cfgB.aktiv === true : !!traff
  };
}
// Bokaren bakom en inkorgspost: appens config-post (normalfallet efter import), annars kontot (nyregistrerad, ännu inte importerad), annars null.
function bokareForPost_(config, post) {
  const b = (config.bokare || []).find(x => x.id === post.bokareId) || null;
  if (b) return b;
  try { const k = findKontoById_(str(post.bokareId)); if (k) return effectiveBokare_(k, config); } catch (e) { /* kontofil saknas – som borttagen */ }
  return null;
}
// Snapshot som skrivs i inkorgsposten vid book (B9): namn, e-post, mobil. CJ-bokare/kodbokare saknar e-post/mobil.
function bokareSnapshot_(bokare) { return { namn: str(bokare && bokare.namn), epost: str(bokare && bokare.epost), mobil: str(bokare && bokare.mobil) }; }
// hello.bokare (4.3) – delas av handleHello och konto-verifiera.
function helloBokareExport_(bokare, config) {
  const pipeline = (config.pipelines || []).find(p => p.id === bokare.pipelineId) || {};
  return { id: str(bokare.id), arCj: bokare.arCj === true, namn: str(bokare.namn), organisation: str(bokare.organisation),
           pipelineNamn: str(pipeline.name), pipelineFarg: str(pipeline.color),
           fornamn: str(bokare.fornamn), efternamn: str(bokare.efternamn), epost: str(bokare.epost), mobil: str(bokare.mobil), harKonto: bokare.harKonto === true };
}

// ============================================================
// Validering (4.7) – statiska texter, ekar aldrig indata
// ============================================================

function kontoEpostField_(v) {
  const e = normalizeEmail(typeof v === 'string' ? v : '');
  if (!e || e.length > MAXLEN.epost || !EPOST_RE.test(e)) valideringsfel({ epost: 'Ogiltig e-postadress' });
  return e;
}
function kontoNamnField_(v, namn) {
  const t = typeof v === 'string' ? cleanText(v).replace(/\s+/g, ' ') : '';
  const f = {};
  if (!t) { f[namn] = 'Fältet är obligatoriskt'; valideringsfel(f); }
  if (t.length > KONTO_NAMN_MAX) { f[namn] = 'Högst ' + KONTO_NAMN_MAX + ' tecken'; valideringsfel(f); }
  return t;
}
function kontoMobilField_(v) {
  const t = typeof v === 'string' ? cleanText(v) : '';
  if (!t || t.length > MAXLEN.telefon || normalizePhone(t).length < 8) valideringsfel({ mobil: 'Ange ett giltigt mobilnummer' });
  return t;
}
function kontoLosenField_(v, epost) {
  if (typeof v !== 'string') valideringsfel({ losenord: 'Ange ett lösenord' });
  const n = Array.from(v).length;   // kodpunkter
  if (n < KONTO_LOSEN_MIN) valideringsfel({ losenord: 'Minst ' + KONTO_LOSEN_MIN + ' tecken' });
  if (n > KONTO_LOSEN_MAX) valideringsfel({ losenord: 'Högst ' + KONTO_LOSEN_MAX + ' tecken' });
  if (epost && normalizeEmail(v) === normalizeEmail(epost)) valideringsfel({ losenord: 'Lösenordet får inte vara din e-postadress' });
  return v;
}
function kontoTokenField_(v) { if (typeof v !== 'string' || !KONTO_TOKEN_RE.test(v)) fel('E_TOKEN'); return v; }
function kontoIdField_(v) { if (typeof v !== 'string' || !KONTO_ID_RE.test(v)) valideringsfel({ id: 'Ogiltigt id' }); return v; }

// ============================================================
// Missbruksskydd (4.6)
// ============================================================

function kontoRlGlobal_() { if (bumpCounter('rl:konto:' + tenMinWindow(), 600) > KONTO_RL_PER_10MIN) fel('E_RATE', undefined, { typ: 'anrop' }); }
function kontoRlEpost_(e) { if (bumpCounter('rl:login:' + sha256hex(e).slice(0, 16) + ':' + tenMinWindow(), 600) > KONTO_RL_LOGIN_PER_EPOST_10MIN) fel('E_RATE', undefined, { typ: 'anrop' }); }
function loginFailKey_() { return 'login_fail_' + ymdCompact(todayStr()); }
function loginFailIdag_() { return parseInt(getProp(loginFailKey_()), 10) || 0; }
function loginFailRakna_() { const k = loginFailKey_(); try { setProp(k, (parseInt(getPropFarsk(k), 10) || 0) + 1); } catch (e) { /* best effort */ } }
function kontoMailKey_() { return 'konto_mail_' + ymdCompact(todayStr()); }
function kontoMailIdag_() { return parseInt(getProp(kontoMailKey_()), 10) || 0; }
// Får ett konto-mail skickas till kontot nu? Stegar räknarna (globalt Script Property + konto.mail) när svaret är ja. Anroparen håller
// låset (konto.mail skrivs med kontot). Global gräns: strikt → E_RATE typ 'mail' (registrering), annars false (tyst – svaret är ändå ok).
function kontoMailTillat_(konto, strikt) {
  const idag = todayStr();
  if (kontoMailIdag_() >= KONTO_MAX_MAIL_D) { if (strikt) fel('E_RATE', 'Vi kan inte skicka fler mail idag – försök i morgon', { typ: 'mail' }); return false; }
  if (!isPlainObject(konto.mail) || konto.mail.datum !== idag) konto.mail = { datum: idag, antal: 0 };
  if ((Number(konto.mail.antal) || 0) >= KONTO_MAX_MAIL_PER_KONTO_D) return false;
  konto.mail.antal = (Number(konto.mail.antal) || 0) + 1;
  const k = kontoMailKey_();
  setProp(k, (parseInt(getPropFarsk(k), 10) || 0) + 1);
  return true;
}

// ============================================================
// Tokens och historik (4.1)
// ============================================================

// Skapar ett nytt engångstoken på kontot (ersätter ev. gammalt) och returnerar klartexten – den finns bara i mailet.
function tokenSkapa_(konto, typ, livS, nuMs) {
  const t = b64url_(slumpBytes_(32));
  konto.token = { typ: typ, hash: sha256hex(t), utgar: isoWithOffset(new Date((nuMs === undefined ? Date.now() : nuMs) + livS * 1000)) };
  return t;
}
function tokenGiltig_(konto, typ, token, nuMs) {
  const t = konto && konto.token;
  if (!isPlainObject(t) || t.typ !== typ || typeof t.hash !== 'string' || typeof token !== 'string') return false;
  if (!constantTimeEqual(t.hash, sha256hex(token))) return false;
  const utgar = new Date(str(t.utgar)).getTime();
  return !isNaN(utgar) && utgar > (nuMs === undefined ? Date.now() : nuMs);
}
function historik_(konto, typ, extra) {
  if (!Array.isArray(konto.historik)) konto.historik = [];
  konto.historik.push(Object.assign({ ts: nowIso(), typ: String(typ) }, extra || {}));
  if (konto.historik.length > KONTO_HISTORIK_MAX) konto.historik = konto.historik.slice(-KONTO_HISTORIK_MAX);
}

// ============================================================
// Mail (4.8) – plain text, statiska mallar, länkar från installningar.bokningSidaUrl
// ============================================================

function kontoLank_(config, param, token) {
  const bas = str(config.installningar && config.installningar.bokningSidaUrl) || DEFAULT_BOKNINGSINSTALLNINGAR.bokningSidaUrl;
  return bas + '?' + param + '=' + token;
}
function kontoSidaUrl_(config) { return str(config.installningar && config.installningar.bokningSidaUrl) || DEFAULT_BOKNINGSINSTALLNINGAR.bokningSidaUrl; }
function kontoS_(v) { return String(v || '').replace(/[<>]/g, ' '); }
// → true när mailet lämnade MailApp. Kvot slut / fel → false (anroparen loggar 'mailfel' på kontot, best effort).
function skickaKontoMail_(till, subject, rader) {
  const e = normalizeEmail(till);
  if (!e || !EPOST_RE.test(e)) return false;
  try {
    if (mailKvotSlut()) throw new Error('MailApp: dagskvoten är slut');
    MailApp.sendEmail({ to: e, subject: subject, body: rader.join('\n'), name: KONTO_MAIL_AVSANDARE });
    return true;
  } catch (err) { return false; }
}
function mailVerifiera_(config, konto, token) {
  return skickaKontoMail_(konto.epost, 'Bekräfta din e-postadress – bokning hos CJ', [
    'Hej ' + kontoS_(konto.fornamn) + '!',
    '',
    'Klicka på länken för att bekräfta ditt konto för mötesbokning (länken är giltig i 24 timmar):',
    kontoLank_(config, 'verifiera', token),
    '',
    'Har du inte registrerat dig kan du ignorera det här mailet.',
    '',
    'Redneck Engineering / Pipeline bokning'
  ]);
}
function mailFinnsRedan_(config, konto, token) {
  return skickaKontoMail_(konto.epost, 'Du har redan ett konto – bokning hos CJ', [
    'Hej ' + kontoS_(konto.fornamn) + '!',
    '',
    'Någon försökte registrera ett konto med din e-postadress. Du har redan ett konto – logga in här:',
    kontoSidaUrl_(config),
    '',
    'Har du glömt lösenordet kan du välja ett nytt via länken (giltig i 1 timme):',
    kontoLank_(config, 'aterstall', token),
    '',
    'Var det inte du kan du ignorera det här mailet.',
    '',
    'Redneck Engineering / Pipeline bokning'
  ]);
}
function mailAterstall_(config, konto, token) {
  return skickaKontoMail_(konto.epost, 'Nytt lösenord – bokning hos CJ', [
    'Hej ' + kontoS_(konto.fornamn) + '!',
    '',
    'Klicka på länken för att välja ett nytt lösenord (länken är giltig i 1 timme):',
    kontoLank_(config, 'aterstall', token),
    '',
    'Har du inte begärt detta kan du ignorera det här mailet – lösenordet ändras inte.',
    '',
    'Redneck Engineering / Pipeline bokning'
  ]);
}
// Notis till CJ (notisEpost) när ett konto verifierats (B3). Namn, e-post, mobil, listpost, pipeline. Räknas inte i konto-mailkvoten.
function notifyCjNyBokare_(config, konto) {
  const inst = config.installningar || {};
  if (!inst.notisEpost) return false;
  const pipeline = (config.pipelines || []).find(p => p.id === konto.pipelineId) || {};
  const traff = matchaLista_(konto.epost, config.domaner);
  const namn = (kontoS_(konto.fornamn) + ' ' + kontoS_(konto.efternamn)).trim();
  return skickaKontoMail_(inst.notisEpost, 'Ny bokare: ' + namn + ' (' + kontoS_(konto.epost) + ')', [
    'En ny bokare har bekräftat sitt konto och kan boka möten.',
    '',
    'Namn: ' + namn,
    'E-post: ' + kontoS_(konto.epost),
    'Mobil: ' + kontoS_(konto.mobil),
    'Tillåten via: ' + (traff ? kontoS_(traff.doman) : '(posten finns inte längre)'),
    'Pipeline: ' + (kontoS_(pipeline.name) || '(okänd)'),
    '',
    'Bokaren dyker upp under Bokningar › Bokare i appen vid nästa hämtning. Där kan du ändra pipeline/kolumn eller stänga av kontot.',
    'Öppna Pipeline: ' + APP_URL
  ]);
}
function loggaKontoMailfel_(kontoId) {
  try { withScriptLock(() => { const konton = readKonton(); const k = konton.konton.find(x => x.id === kontoId); if (!k) return; historik_(k, 'mailfel'); writeKonton(konton); }, 5000); }
  catch (e) { /* best effort */ }
}
// m = { typ:'verifiera'|'finns'|'aterstall', konto, token } – skickas utanför låset.
function kontoMailSkicka_(config, m) {
  if (!m) return false;
  let ok = false;
  if (m.typ === 'verifiera') ok = mailVerifiera_(config, m.konto, m.token);
  else if (m.typ === 'finns') ok = mailFinnsRedan_(config, m.konto, m.token);
  else if (m.typ === 'aterstall') ok = mailAterstall_(config, m.konto, m.token);
  if (!ok) loggaKontoMailfel_(m.konto.id);
  return ok;
}

// ============================================================
// Endpoint: konto-registrera (4.3) – oautentiserad
// In:  { epost, fornamn, efternamn, mobil, losenord }
// Ut:  {} (alltid samma svar när indata är giltiga och adressen matchar listan – ingen kontouppräkning). Ingen träff → E_DOMAN.
// Finns kontot: aktivt → mail "du har redan ett konto" (med återställningslänk); overifierat → profil OCH lösenord skrivs över
// med den nya inskickningen (den som verifierar via mailet äger adressen) + nytt verifieringsmail.
// ============================================================

function handleKontoRegistrera(req, ctx) {
  kontoRlGlobal_();
  const epost = kontoEpostField_(req.epost);
  const fornamn = kontoNamnField_(req.fornamn, 'fornamn');
  const efternamn = kontoNamnField_(req.efternamn, 'efternamn');
  const mobil = kontoMobilField_(req.mobil);
  const losenord = kontoLosenField_(req.losenord, epost);
  const config = loadConfig(ctx);
  const traff = matchaLista_(epost, config.domaner);
  if (!traff) fel('E_DOMAN');
  const hash = losenordHashStrang_(losenord);   // dyrt – utanför låset
  let mail = null;
  withScriptLock(() => {
    const konton = readKonton();
    let konto = findKontoByEpost_(konton, epost);
    if (konto) {
      ctx.bokareId = str(konto.id);
      if (konto.status === 'aktiv') {
        if (!kontoMailTillat_(konto, false)) return;
        historik_(konto, 'registreringNarKontoFinns');
        mail = { typ: 'finns', konto: konto, token: tokenSkapa_(konto, 'aterstall', KONTO_TOKEN_ATERSTALL_S) };
      } else {
        konto.fornamn = fornamn; konto.efternamn = efternamn; konto.mobil = mobil;
        konto.losenord = { hash: hash, version: (Number(konto.losenord && konto.losenord.version) || 0) + 1 };
        konto.pipelineId = str(traff.pipelineId); konto.listaId = str(traff.id); konto.doman = epostDoman_(epost);
        historik_(konto, 'registreradIgen');
        if (!kontoMailTillat_(konto, false)) { writeKonton(konton); return; }
        mail = { typ: 'verifiera', konto: konto, token: tokenSkapa_(konto, 'verifiera', KONTO_TOKEN_VERIFIERA_S) };
      }
      writeKonton(konton);
      return;
    }
    konto = {
      id: 'bokare_' + Utilities.getUuid(),
      epost: epost, doman: epostDoman_(epost), listaId: str(traff.id), fornamn: fornamn, efternamn: efternamn, mobil: mobil,
      pipelineId: str(traff.pipelineId),
      status: 'overifierad',
      losenord: { hash: hash, version: 1 },
      token: null, misslyckade: 0, sparradTill: '', mail: null,
      skapadTs: nowIso(), verifieradTs: '', senastInloggadTs: '',
      historik: []
    };
    ctx.bokareId = konto.id;
    historik_(konto, 'registrerad');
    kontoMailTillat_(konto, true);   // global mailgräns nådd → E_RATE typ 'mail', inget skrivs
    mail = { typ: 'verifiera', konto: konto, token: tokenSkapa_(konto, 'verifiera', KONTO_TOKEN_VERIFIERA_S) };
    konton.konton.push(konto);
    writeKonton(konton);
  });
  kontoMailSkicka_(config, mail);
  return {};
}

// ============================================================
// Endpoint: konto-verifiera (4.3) – oautentiserad
// In:  { token }   Ut: { session, exp, bokare } – bokaren är inloggad direkt (12 h; sidan lägger sessionen i sessionStorage).
// Utgången/okänd/redan använd länk → E_TOKEN.
// ============================================================

function handleKontoVerifiera(req, ctx) {
  kontoRlGlobal_();
  const token = kontoTokenField_(req.token);
  const config = loadConfig(ctx);
  let konto = null;
  withScriptLock(() => {
    const konton = readKonton();
    konto = konton.konton.find(k => tokenGiltig_(k, 'verifiera', token)) || null;
    if (!konto) fel('E_TOKEN');
    konto.status = 'aktiv';
    konto.verifieradTs = nowIso();
    konto.senastInloggadTs = konto.verifieradTs;
    konto.token = null; konto.misslyckade = 0; konto.sparradTill = '';
    historik_(konto, 'verifierad');
    writeKonton(konton);
  });
  ctx.bokareId = str(konto.id);
  notifyCjNyBokare_(config, konto);
  const bokare = effectiveBokare_(konto, config);
  const s = sessionSkapa_(konto, KONTO_SESSION_KORT_S);
  return { session: s.session, exp: s.exp, bokare: helloBokareExport_(bokare, config) };
}

// ============================================================
// Endpoint: konto-logga-in (4.3) – oautentiserad
// In:  { epost, losenord, komIhag }   Ut: { session, exp }
// Okänd e-post / fel lösenord → E_LOGIN (identiskt). Overifierat + rätt lösenord → E_OVERIFIERAD (+ nytt verifieringsmail, max 3/dygn).
// Avstängd (CJ:s kryssruta / ingen listträff före import) → E_INAKTIV. 8 fel → spärr 15 min (E_RATE typ 'inloggning').
// Lyckad inloggning skriver kontot bara när något ändrats (räknare, dygnsstämpel, omhashning till KONTO_LOSEN_ITER).
// ============================================================

function handleKontoLoggaIn(req, ctx) {
  kontoRlGlobal_();
  const epost = normalizeEmail(typeof req.epost === 'string' ? req.epost : '');
  const losenord = typeof req.losenord === 'string' ? req.losenord : '';
  const komIhag = req.komIhag === true;
  if (!epost || epost.length > MAXLEN.epost || !EPOST_RE.test(epost) || !losenord || Array.from(losenord).length > KONTO_LOSEN_MAX) fel('E_LOGIN');
  kontoRlEpost_(epost);
  if (loginFailIdag_() >= KONTO_MAX_LOGIN_FAIL_GLOBAL_D) fel('E_RATE', undefined, { typ: 'inloggning' });
  const config = loadConfig(ctx);
  const konto = findKontoByEpost_(readKonton(), epost);
  if (!konto || !isPlainObject(konto.losenord) || !konto.losenord.hash) { loginFailRakna_(); fel('E_LOGIN'); }
  ctx.bokareId = str(konto.id);
  const sparr = konto.sparradTill ? new Date(konto.sparradTill).getTime() : NaN;
  if (!isNaN(sparr) && sparr > Date.now()) fel('E_RATE', 'För många försök – vänta 15 minuter', { typ: 'inloggning' });
  if (!losenordOk_(losenord, konto.losenord.hash)) {
    loginFailRakna_();
    try {
      kontoUppdatera_(konto.id, k => {
        k.misslyckade = (Number(k.misslyckade) || 0) + 1;
        if (k.misslyckade >= KONTO_MAX_LOGIN_FAIL) { k.sparradTill = isoWithOffset(new Date(Date.now() + KONTO_SPARR_MS)); k.misslyckade = 0; historik_(k, 'sparrad'); }
      });
    } catch (e) { /* räknaren är best effort – svaret är ändå E_LOGIN */ }
    fel('E_LOGIN');
  }
  if (konto.status !== 'aktiv') {
    let mail = null;
    try { kontoUppdatera_(konto.id, k => { if (kontoMailTillat_(k, false)) mail = { typ: 'verifiera', konto: k, token: tokenSkapa_(k, 'verifiera', KONTO_TOKEN_VERIFIERA_S) }; }); } catch (e) { mail = null; }
    kontoMailSkicka_(config, mail);
    fel('E_OVERIFIERAD');
  }
  const bokare = effectiveBokare_(konto, config);
  if (!bokare.aktiv) fel('E_INAKTIV');
  const idag = todayStr();
  const omhasha = losenordIter_(konto.losenord.hash) !== KONTO_LOSEN_ITER;
  if ((Number(konto.misslyckade) || 0) > 0 || konto.sparradTill || str(konto.senastInloggadTs).slice(0, 10) !== idag || omhasha) {
    const nyHash = omhasha ? losenordHashStrang_(losenord) : '';
    try {
      kontoUppdatera_(konto.id, k => {
        k.misslyckade = 0; k.sparradTill = '';
        if (str(k.senastInloggadTs).slice(0, 10) !== idag) historik_(k, 'inloggad');
        k.senastInloggadTs = nowIso();
        if (nyHash && isPlainObject(k.losenord)) k.losenord.hash = nyHash;   // version oförändrad – befintliga sessioner gäller
      });
    } catch (e) { /* best effort – inloggningen lyckas ändå */ }
  }
  const s = sessionSkapa_(konto, komIhag ? KONTO_SESSION_LANG_S : KONTO_SESSION_KORT_S);
  return { session: s.session, exp: s.exp };
}

// ============================================================
// Endpoint: konto-glomt (4.3) – oautentiserad
// In:  { epost }   Ut: {} (alltid). Aktivt konto → återställningslänk (1 h); overifierat → nytt verifieringsmail; okänt → inget.
// ============================================================

function handleKontoGlomt(req, ctx) {
  kontoRlGlobal_();
  const epost = kontoEpostField_(req.epost);
  kontoRlEpost_(epost);
  const config = loadConfig(ctx);
  let mail = null;
  withScriptLock(() => {
    const konton = readKonton();
    const konto = findKontoByEpost_(konton, epost);
    if (!konto) return;
    ctx.bokareId = str(konto.id);
    if (!kontoMailTillat_(konto, false)) return;   // konto.mail rörs bara när svaret är ja – inget att skriva
    if (konto.status === 'aktiv') { historik_(konto, 'glomtBegart'); mail = { typ: 'aterstall', konto: konto, token: tokenSkapa_(konto, 'aterstall', KONTO_TOKEN_ATERSTALL_S) }; }
    else mail = { typ: 'verifiera', konto: konto, token: tokenSkapa_(konto, 'verifiera', KONTO_TOKEN_VERIFIERA_S) };
    writeKonton(konton);
  });
  kontoMailSkicka_(config, mail);
  return {};
}

// ============================================================
// Endpoint: konto-aterstall (4.3) – oautentiserad
// In:  { token, losenord }   Ut: { session, exp } (12 h). Utgången/okänd länk → E_TOKEN. losenord.version++ → övriga sessioner dör.
// ============================================================

function handleKontoAterstall(req, ctx) {
  kontoRlGlobal_();
  const token = kontoTokenField_(req.token);
  const losenord = kontoLosenField_(req.losenord, '');
  const config = loadConfig(ctx);
  const hash = losenordHashStrang_(losenord);
  let konto = null;
  withScriptLock(() => {
    const konton = readKonton();
    konto = konton.konton.find(k => tokenGiltig_(k, 'aterstall', token)) || null;
    if (!konto) fel('E_TOKEN');
    if (normalizeEmail(losenord) === normalizeEmail(konto.epost)) valideringsfel({ losenord: 'Lösenordet får inte vara din e-postadress' });
    konto.losenord = { hash: hash, version: (Number(konto.losenord && konto.losenord.version) || 0) + 1 };
    konto.token = null; konto.misslyckade = 0; konto.sparradTill = '';
    konto.senastInloggadTs = nowIso();
    historik_(konto, 'losenordAterstallt');
    writeKonton(konton);
  });
  ctx.bokareId = str(konto.id);
  const bokare = effectiveBokare_(konto, config);
  if (!bokare.aktiv) fel('E_INAKTIV');   // lösenordet är bytt, men ett avstängt konto får ingen session
  const s = sessionSkapa_(konto, KONTO_SESSION_KORT_S);
  return { session: s.session, exp: s.exp };
}

// ============================================================
// Endpoints med session: konto-byt-losenord { s, gammalt, nytt, komIhag? } → { session, exp } · konto-profil { s, fornamn, efternamn, mobil } → {}
// ============================================================

function kontoFranSession_(req, ctx) {
  const a = authBokare(req, ctx);
  if (a.bokare.harKonto !== true) valideringsfel({ s: 'Kräver inloggning med konto' });
  const konto = findKontoById_(a.bokare.id);
  if (!konto) fel('E_SESSION');
  return { konto: konto, bokare: a.bokare, config: a.config };
}
function handleKontoBytLosenord(req, ctx) {
  const a = kontoFranSession_(req, ctx);
  const gammalt = typeof req.gammalt === 'string' ? req.gammalt : '';
  const nytt = kontoLosenField_(req.nytt, a.konto.epost);
  if (!gammalt || !losenordOk_(gammalt, a.konto.losenord && a.konto.losenord.hash)) fel('E_LOGIN', 'Fel nuvarande lösenord');
  const hash = losenordHashStrang_(nytt);
  const k = kontoUppdatera_(a.konto.id, x => { x.losenord = { hash: hash, version: (Number(x.losenord && x.losenord.version) || 0) + 1 }; historik_(x, 'losenordBytt'); });
  if (!k) fel('E_SESSION');
  const s = sessionSkapa_(k, req.komIhag === true ? KONTO_SESSION_LANG_S : KONTO_SESSION_KORT_S);
  return { session: s.session, exp: s.exp };
}
function handleKontoProfil(req, ctx) {
  const a = kontoFranSession_(req, ctx);
  const fornamn = kontoNamnField_(req.fornamn, 'fornamn');
  const efternamn = kontoNamnField_(req.efternamn, 'efternamn');
  const mobil = kontoMobilField_(req.mobil);
  kontoUppdatera_(a.konto.id, x => { x.fornamn = fornamn; x.efternamn = efternamn; x.mobil = mobil; historik_(x, 'profilAndrad'); });
  return {};
}

// ============================================================
// Admin-endpoints (4.3): konton-list { adminKey } → { konton:[…utan hemligheter], rev } · konto-radera { adminKey, id } → { borttaget }
// ============================================================

function kontoExport_(k) {
  return { id: str(k.id), epost: str(k.epost), doman: str(k.doman), listaId: str(k.listaId), fornamn: str(k.fornamn), efternamn: str(k.efternamn),
           mobil: str(k.mobil), pipelineId: str(k.pipelineId), status: str(k.status), skapadTs: str(k.skapadTs), verifieradTs: str(k.verifieradTs),
           senastInloggadTs: str(k.senastInloggadTs) };
}
function handleKontonList(req, ctx) {
  authAdmin(req, ctx);
  const konton = readKonton();
  return { konton: konton.konton.map(kontoExport_), rev: Number(konton.rev) || 0 };
}
function handleKontoRadera(req, ctx) {
  authAdmin(req, ctx);
  const id = kontoIdField_(req.id);
  let borttaget = false;
  withScriptLock(() => {
    const konton = readKonton();
    const kvar = konton.konton.filter(k => k.id !== id);
    borttaget = kvar.length !== konton.konton.length;
    if (borttaget) { konton.konton = kvar; writeKonton(konton); }
  });
  return { borttaget: borttaget };
}

// ============================================================
// Gallring (4.9) – anropas av dailyMaintenance. Eget lås (nästla aldrig withScriptLock). → { borttagna, tokens }
// ============================================================

function gallraKonton_(nuMs) {
  if (!kontonAnsluten_()) return { borttagna: 0, tokens: 0 };
  return withScriptLock(() => {
    const konton = readKonton();
    const grans = nuMs - KONTO_GALLRING_OVERIFIERAD_DAGAR * 86400000;
    const kvar = konton.konton.filter(k => { const t = new Date(str(k.skapadTs)).getTime(); return !(k.status === 'overifierad' && !isNaN(t) && t < grans); });
    const borttagna = konton.konton.length - kvar.length;
    let tokens = 0;
    kvar.forEach(k => {
      if (isPlainObject(k.token)) { const u = new Date(str(k.token.utgar)).getTime(); if (isNaN(u) || u <= nuMs) { k.token = null; tokens++; } }
      if (Array.isArray(k.historik) && k.historik.length > KONTO_HISTORIK_MAX) k.historik = k.historik.slice(-KONTO_HISTORIK_MAX);
    });
    if (borttagna || tokens) { konton.konton = kvar; writeKonton(konton); }
    return { borttagna: borttagna, tokens: tokens };
  }, MAINT_LOCK_WAIT_MS);
}

// ping-fälten (4.3): kontonFil, kontonAntal, kontoMailIdag, inloggningsforsokIdag. Kastar aldrig.
function kontonForPing_() {
  const ut = { kontonFil: false, kontonAntal: 0, kontoMailIdag: kontoMailIdag_(), inloggningsforsokIdag: loginFailIdag_(), hemligheter: !!(getProp(PROP.SESSION_SECRET) && getProp(PROP.LOSEN_PEPPER)) };
  if (!kontonAnsluten_()) return ut;
  try { verifyBrevladaFile(getProp(PROP.KONTON_FILE_ID)); ut.kontonFil = true; ut.kontonAntal = readKonton().konton.length; } catch (e) { ut.kontonFil = false; }
  return ut;
}

// ============================================================
// Tester – kör runKontoTests() i redigeraren efter inklistring. Rör aldrig Drive/Script Properties (hemligheter skickas in).
// ============================================================

function runKontoTests() {
  const fel = []; let antal = 0;
  const ok = (villkor, text) => { antal++; if (!villkor) fel.push(text); };
  const kastar = (fn, code) => { try { fn(); return false; } catch (e) { return errorCode(e) === code; } };
  const PEPPER = 'test-pepper', SECRET = 'test-secret';

  // base64url
  const bytes = slumpBytes_(32);
  ok(bytes.length === 32, 'slumpBytes_ ger 32 byte');
  ok(b64url_(bytes).length === 43 && KONTO_TOKEN_RE.test(b64url_(bytes)), 'b64url_ av 32 byte = 43 tecken utan =');
  ok(hexAvBytes_(b64urlBytes_(b64url_(bytes))) === hexAvBytes_(bytes), 'b64url_ ↔ b64urlBytes_ roundtrip');
  ok(b64url_(slumpBytes_(16)).length === 22, 'salt = 22 tecken');

  // Lösenordshash (4.4)
  const t0 = Date.now();
  const h1 = losenordHashStrang_('hemligt1', PEPPER);
  const hashMs = Date.now() - t0;
  ok(/^v1\$\d+\$[A-Za-z0-9_-]{22}\$[0-9a-f]{64}$/.test(h1), 'hashformat v1$iter$salt$hex');
  ok(losenordOk_('hemligt1', h1, PEPPER), 'rätt lösenord → true');
  ok(!losenordOk_('hemligt2', h1, PEPPER), 'fel lösenord → false');
  ok(!losenordOk_('hemligt1', h1, 'annan-pepper'), 'fel pepper → false');
  ok(!losenordOk_('hemligt1', 'v1$2000$abc$00', PEPPER) && !losenordOk_('x', '', PEPPER), 'trasig hashsträng → false');
  ok(losenordHashStrang_('hemligt1', PEPPER) !== h1, 'nytt salt per hashning');
  ok(losenordIter_(h1) === KONTO_LOSEN_ITER, 'losenordIter_ läser iterationsantalet');
  const h50 = losenordHashStrang_('hemligt1', PEPPER, 50);
  ok(losenordOk_('hemligt1', h50, PEPPER) && losenordIter_(h50) === 50, 'äldre hash med annat iter verifieras (omhashas vid inloggning)');
  ok(losenordOk_('pässwörd ✓', losenordHashStrang_('pässwörd ✓', PEPPER, 20), PEPPER), 'unicode-lösenord roundtrip');

  // Sessioner (4.5)
  const konto = { id: 'bokare_test-1', losenord: { hash: h1, version: 3 } };
  const NU = Date.parse('2026-09-19T12:00:00+02:00');
  const s = sessionSkapa_(konto, 3600, SECRET, NU);
  ok(KONTO_SESSION_RE.test(s.session), 'sessionsformat');
  const p = sessionVerifiera_(s.session, SECRET, NU + 1000);
  ok(p.id === 'bokare_test-1' && p.pv === 3 && p.exp === Math.floor(NU / 1000) + 3600, 'session roundtrip (id, pv, exp)');
  ok(kastar(() => sessionVerifiera_(s.session, SECRET, NU + 3601 * 1000), 'E_SESSION'), 'utgången session → E_SESSION');
  ok(kastar(() => sessionVerifiera_(s.session, 'fel-secret', NU), 'E_SESSION'), 'fel hemlighet → E_SESSION');
  ok(kastar(() => sessionVerifiera_(s.session.slice(0, -1) + (s.session.slice(-1) === 'A' ? 'B' : 'A'), SECRET, NU), 'E_SESSION'), 'manipulerad signatur → E_SESSION');
  const delar = s.session.split('.');
  const p2 = b64url_(Utilities.newBlob(JSON.stringify({ v: 1, id: 'bokare_annan', pv: 3, exp: Math.floor(NU / 1000) + 3600, iat: 0 })).getBytes());
  ok(kastar(() => sessionVerifiera_(p2 + '.' + delar[1], SECRET, NU), 'E_SESSION'), 'bytt payload med gammal signatur → E_SESSION');
  ok(kastar(() => sessionVerifiera_('', SECRET, NU), 'E_SESSION') && kastar(() => sessionVerifiera_('abc', SECRET, NU), 'E_SESSION'), 'tom/trasig token → E_SESSION');

  // Tillåtelselistan (3.2, B13)
  const lista = [
    { id: 'd1', doman: 'byra.se', pipelineId: 'pA', aktiv: true },
    { id: 'd2', doman: 'anna@byra.se', pipelineId: 'pB', aktiv: true },
    { id: 'd3', doman: 'kalle@gmail.com', pipelineId: 'pA', aktiv: true },
    { id: 'd4', doman: 'gammal.se', pipelineId: 'pA', aktiv: false }
  ];
  ok(matchaLista_('bo@byra.se', lista).id === 'd1', 'domänträff');
  ok(matchaLista_('Anna@Byra.se', lista).id === 'd2', 'adressträff vinner över domän, oavsett skiftläge');
  ok(matchaLista_('kalle@gmail.com', lista).id === 'd3' && matchaLista_('lisa@gmail.com', lista) === null, 'adresspost släpper bara in adressen');
  ok(matchaLista_('x@sub.byra.se', lista) === null, 'subdomän matchar inte (B7)');
  ok(matchaLista_('x@gammal.se', lista) === null, 'inaktiv post matchar inte');
  ok(matchaLista_('', lista) === null && matchaLista_('x@byra.se', null) === null, 'tomt/ingen lista');

  // Effektiv bokare (4.5)
  const k1 = { id: 'bokare_k1', epost: 'bo@byra.se', doman: 'byra.se', fornamn: 'Bo', efternamn: 'Ek', mobil: '0701', pipelineId: 'pA', status: 'aktiv', losenord: { hash: h1, version: 1 } };
  const cfg0 = { bokare: [], domaner: lista, pipelines: [{ id: 'pA', name: 'A', color: '#111111' }, { id: 'pZ', name: 'Z', color: '#222222' }] };
  let e = effectiveBokare_(k1, cfg0);
  ok(e.aktiv === true && e.pipelineId === 'pA' && e.namn === 'Bo Ek' && e.harKonto === true && e.arCj === false, 'före import: listan styr, kontots pipeline');
  const cfg1 = { bokare: [{ id: 'bokare_k1', pipelineId: 'pZ', tillatnaMotestypIds: ['m1'], aktiv: true }], domaner: [], pipelines: cfg0.pipelines };
  e = effectiveBokare_(k1, cfg1);
  ok(e.aktiv === true && e.pipelineId === 'pZ' && e.tillatnaMotestypIds[0] === 'm1', 'efter import: CJ:s pipeline/mötestyper gäller även utan listträff');
  ok(effectiveBokare_(k1, { bokare: [{ id: 'bokare_k1', pipelineId: 'pZ', aktiv: false }], domaner: lista, pipelines: [] }).aktiv === false, 'CJ:s Aktiv=false stänger av trots listträff');
  ok(effectiveBokare_(k1, { bokare: [], domaner: [], pipelines: [] }).aktiv === false, 'ingen listträff och ingen config-post → inaktiv (B8)');
  const hx = helloBokareExport_(e, cfg1);
  ok(hx.pipelineNamn === 'Z' && hx.epost === 'bo@byra.se' && hx.mobil === '0701' && hx.harKonto === true, 'helloBokareExport_');

  // Validering (4.7)
  ok(kontoEpostField_('  Anna@Byra.SE ') === 'anna@byra.se', 'e-post normaliseras');
  ok(kastar(() => kontoEpostField_('anna'), 'E_VALIDATION'), 'ogiltig e-post');
  ok(kastar(() => kontoLosenField_('abcde', ''), 'E_VALIDATION') && kontoLosenField_('abcdef', '') === 'abcdef', 'lösenord minst 6 tecken');
  ok(kastar(() => kontoLosenField_('anna@byra.se', 'anna@byra.se'), 'E_VALIDATION'), 'lösenord = e-post avvisas');
  ok(kastar(() => kontoLosenField_('x'.repeat(129), ''), 'E_VALIDATION'), 'lösenord högst 128');
  ok(kontoMobilField_('070-123 45 67') === '070-123 45 67' && kastar(() => kontoMobilField_('12345'), 'E_VALIDATION'), 'mobil ≥ 8 siffror');
  ok(kontoNamnField_('  Anna   Karin ', 'fornamn') === 'Anna Karin' && kastar(() => kontoNamnField_('', 'fornamn'), 'E_VALIDATION'), 'namn städas/obligatoriskt');
  ok(kastar(() => kontoTokenField_('kort'), 'E_TOKEN') && kastar(() => kontoTokenField_(undefined), 'E_TOKEN'), 'token-format');

  // Tokens (4.1)
  const k2 = { id: 'bokare_k2', token: null };
  const tok = tokenSkapa_(k2, 'verifiera', 3600, NU);
  ok(KONTO_TOKEN_RE.test(tok) && k2.token.hash === sha256hex(tok) && k2.token.typ === 'verifiera', 'tokenSkapa_ lagrar bara hashen');
  ok(tokenGiltig_(k2, 'verifiera', tok, NU + 1000), 'giltigt token');
  ok(!tokenGiltig_(k2, 'aterstall', tok, NU + 1000), 'fel typ');
  ok(!tokenGiltig_(k2, 'verifiera', tok, NU + 3601 * 1000), 'utgånget');
  ok(!tokenGiltig_(k2, 'verifiera', b64url_(slumpBytes_(32)), NU), 'annat token');
  ok(!tokenGiltig_({ id: 'x', token: null }, 'verifiera', tok, NU), 'inget token');

  // Historik
  const k3 = { id: 'bokare_k3', historik: [] };
  for (let i = 0; i < 60; i++) historik_(k3, 't' + i);
  ok(k3.historik.length === KONTO_HISTORIK_MAX && k3.historik[0].typ === 't10', 'historik klipps till 50');

  // Mailkvot per konto (utan Script Properties: bara kontots del testas via datumbyte)
  ok(epostDoman_('a@b.se') === 'b.se' && epostDoman_('abc') === '', 'epostDoman_');
  ok(kontoS_('<b>x</b>') === ' b x /b ', 'kontoS_ strippar < >');

  const text = fel.length ? 'FEL (' + fel.length + ' av ' + antal + '):\n' + fel.join('\n') : 'Alla ' + antal + ' test OK';
  console.log(text + '\nHashtid (' + KONTO_LOSEN_ITER + ' iterationer): ' + hashMs + ' ms – mål ≤ 300 ms (A-S3-2); justera KONTO_LOSEN_ITER om det behövs.');
  return text + ' · hashtid ' + hashMs + ' ms';
}
