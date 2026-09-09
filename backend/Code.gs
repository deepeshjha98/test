/**
 * झाजी चूड़ा मिल — लोडिंग/अनलोडिंग app का backend (Google Apps Script)
 *
 * यह वही "बीच का program" है जो phone की app और आपकी Google Sheet को जोड़ता है।
 * App इसी को POST भेजती है; यह Sheet में row लिखकर जवाब देता है।
 *
 * लगाने का तरीका (एक ही बार, 5 मिनट) — README_BACKEND.md में step-by-step है।
 */

// ── 1. यहाँ अपना password जैसा key डालो (खाली छोड़ोगे तो कोई key नहीं लगेगी) ──
var APP_KEY = '';

// ── 2. Sheet कौन सी? ──
// Sheet के अंदर से (Extensions → Apps Script) बनाया है  → खाली छोड़ दो।
// script.google.com से अलग project बनाया है (फ़ोन वाला रास्ता) → Sheet का ID यहाँ डालो।
// ID = Sheet के URL में /d/ और /edit के बीच वाला लंबा हिस्सा:
//   docs.google.com/spreadsheets/d/[[[ यही ID ]]]/edit
var SHEET_ID = '';

// Sheet के नाम — बदलना हो तो यहीं बदलो
var SH_ENTRIES = 'एंट्री';
var SH_LABOUR  = 'लेबर सूची';
var SH_LISTS   = 'सूचियाँ';

var HEAD_ENTRIES = ['क्रम', 'दिनांक', 'कार्य प्रकार', 'सामान', 'स्टार्ट', 'फिनिश', 'कुल समय',
                    'कुल बोरा', 'लेबर संख्या', 'लेबर', 'बनाई गई (phone)', 'आई (server)',
                    'clientId', 'app version'];
var COL_CLIENT_ID = 13;   // HEAD_ENTRIES में clientId का column (1 से गिनकर)

// ───────────────────────────── app से आने वाली requests ─────────────────────────────

function doPost(e) {
  try {
    var body = JSON.parse((e && e.postData && e.postData.contents) || '{}');

    // दोनों तरफ़ trim: APP_KEY में गलती से आगे/पीछे space रह जाए तो key बेवजह गलत न बताए
    // (app भी key save करते समय trim करती है)
    var wantKey = String(APP_KEY == null ? '' : APP_KEY).trim();
    if (wantKey && String(body.key == null ? '' : body.key).trim() !== wantKey) {
      return json({ ok: false, error: 'App key गलत है — ⚙ सेटिंग में key जाँचो।' });
    }

    switch (body.action) {
      case 'ping':  return json({ ok: true, sheet: book().getName() });
      case 'lists': return json(getLists());
      case 'save':  return json(saveEntry(body));
      default:      return json({ ok: false, error: 'अनजान action: ' + body.action });
    }
  } catch (err) {
    // गड़बड़ पर jaan-boojhkar throw: app entry को "pending" रखकर बाद में फिर भेजेगी (data नहीं खोता)
    throw err;
  }
}

// /exec URL browser में खोलने पर यह दिखेगा — deploy सही हुआ या नहीं, जाँचने के लिए
function doGet() {
  return json({ ok: true, app: 'JCM लोडिंग backend', hint: 'यह URL phone app की ⚙ सेटिंग में डालो।' });
}

