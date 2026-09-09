/* JCM लोडिंग-अनलोडिंग PWA — app.js
   Structure:
     createCore()  → pure logic (settings, lists cache, offline queue, sync). कोई DOM नहीं → node में test होता है।
     UI section    → DOM wiring (सिर्फ browser में चलता है)।
   Data guarantee:
     - हर entry को device पर unique id (uuid) मिलती है और वह localStorage queue में तुरंत save होती है।
     - Sync सिर्फ status बदलता है: pending → sent (server ने row confirm की) / failed (server ने reject किया)।
     - Network error → entry pending ही रहती है, बाद में फिर कोशिश। Server उसी id पर दुबारा row नहीं बनाता (dedup)।
*/
(function (root) {
  'use strict';

  const APP_VERSION = '1.2.0';
  const K = { api: 'jcm.api', key: 'jcm.key', lists: 'jcm.lists', queue: 'jcm.queue', draft: 'jcm.draft', shift: 'jcm.shift' };
  const DEFAULT_SHIFT = { start: '08:30', finish: '18:30' };   // मिल का सामान्य समय; ⚙ सेटिंग से बदला जा सकता है
  const MAX_SENT_HISTORY = 300;
  const REQUEST_TIMEOUT_MS = 25000;

  function uuid() {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
      const r = Math.random() * 16 | 0; return (c === 'x' ? r : (r & 3 | 8)).toString(16);
    });
  }
  function pad2(n) { return String(n).padStart(2, '0'); }
  function todayLocal(d) { d = d || new Date(); return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()); }
  function toMin(t) { const p = String(t).split(':'); return (+p[0]) * 60 + (+p[1]); }
  function durationText(s, f) {
    if (!/^\d{2}:\d{2}$/.test(s || '') || !/^\d{2}:\d{2}$/.test(f || '')) return '';
    const m = (toMin(f) - toMin(s) + 1440) % 1440;
    return Math.floor(m / 60) + ' घंटे ' + (m % 60) + ' मिनट';
  }
  // ── काम के घंटे बनाम ओवरटाइम ──────────────────────────────────────────────
  // सोच: समय को "दिन के मिनट" (0-1439) में नहीं, एक लगातार timeline पर रखो।
  // entry = [s, s+total]. शिफ्ट की खिड़की को पिछले/इसी/अगले दिन — तीनों के लिए
  // बिछा दो, फिर हर खिड़की से कटान (overlap) जोड़ लो। इससे आधी रात पार वाली
  // entry (22:00→02:15) और रात भर वाली (20:00→09:00) अपने-आप सही बँटती हैं।

  function hhmm(min) {   // 270 → "4:30"  (बड़े जोड़ के लिए, जैसे 126:45)
    min = Math.max(0, Math.round(min || 0));
    return Math.floor(min / 60) + ':' + pad2(min % 60);
  }

  // एक दिन की शिफ्ट → timeline पर तीन दिन की खिड़कियाँ
  function shiftWindows(ws, wf) {
    const crosses = wf <= ws;                    // रात की पाली (जैसे 20:00–06:00)
    const out = [];
    for (let k = -1; k <= 1; k++) out.push([ws + 1440 * k, (crosses ? wf + 1440 : wf) + 1440 * k]);
    return out;                                  // खिड़कियाँ कभी आपस में नहीं भिड़तीं → दोहरी गिनती नहीं
  }

  // एक entry का बँटवारा। total वही रहता है जो durationText गिनता है।
  function splitShift(start, finish, shift) {
    const T = /^\d{2}:\d{2}$/;
    const out = { total: 0, work: 0, ot: 0 };
    if (!T.test(start || '') || !T.test(finish || '')) return out;
    const sh = shift || DEFAULT_SHIFT;
    if (!T.test(sh.start || '') || !T.test(sh.finish || '')) return out;

    const s = toMin(start);
    out.total = (toMin(finish) - s + 1440) % 1440;
    const e = s + out.total;

    let work = 0;
    shiftWindows(toMin(sh.start), toMin(sh.finish)).forEach(function (w) {
      work += Math.max(0, Math.min(e, w[1]) - Math.max(s, w[0]));
    });
    out.work = Math.min(work, out.total);        // हिसाब कभी total से ऊपर न जाए
    out.ot = out.total - out.work;
    return out;
  }

  function fmtDate(iso) {   // 2026-09-08 → 08-09-2026
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso || ''); return m ? m[3] + '-' + m[2] + '-' + m[1] : (iso || '');
  }

  // textarea/array → साफ़ नामों की list (trim, खाली हटाओ, दुहराव हटाओ)
  function cleanNames(v) {
    const arr = Array.isArray(v) ? v : String(v == null ? '' : v).split('\n');
    const out = [], seen = {};
    arr.forEach(function (s) {
      const t = String(s).replace(/\s+/g, ' ').trim();
      if (!t || seen[t]) return;
      seen[t] = 1; out.push(t);
    });
    return out;
  }
  function statusText(it) {
    return it.status === 'sent' ? 'Sheet में गई' : it.status === 'failed' ? 'अटकी' : 'फ़ोन में';
  }

  // server जैसी ही validation (server authoritative है; यह user को तुरंत बताने के लिए)
  function validate(e, lists) {
    e = e || {};
    if (!/^\d{4}-\d{2}-\d{2}$/.test(e.date || '')) return 'दिनांक भरो।';
    if (!e.type) return 'कार्य प्रकार चुनो।';
    if (!e.goods) return 'सामान का प्रकार चुनो।';
    const T = /^\d{2}:\d{2}$/;
    if (!T.test(e.start || '') || !T.test(e.finish || '')) return 'स्टार्ट और फिनिश टाइम दोनों भरो।';
    if (!/^\d+$/.test(String(e.bags === undefined || e.bags === null ? '' : e.bags))) return 'कुल बोरा पूरा अंक में भरो।';
    if (!Array.isArray(e.labour) || !e.labour.length) return 'कम से कम एक लेबर चुनो।';
    if (lists) {
      if (lists.types.indexOf(e.type) < 0) return 'कार्य प्रकार list में नहीं है — लिस्ट refresh करो।';
      if (lists.goods.indexOf(e.goods) < 0) return 'सामान list में नहीं है — लिस्ट refresh करो।';
      const bad = e.labour.filter(function (n) { return lists.labour.indexOf(n) < 0; });
      if (bad.length) return 'ये नाम लेबर सूची में नहीं: ' + bad.join(', ');
    }
    return '';
  }

  function createCore(opts) {
    const storage = opts.storage;
    const fetchFn = opts.fetchFn;
    const now = opts.now || function () { return new Date(); };
    const get = function (k, d) { try { const v = storage.getItem(k); return v == null ? d : JSON.parse(v); } catch (_) { return d; } };
    const set = function (k, v) { storage.setItem(k, JSON.stringify(v)); };
    let syncing = false;

    function prune(q) {
      let sent = 0;
      for (let i = 0; i < q.length; i++) {
        if (q[i].status !== 'sent') continue;
        sent++;
        if (sent > MAX_SENT_HISTORY) { q.splice(i, 1); i--; }
      }
    }

    const core = {
      version: APP_VERSION,
      getApi: function () { return get(K.api, ''); },
      setApi: function (u) { set(K.api, String(u || '').trim()); },
      getKey: function () { return get(K.key, ''); },
      setKey: function (k) { set(K.key, String(k || '').trim()); },
      lists: function () { return get(K.lists, null); },
      queue: function () { return get(K.queue, []); },
      pending: function () { return core.queue().filter(function (i) { return i.status === 'pending'; }); },
      failed: function () { return core.queue().filter(function (i) { return i.status === 'failed'; }); },
      sent: function () { return core.queue().filter(function (i) { return i.status === 'sent'; }); },
      getDraft: function () { return get(K.draft, null); },
      setDraft: function (d) { if (d) set(K.draft, d); else storage.removeItem(K.draft); },
      isSyncing: function () { return syncing; },

      // Apps Script web app को POST (text/plain body = JSON → कोई CORS preflight नहीं)
      request: async function (body, timeoutMs) {
        const api = core.getApi();
        if (!api) throw new Error('API URL set नहीं है — ⚙ सेटिंग में Web App URL डालो।');
        const payload = Object.assign({ key: core.getKey(), appVersion: APP_VERSION }, body);
        const ctrl = (typeof AbortController !== 'undefined') ? new AbortController() : null;
        const timer = ctrl ? setTimeout(function () { ctrl.abort(); }, timeoutMs || REQUEST_TIMEOUT_MS) : null;
        try {
          const res = await fetchFn(api, {
            method: 'POST',
            headers: { 'Content-Type': 'text/plain;charset=utf-8' },
            body: JSON.stringify(payload),
            redirect: 'follow',
            signal: ctrl ? ctrl.signal : undefined
          });
          const text = await res.text();
          try { return JSON.parse(text); }
          catch (_) { throw new Error('Server से JSON नहीं मिला — API URL और web app का "Anyone" access check करो।'); }
        } catch (e) {
          if (e && e.name === 'AbortError') throw new Error('Server ने समय पर जवाब नहीं दिया (timeout)।');
          throw e;
        } finally { if (timer) clearTimeout(timer); }
      },

      ping: async function () {
        const r = await core.request({ action: 'ping' }, 15000);
        if (!r || !r.ok) throw new Error((r && r.error) || 'ping fail');
        return r;
      },

      refreshLists: async function () {
        const r = await core.request({ action: 'lists' });
        if (!r || !r.ok) throw new Error((r && r.error) || 'लिस्ट नहीं मिली');
        const l = { labour: r.labour || [], goods: r.goods || [], types: r.types || [], fetchedAt: now().toISOString() };
        set(K.lists, l);
        return l;
      },

      // entry → queue (यहीं से data "सुरक्षित" है, भले network न हो)
      enqueue: function (entry) {
        const err = validate(entry, core.lists());
        if (err) throw new Error(err);
        const clean = {
          date: entry.date, type: entry.type, goods: entry.goods, start: entry.start, finish: entry.finish,
          bags: String(entry.bags), labour: entry.labour.slice()
        };
        const q = core.queue();
        const item = { id: uuid(), entry: clean, status: 'pending', createdAt: now().toISOString(), attempts: 0, error: '', result: null };
        q.unshift(item);
        prune(q);
        set(K.queue, q);
        return item;
      },

      // pending entries को पुरानी → नई क्रम में भेजो। network error पर रुक जाओ (बाद में फिर)।
      sync: async function () {
        if (syncing) return { busy: true, sent: 0, failed: 0, pending: core.pending().length, error: '' };
        syncing = true;
        const out = { busy: false, sent: 0, failed: 0, pending: 0, error: '' };
        try {
          const q = core.queue();
          const pend = q.filter(function (i) { return i.status === 'pending'; }).reverse();
          for (let i = 0; i < pend.length; i++) {
            const it = pend[i];
            let r;
            try {
              r = await core.request({ action: 'save', clientId: it.id, createdAt: it.createdAt, entry: it.entry });
            } catch (e) {
              it.attempts = (it.attempts || 0) + 1; it.error = e.message; it.lastTry = now().toISOString();
              set(K.queue, q); out.error = e.message; break;
            }
            it.lastTry = now().toISOString();
            if (r && r.ok) {
              it.status = 'sent'; it.error = '';
              it.result = { row: r.row, serial: r.serial, duplicate: !!r.duplicate }; it.sentAt = now().toISOString();
              out.sent++;
            } else {
              it.status = 'failed'; it.error = (r && r.error) || 'Server ने reject किया'; out.failed++;
            }
            set(K.queue, q);
          }
          out.pending = core.pending().length;
          return out;
        } finally { syncing = false; }
      },

      retry: function (id) {
        const q = core.queue(); const it = q.find(function (x) { return x.id === id; });
        if (!it || it.status !== 'failed') return false;
        it.status = 'pending'; it.error = ''; set(K.queue, q); return true;
      },
      remove: function (id) {
        const q = core.queue(); const i = q.findIndex(function (x) { return x.id === id; });
        if (i < 0 || q[i].status === 'sent') return false;   // sent rows phone से नहीं हटतीं (Sheet ही सच है)
        q.splice(i, 1); set(K.queue, q); return true;
      },
      clearSent: function () { set(K.queue, core.queue().filter(function (i) { return i.status !== 'sent'; })); },

      // ---------- शिफ्ट का समय + काम/ओवरटाइम की रिपोर्ट ----------
      getShift: function () {
        const v = get(K.shift, null);
        return (v && /^\d{2}:\d{2}$/.test(v.start || '') && /^\d{2}:\d{2}$/.test(v.finish || '')) ? v : DEFAULT_SHIFT;
      },
      setShift: function (start, finish) {
        const T = /^\d{2}:\d{2}$/;
        if (!T.test(start || '') || !T.test(finish || '')) throw new Error('शिफ्ट का समय HH:MM में भरो।');
        if (start === finish) throw new Error('शुरू और ख़त्म का समय एक जैसा नहीं हो सकता।');
        const v = { start: start, finish: finish };
        set(K.shift, v);
        return v;
      },

      // एक entry का बँटवारा (UI के लिए) — मौजूदा शिफ्ट के हिसाब से
      split: function (start, finish) { return splitShift(start, finish, core.getShift()); },

      /* तारीख़ की सीमा में पूरी रिपोर्ट।
         समय दो तरह से गिना जाता है:
           घड़ी का समय  = entry कितनी देर चली (चाहे 1 लेबर हो या 10)
           लेबर-घंटे    = वही समय × उतने लेबर  (मज़दूरी/OT का असली आधार)  */
      report: function (from, to) {
        const shift = core.getShift();
        const items = core.queue().filter(function (it) {
          const d = it.entry && it.entry.date;
          if (!d) return false;
          if (from && d < from) return false;
          if (to && d > to) return false;
          return true;
        });

        const r = {
          shift: shift, from: from || '', to: to || '', count: items.length, bags: 0,
          totalMin: 0, workMin: 0, otMin: 0,           // घड़ी का समय
          manMin: 0, manWorkMin: 0, manOtMin: 0,        // लेबर-घंटे
          labour: [], days: [], types: [], goods: []
        };
        const byName = {}, byDay = {}, byType = {}, byGoods = {};
        function bucket(map, key, sp, n) {
          const b = map[key] || (map[key] = { name: key, count: 0, totalMin: 0, workMin: 0, otMin: 0, bags: 0 });
          b.count++; b.totalMin += sp.total * n; b.workMin += sp.work * n; b.otMin += sp.ot * n;
          return b;
        }

        items.forEach(function (it) {
          const e = it.entry;
          const sp = splitShift(e.start, e.finish, shift);
          const n = (e.labour || []).length;
          r.bags += Number(e.bags) || 0;
          r.totalMin += sp.total; r.workMin += sp.work; r.otMin += sp.ot;
          r.manMin += sp.total * n; r.manWorkMin += sp.work * n; r.manOtMin += sp.ot * n;

          (e.labour || []).forEach(function (nm) { bucket(byName, nm, sp, 1); });   // हर लेबर को पूरा समय
          bucket(byDay, e.date, sp, 1).bags += Number(e.bags) || 0;
          bucket(byType, e.type, sp, 1).bags += Number(e.bags) || 0;
          bucket(byGoods, e.goods, sp, 1).bags += Number(e.bags) || 0;
        });

        const byOt = function (a, b) { return (b.otMin - a.otMin) || (b.totalMin - a.totalMin) || a.name.localeCompare(b.name); };
        r.labour = Object.keys(byName).map(function (k) { return byName[k]; }).sort(byOt);
        r.types  = Object.keys(byType).map(function (k) { return byType[k]; }).sort(byOt);
        r.goods  = Object.keys(byGoods).map(function (k) { return byGoods[k]; }).sort(byOt);
        r.days   = Object.keys(byDay).map(function (k) { return byDay[k]; }).sort(function (a, b) { return b.name.localeCompare(a.name); });
        return r;
      },

      // ---------- सिर्फ़-फ़ोन (offline) मोड ----------
      // कोई Web App URL सेट नहीं = app पूरी तरह local database पर चलती है।
      localOnly: function () { return !core.getApi(); },

      // लेबर/सामान/कार्य प्रकार खुद भरो — Sheet या internet की ज़रूरत नहीं
      setLocalLists: function (l) {
        const clean = {
          labour: cleanNames(l && l.labour), goods: cleanNames(l && l.goods), types: cleanNames(l && l.types),
          fetchedAt: now().toISOString(), source: 'local'
        };
        if (!clean.types.length) throw new Error('कम से कम एक कार्य प्रकार लिखो (जैसे लोडिंग, अनलोडिंग)।');
        if (!clean.goods.length) throw new Error('कम से कम एक सामान लिखो (जैसे चूड़ा, धान)।');
        if (!clean.labour.length) throw new Error('कम से कम एक लेबर का नाम लिखो।');
        set(K.lists, clean);
        return clean;
      },

      // सारी entries CSV में — Excel/Sheet में paste या WhatsApp पर भेजने के लिए
      toCSV: function () {
        const sh = core.getShift();
        const head = ['क्रम', 'दिनांक', 'कार्य प्रकार', 'सामान', 'स्टार्ट', 'फिनिश', 'कुल समय',
                      'काम के घंटे', 'ओवरटाइम', 'कुल बोरा',
                      'लेबर संख्या', 'लेबर', 'लेबर-घंटे (काम)', 'लेबर-घंटे (OT)',
                      'स्थिति', 'बनाई गई', 'Sheet row'];
        const rows = core.queue().slice().reverse().map(function (it, i) {
          const e = it.entry;
          const sp = splitShift(e.start, e.finish, sh);
          const n = e.labour.length;
          return [i + 1, e.date, e.type, e.goods, e.start, e.finish, hhmm(sp.total),
                  hhmm(sp.work), hhmm(sp.ot), e.bags,
                  n, e.labour.join(', '), hhmm(sp.work * n), hhmm(sp.ot * n),
                  statusText(it), it.createdAt,
                  (it.result && it.result.serial != null) ? it.result.serial : ''];
        });
        return [head].concat(rows).map(function (r) {
          return r.map(function (c) {
            const s = String(c == null ? '' : c);
            return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
          }).join(',');
        }).join('\r\n');
      },

      // पूरा backup (entries + लिस्ट) — इसे सुरक्षित जगह रख लो
      exportJSON: function () {
        return JSON.stringify({
          app: 'jcm-loading', version: APP_VERSION, exportedAt: now().toISOString(),
          lists: core.lists(), queue: core.queue()
        }, null, 1);
      },

      // backup वापस डालो — id से मिलान, सिर्फ़ नई entries जुड़ती हैं; मौजूदा कुछ नहीं मिटता
      importJSON: function (text) {
        let data;
        try { data = JSON.parse(String(text || '')); }
        catch (_) { throw new Error('यह backup पढ़ा नहीं गया — पूरा text paste हुआ?'); }
        if (!data || data.app !== 'jcm-loading' || !Array.isArray(data.queue)) throw new Error('यह JCM का backup नहीं लगता।');
        const q = core.queue(), have = {};
        q.forEach(function (i) { have[i.id] = true; });
        let added = 0, bad = 0;
        data.queue.forEach(function (it) {
          if (!it || !it.id || have[it.id]) return;
          if (!it.entry || validate(it.entry, null)) { bad++; return; }
          q.push(it); have[it.id] = true; added++;
        });
        q.sort(function (a, b) { return String(b.createdAt || '').localeCompare(String(a.createdAt || '')); });
        set(K.queue, q);
        let lists = 0;
        if (!core.lists() && data.lists && Array.isArray(data.lists.labour)) { set(K.lists, data.lists); lists = 1; }
        return { added: added, bad: bad, lists: lists };
      }
    };
    return core;
  }

  const api = { createCore: createCore, validate: validate, uuid: uuid, todayLocal: todayLocal, durationText: durationText, fmtDate: fmtDate, cleanNames: cleanNames, splitShift: splitShift, hhmm: hhmm, DEFAULT_SHIFT: DEFAULT_SHIFT, APP_VERSION: APP_VERSION };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.JCM = api;

  // =====================================================================================================
  // UI (browser only)
  // =====================================================================================================
  if (typeof document === 'undefined') return;

  const $ = function (id) { return document.getElementById(id); };
  const store = (root.JCMDB && root.JCMDB.createStore()) || localStorage;   // db.js = IndexedDB; न मिले तो localStorage
  const core = createCore({ storage: store, fetchFn: fetch.bind(root) });
  let selType = null, selLabour = {}, view = 'entry', toastTimer = null, deferredInstall = null;

  // ---- helpers
  function toast(text, cls, ms) {
    const t = $('toast'); t.textContent = text; t.className = 'show ' + (cls || '');
    clearTimeout(toastTimer); toastTimer = setTimeout(function () { t.className = ''; }, ms || 2600);
  }
  function buzz(ms) { try { if (navigator.vibrate) navigator.vibrate(ms || 30); } catch (_) { } }
  function online() { return navigator.onLine !== false; }
  function setNet() { const n = $('net'); n.textContent = online() ? 'online' : 'offline'; n.className = 'net' + (online() ? '' : ' off'); }

  // ---- lists → form
  function renderLists() {
    const d = core.lists();
    const tEl = $('types'); tEl.innerHTML = '';
    const gEl = $('goods'); const keepG = gEl.value; gEl.innerHTML = '<option value="">-- चुनो --</option>';
    const lEl = $('labour'); lEl.innerHTML = '';
    if (!d) {
      $('labourHint').textContent = 'लिस्ट अभी खाली है — ⚙ सेटिंग → "लोकल लिस्ट" में नाम खुद भर दो (internet की ज़रूरत नहीं), या Web App URL डालकर Sheet से मँगा लो।';
      return;
    }
    d.types.forEach(function (name) {
      const b = document.createElement('button'); b.type = 'button'; b.textContent = name;
      b.onclick = function () { selType = name; renderSel(); saveDraft(); };
      tEl.appendChild(b);
    });
    if (!selType || d.types.indexOf(selType) < 0) selType = d.types[0] || null;
    d.goods.forEach(function (name) {
      const o = document.createElement('option'); o.value = name; o.textContent = name; gEl.appendChild(o);
    });
    if (keepG && d.goods.indexOf(keepG) >= 0) gEl.value = keepG;
    d.labour.forEach(function (name) {
      const c = document.createElement('div'); c.className = 'chip'; c.textContent = name;
      c.onclick = function () { selLabour[name] = !selLabour[name]; buzz(15); renderSel(); saveDraft(); };
      lEl.appendChild(c);
    });
    Object.keys(selLabour).forEach(function (n) { if (d.labour.indexOf(n) < 0) delete selLabour[n]; });
    $('labourHint').textContent = d.labour.length ? '' : '"लेबर सूची" sheet के B column में नाम भरो, फिर ⚙ → लिस्ट refresh।';
    renderSel();
  }
  function renderSel() {
    const tb = $('types').children;
    for (let i = 0; i < tb.length; i++) tb[i].className = (tb[i].textContent === selType) ? 'on' : '';
    const ch = $('labour').children; let n = 0;
    for (let j = 0; j < ch.length; j++) {
      const on = !!selLabour[ch[j].textContent]; ch[j].className = on ? 'chip on' : 'chip'; if (on) n++;
    }
    $('cnt').textContent = n;
    $('dur').textContent = (function () {
      const a = $('start').value, b = $('finish').value;
      const t = durationText(a, b);
      if (!t) return '';
      const sp = core.split(a, b);
      return 'कुल समय: ' + t + (sp.ot ? '  ·  काम ' + hhmm(sp.work) + ' + ओवरटाइम ' + hhmm(sp.ot) : '  ·  पूरा काम के घंटों में');
    })();
  }
  function formEntry() {
    return {
      date: $('date').value, type: selType, goods: $('goods').value, start: $('start').value, finish: $('finish').value,
      bags: $('bags').value, labour: Object.keys(selLabour).filter(function (n) { return selLabour[n]; })
    };
  }
  function loadEntry(e) {
    $('date').value = e.date || todayLocal(); selType = e.type || selType; $('goods').value = e.goods || '';
    $('start').value = e.start || ''; $('finish').value = e.finish || ''; $('bags').value = e.bags || '';
    selLabour = {}; (e.labour || []).forEach(function (n) { selLabour[n] = true; });
    renderSel();
  }
  function saveDraft() { core.setDraft(formEntry()); }
  function resetForm(keepContext) {
    const e = formEntry();
    $('start').value = ''; $('finish').value = ''; $('bags').value = ''; selLabour = {};
    if (!keepContext) { $('date').value = todayLocal(); $('goods').value = ''; }
    else { $('date').value = e.date || todayLocal(); }
    renderSel(); core.setDraft(null);
  }

  // ---- queue / list view
  function renderList() {
    const q = core.queue();
    const nP = q.filter(function (i) { return i.status === 'pending'; }).length;
    const nF = q.filter(function (i) { return i.status === 'failed'; }).length;
    const nS = q.length - nP - nF;
    const solo = core.localOnly();
    $('syncBtn').hidden = solo;
    $('lblPending').textContent = solo ? 'फ़ोन में सुरक्षित' : 'बाकी (pending)';
    $('nPending').textContent = nP; $('nFailed').textContent = nF; $('nSent').textContent = nS;
    $('badge').textContent = (nP + nF) ? String(nP + nF) : '';
    const box = $('items'); box.innerHTML = '';
    if (!q.length) { box.innerHTML = '<div class="empty">अभी कोई entry नहीं।</div>'; return; }
    q.forEach(function (it) {
      const e = it.entry; const d = document.createElement('div'); d.className = 'item';
      const st = it.status === 'pending' ? (solo ? 'फ़ोन में' : 'बाकी')
               : it.status === 'sent' ? ('Sheet row ' + (it.result && it.result.serial != null ? it.result.serial : '?')) : 'अटकी';
      d.innerHTML =
        '<div class="t"><span>' + esc(fmtDate(e.date)) + ' · ' + esc(e.type) + ' · ' + esc(e.goods) + '</span><span class="st ' + it.status + '">' + esc(st) + '</span></div>' +
        '<div class="s">' + esc(e.start) + '–' + esc(e.finish) + ' · ' + esc(e.bags) + ' बोरा · ' + e.labour.length + ' लेबर: ' + esc(e.labour.join(', ')) + '</div>' +
        (function () { const sp = core.split(e.start, e.finish);
          return '<div class="s">काम ' + hhmm(sp.work) + (sp.ot ? ' · <b style="color:#ef6c00">ओवरटाइम ' + hhmm(sp.ot) + '</b>' : '') + '</div>'; })() +
        (it.error ? '<div class="e">' + esc(it.error) + '</div>' : '');
      if (it.status !== 'sent') {
        const wrap = document.createElement('div');
        if (it.status === 'failed') {
          const b = document.createElement('button'); b.className = 'btn blue sm'; b.textContent = '↻ फिर भेजो';
          b.onclick = function () { core.retry(it.id); renderList(); doSync(true); }; wrap.appendChild(b);
        }
        const ed = document.createElement('button'); ed.className = 'btn ghost sm'; ed.textContent = '✎ Edit';
        ed.onclick = function () { if (!confirm('यह entry form में लौटेगी और सूची से हटेगी। ठीक?')) return; core.remove(it.id); loadEntry(e); showView('entry'); renderList(); };
        wrap.appendChild(ed);
        const rm = document.createElement('button'); rm.className = 'btn danger sm'; rm.textContent = '🗑 हटाओ';
        rm.onclick = function () { if (!confirm('पक्का हटाना है? यह Sheet में नहीं गई है।')) return; core.remove(it.id); renderList(); };
        wrap.appendChild(rm);
        d.appendChild(wrap);
      }
      box.appendChild(d);
    });
  }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }

  async function doSync(quiet) {
    if (core.localOnly()) {   // कोई Web App URL नहीं → सब कुछ फ़ोन में ही रहता है
      renderList();
      if (!quiet) toast('यह app अभी सिर्फ़ फ़ोन पर चल रही है — entries यहीं सुरक्षित हैं।');
      return;
    }
    if (!core.pending().length) { renderList(); if (!quiet) toast('भेजने को कुछ बाकी नहीं।'); return; }
    if (!online()) { if (!quiet) toast('Offline हो — network आते ही अपने-आप भेजेगा।', 'err'); return; }
    const btn = $('syncBtn'); btn.disabled = true; btn.textContent = '☁ भेज रहा है…';
    try {
      const r = await core.sync();
      renderList();
      if (r.busy) return;
      if (r.sent) { buzz([30, 40, 30]); toast('☁ ' + r.sent + ' entry Sheet में गई' + (r.pending ? ', ' + r.pending + ' बाकी' : ''), 'ok'); }
      if (r.failed) toast('✖ ' + r.failed + ' entry server ने reject की — सूची में देखो', 'err', 4000);
      if (r.error && !r.sent) toast('Sync नहीं हुआ: ' + r.error, 'err', 4000);
    } finally { btn.disabled = false; btn.textContent = '☁ अभी sync करो'; }
  }

  // ---- views
  function showView(v) {
    view = v;
    ['entry', 'list', 'report', 'settings'].forEach(function (x) { $('view-' + x).hidden = (x !== v); });
    const tabs = document.querySelectorAll('nav.tabs button');
    tabs.forEach(function (b) { b.className = b.getAttribute('data-view') === v ? 'on' : ''; });
    if (v === 'list') renderList();
    if (v === 'report') renderReport();
    if (v === 'settings') { $('api').value = core.getApi(); $('key').value = core.getKey(); shiftInfo(); fillLocalLists(); listsInfo(); dbInfo(); }
    window.scrollTo(0, 0);
  }
  function listsInfo() {
    const l = core.lists();
    $('listsInfo').textContent = l
      ? (l.labour.length + ' लेबर, ' + l.goods.length + ' सामान, ' + l.types.length + ' कार्य प्रकार · ' +
         (l.source === 'local' ? 'फ़ोन में भरी हुई' : 'Sheet से आई') + ' · ' + new Date(l.fetchedAt).toLocaleString('hi-IN'))
      : 'लिस्ट अभी खाली है।';
    $('ver').textContent = APP_VERSION;
  }

  // ---- local list editor
  function fillLocalLists() {
    const l = core.lists() || { labour: [], goods: [], types: [] };
    $('llTypes').value = (l.types || []).join('\n');
    $('llGoods').value = (l.goods || []).join('\n');
    $('llLabour').value = (l.labour || []).join('\n');
  }

  // ---- विश्लेषण (काम के घंटे बनाम ओवरटाइम)
  let repRange = 'month';

  function monthStart(d) { return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-01'; }

  function applyQuickRange() {
    const now = new Date();
    if (repRange === 'today') { $('repFrom').value = todayLocal(now); $('repTo').value = todayLocal(now); }
    else if (repRange === 'month') { $('repFrom').value = monthStart(now); $('repTo').value = todayLocal(now); }
    else { $('repFrom').value = ''; $('repTo').value = ''; }
    document.querySelectorAll('#repQuick button').forEach(function (b) {
      b.className = b.getAttribute('data-range') === repRange ? 'on' : '';
    });
  }

  function table(el, cols, rows, totalRow) {
    let h = '<thead><tr>' + cols.map(function (c) { return '<th>' + esc(c) + '</th>'; }).join('') + '</tr></thead><tbody>';
    if (!rows.length) h += '<tr><td colspan="' + cols.length + '" style="text-align:center;color:#6b7480">कुछ नहीं</td></tr>';
    rows.forEach(function (r) {
      h += '<tr>' + r.map(function (c, i) {
        return '<td' + (i === 2 ? ' class="ot"' : '') + '>' + esc(c) + '</td>';
      }).join('') + '</tr>';
    });
    if (totalRow && rows.length) {
      h += '<tr>' + totalRow.map(function (c, i) {
        return '<td style="font-weight:700' + (i === 2 ? ';color:#ef6c00' : '') + '">' + esc(c) + '</td>';
      }).join('') + '</tr>';
    }
    el.innerHTML = h + '</tbody>';
  }

  function renderReport() {
    const r = core.report($('repFrom').value, $('repTo').value);
    const sh = r.shift;
    $('repShift').textContent = 'शिफ्ट: ' + sh.start + ' से ' + sh.finish + ' — इसके बाहर का सारा समय ओवरटाइम। (⚙ सेटिंग में बदल सकते हो)';

    $('repTotal').textContent = hhmm(r.totalMin);
    $('repWork').textContent = hhmm(r.workMin);
    $('repOt').textContent = hhmm(r.otMin);

    const pct = r.totalMin ? Math.round(r.otMin * 100 / r.totalMin) : 0;
    $('repHead').innerHTML = r.count
      ? '<div class="kv">' + r.count + ' entry · ' + r.bags + ' बोरा · कुल समय का <b>' + pct + '%</b> ओवरटाइम</div>' +
        '<div class="kv" style="margin-top:6px">लेबर-घंटे: काम <b>' + hhmm(r.manWorkMin) + '</b> · ओवरटाइम <b style="color:#ef6c00">' + hhmm(r.manOtMin) + '</b> · कुल ' + hhmm(r.manMin) + '</div>'
      : '<div class="empty">इस अवधि में कोई entry नहीं।</div>';

    const cols = ['', 'काम', 'ओवरटाइम', 'कुल'];
    const rowsOf = function (arr) {
      return arr.map(function (b) { return [b.name, hhmm(b.workMin), hhmm(b.otMin), hhmm(b.totalMin)]; });
    };
    table($('repLabour'), ['लेबर', 'काम', 'ओवरटाइम', 'कुल'], rowsOf(r.labour),
      ['कुल (लेबर-घंटे)', hhmm(r.manWorkMin), hhmm(r.manOtMin), hhmm(r.manMin)]);
    table($('repDays'), ['दिनांक', 'काम', 'ओवरटाइम', 'कुल'],
      r.days.map(function (b) { return [fmtDate(b.name), hhmm(b.workMin), hhmm(b.otMin), hhmm(b.totalMin)]; }),
      ['कुल', hhmm(r.workMin), hhmm(r.otMin), hhmm(r.totalMin)]);
    table($('repTypes'), ['कार्य प्रकार', 'काम', 'ओवरटाइम', 'कुल'], rowsOf(r.types), null);
    table($('repGoods'), ['सामान', 'काम', 'ओवरटाइम', 'कुल'], rowsOf(r.goods), null);
  }

  // ---- मोड के हिसाब से hint
  function modeHints() {
    $('saveHint').textContent = core.localOnly()
      ? 'Save होते ही entry फ़ोन के local database में सुरक्षित। (Web App URL डालोगे तो Google Sheet में भी जाने लगेगी।)'
      : 'Save होते ही entry phone में सुरक्षित; network मिलते ही Google Sheet में जाती है।';
  }

  // ---- database की हालत (सेटिंग में)
  async function dbInfo() {
    const b = (store.backend ? store.backend() : 'localstorage');
    const name = b === 'indexeddb' ? 'IndexedDB (फ़ोन का local database)'
               : b === 'localstorage' ? 'localStorage (छोटी capacity)'
               : 'कोई storage नहीं';
    let extra = '';
    try {
      if (store.estimate) {
        const e = await store.estimate();
        if (e && e.usage) extra = ' · ' + (e.usage < 1048576 ? Math.max(1, Math.round(e.usage / 1024)) + ' KB' : (e.usage / 1048576).toFixed(1) + ' MB') + ' इस्तेमाल';
      }
    } catch (_) { }
    $('dbInfo').textContent = core.queue().length + ' entry · ' + name + extra;
    const err = store.lastError ? store.lastError() : '';
    $('dbErr').textContent = err || '';
    $('dbErr').hidden = !err;
  }

  // ---- export / backup
  function showData(text, label) {
    $('dataBox').hidden = false;
    $('dataOut').value = text;
    $('dataLabel').textContent = label;
    $('dataOut').scrollIntoView({ block: 'nearest' });
  }
  async function copyText(t) {
    try { if (navigator.clipboard && navigator.clipboard.writeText) { await navigator.clipboard.writeText(t); return true; } } catch (_) { }
    try { const el = $('dataOut'); el.focus(); el.select(); return document.execCommand('copy'); } catch (_) { return false; }
  }

  // ---- events
  document.querySelectorAll('nav.tabs button').forEach(function (b) { b.onclick = function () { showView(b.getAttribute('data-view')); }; });
  ['start', 'finish', 'bags', 'date', 'goods'].forEach(function (id) { $(id).addEventListener('change', function () { renderSel(); saveDraft(); }); $(id).addEventListener('input', saveDraft); });

  $('save').onclick = async function () {
    const e = formEntry(); const err = validate(e, core.lists());
    if (err) { toast(err, 'err'); buzz([60, 40, 60]); return; }
    const btn = $('save'); btn.disabled = true;
    try {
      const it = core.enqueue(e);
      buzz(40); resetForm(true); renderList();
      toast('✔ Entry save हुई (' + it.entry.labour.length + ' लेबर)' +
        (core.localOnly() ? ' — फ़ोन में सुरक्षित' : online() ? ' — Sheet में भेज रहा है…' : ' — offline, बाद में जाएगी'), 'ok');
      if (!core.localOnly() && online()) {
        const r = await core.sync(); renderList();
        if (r.sent) toast('☁ Sheet में row ' + (core.sent()[0] && core.sent()[0].result ? core.sent()[0].result.serial : '') + ' बन गई', 'ok');
        else if (r.failed) toast('✖ Server ने reject किया — सूची में देखो', 'err', 4000);
        else if (r.error) toast('Phone में सुरक्षित है; Sheet में बाद में जाएगी (' + r.error + ')', 'err', 4000);
      }
    } catch (ex) { toast(ex.message, 'err'); }
    finally { btn.disabled = false; }
  };

  $('syncBtn').onclick = function () { doSync(false); };
  $('refreshLists').onclick = async function () {
    try { await core.refreshLists(); renderLists(); listsInfo(); toast('लिस्ट refresh हो गई', 'ok'); }
    catch (e) { toast(e.message, 'err', 4000); }
  };
  $('saveSettings').onclick = function () {
    core.setApi($('api').value); core.setKey($('key').value); toast('सेटिंग save हो गई', 'ok');
  };
  $('testBtn').onclick = async function () {
    core.setApi($('api').value); core.setKey($('key').value);
    const out = $('testOut'); out.textContent = 'जाँच रहा है…';
    try {
      await core.ping(); const l = await core.refreshLists(); renderLists(); listsInfo();
      out.textContent = '✔ जुड़ गया: ' + l.labour.length + ' लेबर, ' + l.goods.length + ' सामान, ' + l.types.length + ' कार्य प्रकार';
      toast('✔ Server से जुड़ गया', 'ok');
    } catch (e) { out.textContent = '✖ ' + e.message; }
  };
  $('clearSent').onclick = function () { if (confirm('सिर्फ भेजी हुई entries का local इतिहास हटेगा (Sheet पर असर नहीं)। ठीक?')) { core.clearSent(); renderList(); toast('इतिहास साफ़', 'ok'); } };

  // ---- विश्लेषण के बटन
  document.querySelectorAll('#repQuick button').forEach(function (b) {
    b.onclick = function () { repRange = b.getAttribute('data-range'); applyQuickRange(); renderReport(); };
  });
  ['repFrom', 'repTo'].forEach(function (id) {
    $(id).addEventListener('change', function () {
      repRange = '';                                  // हाथ से तारीख़ चुनी → कोई chip चुना हुआ नहीं
      document.querySelectorAll('#repQuick button').forEach(function (b) { b.className = ''; });
      renderReport();
    });
  });

  // ---- शिफ्ट का समय
  function shiftInfo() {
    const sh = core.getShift();
    $('shStart').value = sh.start; $('shFinish').value = sh.finish;
    const w = (toMin(sh.finish) - toMin(sh.start) + 1440) % 1440;
    $('shiftInfo').textContent = 'अभी: ' + sh.start + ' – ' + sh.finish + ' (' + hhmm(w) + ' घंटे)। इसके बाहर का समय ओवरटाइम।';
  }
  $('saveShift').onclick = function () {
    try {
      core.setShift($('shStart').value, $('shFinish').value);
      shiftInfo(); renderSel(); renderList();
      toast('✔ शिफ्ट का समय save हुआ', 'ok');
    } catch (e) { toast(e.message, 'err', 4000); }
  };

  // ---- लोकल लिस्ट (बिना internet)
  $('saveLists').onclick = function () {
    try {
      const l = core.setLocalLists({ types: $('llTypes').value, goods: $('llGoods').value, labour: $('llLabour').value });
      renderLists(); listsInfo(); modeHints(); fillLocalLists();
      toast('✔ लिस्ट फ़ोन में save हुई (' + l.labour.length + ' लेबर)', 'ok');
    } catch (e) { toast(e.message, 'err', 4000); }
  };

  // ---- export / backup / restore
  $('exportCsv').onclick = function () {
    const n = core.queue().length;
    if (!n) { toast('अभी कोई entry नहीं।', 'err'); return; }
    showData(core.toCSV(), n + ' entry — CSV (Excel/Sheet में paste करो)');
  };
  $('exportJson').onclick = function () {
    showData(core.exportJSON(), 'पूरा backup — इसे सुरक्षित जगह रख लो');
  };
  $('copyOut').onclick = async function () {
    const ok = await copyText($('dataOut').value);
    toast(ok ? '📋 copy हो गया — अब WhatsApp/Email में paste करो' : 'Copy नहीं हुआ — text चुनकर हाथ से copy करो', ok ? 'ok' : 'err', 3500);
  };
  $('restoreBtn').onclick = function () {
    try {
      const r = core.importJSON($('restoreIn').value);
      renderList(); renderLists(); listsInfo(); fillLocalLists(); dbInfo();
      $('restoreIn').value = '';
      toast('♻ ' + r.added + ' नई entry जुड़ीं' + (r.bad ? ', ' + r.bad + ' खराब छोड़ीं' : '') + (r.lists ? ', लिस्ट भी आई' : ''), 'ok', 4000);
    } catch (e) { toast(e.message, 'err', 4000); }
  };

  window.addEventListener('online', function () { setNet(); doSync(true); });
  window.addEventListener('offline', setNet);
  document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'visible' && online()) doSync(true); });
  window.addEventListener('beforeinstallprompt', function (e) { e.preventDefault(); deferredInstall = e; $('installBtn').hidden = false; });
  $('installBtn').onclick = async function () { if (!deferredInstall) return; deferredInstall.prompt(); await deferredInstall.userChoice; deferredInstall = null; $('installBtn').hidden = true; };

  // ---- boot
  (async function boot() {
    if (store.ready) await store.ready();   // local database खुलने तक रुको (पुराना localStorage data अपने-आप आ जाता है)
    // ?api=…&key=… से एक बार settings भर सकते हो (URL फिर साफ़ हो जाता है)
    try {
      const u = new URL(location.href);
      if (u.searchParams.get('api')) core.setApi(u.searchParams.get('api'));
      if (u.searchParams.has('key')) core.setKey(u.searchParams.get('key'));
      if (u.searchParams.get('api') || u.searchParams.has('key')) history.replaceState(null, '', u.pathname);
    } catch (_) { }
    // config.js (optional) से एक बार pre-fill — पहले से कुछ set हो तो उसे नहीं छेड़ता
    try {
      const cfg = root.JCM_CONFIG || {};
      if (!core.getApi() && cfg.api) { core.setApi(cfg.api); core.setKey(cfg.key || ''); }
    } catch (_) { }
    const inApk = /appassets\.androidplatform\.net$/.test(location.hostname);   // Android app (WebView) में चल रहा है
    if (!inApk && 'serviceWorker' in navigator) { navigator.serviceWorker.register('./sw.js').catch(function () { }); }
    setNet();
    modeHints();
    applyQuickRange();
    $('installHint').textContent = inApk ? 'यह installed app है।' : /iPhone|iPad/.test(navigator.userAgent) ? 'iPhone: Safari में Share → "Add to Home Screen"।' : 'Android/Chrome: menu → "Add to Home screen" / "Install app"।';
    $('ver').textContent = APP_VERSION;
    $('date').value = todayLocal();
    renderLists();
    const draft = core.getDraft(); if (draft) loadEntry(draft);
    renderList();
    if (core.getApi() && online()) {
      try { await core.refreshLists(); renderLists(); if (draft) loadEntry(draft); } catch (_) { /* cache से चलेगा */ }
      doSync(true);
    }
    // URL भी नहीं और लिस्ट भी नहीं → पहली बार सेटिंग दिखाओ (लिस्ट भर ली हो तो app सीधे चलेगी)
    if (!core.getApi() && !core.lists()) showView('settings');
  })();
})(typeof window !== 'undefined' ? window : globalThis);
