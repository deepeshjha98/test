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

  const APP_VERSION = '1.0.0';
  const K = { api: 'jcm.api', key: 'jcm.key', lists: 'jcm.lists', queue: 'jcm.queue', draft: 'jcm.draft' };
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
  function fmtDate(iso) {   // 2026-09-08 → 08-09-2026
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso || ''); return m ? m[3] + '-' + m[2] + '-' + m[1] : (iso || '');
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
      clearSent: function () { set(K.queue, core.queue().filter(function (i) { return i.status !== 'sent'; })); }
    };
    return core;
  }

  const api = { createCore: createCore, validate: validate, uuid: uuid, todayLocal: todayLocal, durationText: durationText, fmtDate: fmtDate, APP_VERSION: APP_VERSION };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.JCM = api;

  // =====================================================================================================
  // UI (browser only)
  // =====================================================================================================
  if (typeof document === 'undefined') return;

  const $ = function (id) { return document.getElementById(id); };
  const core = createCore({ storage: localStorage, fetchFn: fetch.bind(root) });
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
      $('labourHint').textContent = 'पहली बार network चाहिए: ⚙ सेटिंग में Web App URL डालकर Test करो।';
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
    $('dur').textContent = (function () { const t = durationText($('start').value, $('finish').value); return t ? 'कुल समय: ' + t : ''; })();
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
    $('nPending').textContent = nP; $('nFailed').textContent = nF; $('nSent').textContent = nS;
    $('badge').textContent = (nP + nF) ? String(nP + nF) : '';
    const box = $('items'); box.innerHTML = '';
    if (!q.length) { box.innerHTML = '<div class="empty">अभी कोई entry नहीं।</div>'; return; }
    q.forEach(function (it) {
      const e = it.entry; const d = document.createElement('div'); d.className = 'item';
      const st = it.status === 'pending' ? 'बाकी' : it.status === 'sent' ? ('Sheet row ' + (it.result && it.result.serial != null ? it.result.serial : '?')) : 'अटकी';
      d.innerHTML =
        '<div class="t"><span>' + esc(fmtDate(e.date)) + ' · ' + esc(e.type) + ' · ' + esc(e.goods) + '</span><span class="st ' + it.status + '">' + esc(st) + '</span></div>' +
        '<div class="s">' + esc(e.start) + '–' + esc(e.finish) + ' · ' + esc(e.bags) + ' बोरा · ' + e.labour.length + ' लेबर: ' + esc(e.labour.join(', ')) + '</div>' +
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
    ['entry', 'list', 'settings'].forEach(function (x) { $('view-' + x).hidden = (x !== v); });
    const tabs = document.querySelectorAll('nav.tabs button');
    tabs.forEach(function (b) { b.className = b.getAttribute('data-view') === v ? 'on' : ''; });
    if (v === 'list') renderList();
    if (v === 'settings') { $('api').value = core.getApi(); $('key').value = core.getKey(); listsInfo(); }
    window.scrollTo(0, 0);
  }
  function listsInfo() {
    const l = core.lists();
    $('listsInfo').textContent = l ? (l.labour.length + ' लेबर, ' + l.goods.length + ' सामान, ' + l.types.length + ' कार्य प्रकार · ' + new Date(l.fetchedAt).toLocaleString('hi-IN')) : 'लिस्ट अभी नहीं आई।';
    $('ver').textContent = APP_VERSION;
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
      toast('✔ Entry save हुई (' + it.entry.labour.length + ' लेबर)' + (online() ? ' — Sheet में भेज रहा है…' : ' — offline, बाद में जाएगी'), 'ok');
      if (online()) {
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

  window.addEventListener('online', function () { setNet(); doSync(true); });
  window.addEventListener('offline', setNet);
  document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'visible' && online()) doSync(true); });
  window.addEventListener('beforeinstallprompt', function (e) { e.preventDefault(); deferredInstall = e; $('installBtn').hidden = false; });
  $('installBtn').onclick = async function () { if (!deferredInstall) return; deferredInstall.prompt(); await deferredInstall.userChoice; deferredInstall = null; $('installBtn').hidden = true; };

  // ---- boot
  (async function boot() {
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
    if (!core.getApi()) showView('settings');
  })();
})(typeof window !== 'undefined' ? window : globalThis);