function json(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

// जिस Sheet में लिखना है — SHEET_ID भरा हो तो वही, वरना जिसके अंदर यह script है
function book() {
  var id = String(SHEET_ID == null ? '' : SHEET_ID).trim();
  if (id) return SpreadsheetApp.openById(id);
  var active = SpreadsheetApp.getActive();
  if (!active) throw new Error('कोई Sheet नहीं मिली — Code.gs में SHEET_ID भरो।');
  return active;
}

// ───────────────────────────── लिस्ट (लेबर / सामान / कार्य प्रकार) ─────────────────────────────

function getLists() {
  var ss = book();
  return {
    ok: true,
    labour: colValues(ss.getSheetByName(SH_LABOUR), 2),   // "लेबर सूची" का B column
    goods:  colValues(ss.getSheetByName(SH_LISTS), 1),    // "सूचियाँ" का A column
    types:  colValues(ss.getSheetByName(SH_LISTS), 2)     // "सूचियाँ" का B column
  };
}

// किसी sheet के एक column के नाम — heading छोड़कर, खाली और दुहराव हटाकर
function colValues(sheet, col) {
  if (!sheet) return [];
  var last = sheet.getLastRow();
  if (last < 2) return [];
  var vals = sheet.getRange(2, col, last - 1, 1).getValues();
  var out = [], seen = {};
  for (var i = 0; i < vals.length; i++) {
    var v = String(vals[i][0] == null ? '' : vals[i][0]).replace(/\s+/g, ' ').trim();
    if (!v || seen[v]) continue;
    seen[v] = true; out.push(v);
  }
  return out;
}

// ───────────────────────────── entry save (dedup के साथ) ─────────────────────────────

function saveEntry(body) {
  var entry = body.entry || {};
  var clientId = String(body.clientId || '');
  if (!clientId) return { ok: false, error: 'clientId नहीं आया।' };

  var bad = validateEntry(entry);
  if (bad) return { ok: false, error: bad };

  // एक समय में एक ही save — दो फ़ोन एक साथ भेजें तो भी row गड्ड-मड्ड न हो
  var lock = LockService.getScriptLock();
  lock.waitLock(25000);
  try {
    var sheet = ensureEntriesSheet();

    // वही entry पहले आ चुकी है? (app network टूटने पर उसी clientId से दुबारा भेजती है)
    var found = findByClientId(sheet, clientId);
    if (found) return { ok: true, row: found.row, serial: found.serial, duplicate: true };

    var serial = Math.max(0, sheet.getLastRow() - 1) + 1;
    sheet.appendRow([
      serial,
      String(entry.date || ''),
      String(entry.type || ''),
      String(entry.goods || ''),
      "'" + String(entry.start || ''),      // ' लगाने से 09:00 समय/तारीख़ में नहीं बदलता
      "'" + String(entry.finish || ''),
      durationText(entry.start, entry.finish),
      Number(entry.bags),
      (entry.labour || []).length,
      (entry.labour || []).join(', '),
      String(body.createdAt || ''),
      new Date(),
      clientId,
      String(body.appVersion || '')
    ]);
    return { ok: true, row: sheet.getLastRow(), serial: serial, duplicate: false };
  } finally {
    lock.releaseLock();
  }
}

function findByClientId(sheet, clientId) {
  var last = sheet.getLastRow();
  if (last < 2) return null;
  var ids = sheet.getRange(2, COL_CLIENT_ID, last - 1, 1).getValues();
  for (var i = 0; i < ids.length; i++) {
    if (String(ids[i][0]) === clientId) {
      var row = i + 2;
      return { row: row, serial: sheet.getRange(row, 1).getValue() };
    }
  }
  return null;
}

// app की validate() जैसी ही जाँच — server आख़िरी फ़ैसला करता है
function validateEntry(e) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(e.date || ''))) return 'दिनांक ठीक नहीं।';
  if (!e.type) return 'कार्य प्रकार नहीं आया।';
  if (!e.goods) return 'सामान नहीं आया।';
  if (!/^\d{2}:\d{2}$/.test(String(e.start || '')) || !/^\d{2}:\d{2}$/.test(String(e.finish || ''))) return 'स्टार्ट/फिनिश टाइम ठीक नहीं।';
  if (!/^\d+$/.test(String(e.bags))) return 'कुल बोरा पूरा अंक में होना चाहिए।';
  if (!e.labour || !e.labour.length) return 'कम से कम एक लेबर चाहिए।';
  return '';
}

function durationText(s, f) {
  if (!/^\d{2}:\d{2}$/.test(String(s || '')) || !/^\d{2}:\d{2}$/.test(String(f || ''))) return '';
  var a = String(s).split(':'), b = String(f).split(':');
  var m = ((+b[0]) * 60 + (+b[1]) - (+a[0]) * 60 - (+a[1]) + 1440) % 1440;
  return Math.floor(m / 60) + ' घंटे ' + (m % 60) + ' मिनट';
}

// ───────────────────────────── पहली बार: sheets बना दो ─────────────────────────────

/** Apps Script editor में एक बार चलाओ (▶ Run) — तीनों sheets बन जाएँगी। */
function setupWorkbook() {
  var ss = book();
  ensureEntriesSheet();

  var lab = ss.getSheetByName(SH_LABOUR) || ss.insertSheet(SH_LABOUR);
  if (lab.getLastRow() < 1) {
    lab.getRange(1, 1, 1, 2).setValues([['क्रम', 'लेबर का नाम']]).setFontWeight('bold');
    lab.setFrozenRows(1);
    lab.getRange(2, 2, 3, 1).setValues([['राम कुमार'], ['श्याम यादव'], ['मोहन साह']]);
  }

  var li = ss.getSheetByName(SH_LISTS) || ss.insertSheet(SH_LISTS);
  if (li.getLastRow() < 1) {
    li.getRange(1, 1, 1, 2).setValues([['सामान का प्रकार', 'कार्य प्रकार']]).setFontWeight('bold');
    li.setFrozenRows(1);
    li.getRange(2, 1, 3, 1).setValues([['चूड़ा'], ['धान'], ['चावल']]);
    li.getRange(2, 2, 2, 1).setValues([['लोडिंग'], ['अनलोडिंग']]);
  }
  return 'तैयार: ' + SH_ENTRIES + ', ' + SH_LABOUR + ', ' + SH_LISTS;
}

function ensureEntriesSheet() {
  var ss = book();
  var sh = ss.getSheetByName(SH_ENTRIES);
  if (!sh) sh = ss.insertSheet(SH_ENTRIES);
  if (sh.getLastRow() < 1) {
    sh.getRange(1, 1, 1, HEAD_ENTRIES.length).setValues([HEAD_ENTRIES]).setFontWeight('bold');
    sh.setFrozenRows(1);
  }
  return sh;
}
