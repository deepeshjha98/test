/* JCM लोडिंग — supa.js : Supabase से cloud backup/sync

   क्यों: Google Sheet हटने के बाद फ़ोन ही इकलौता रिकॉर्ड था। अब हर बदलाव
   अपने-आप Supabase (cloud database) में भी चला जाता है, और नए फ़ोन पर
   साइन-इन करते ही पूरा data वापस आ जाता है। App पूरी तरह offline-first ही
   रहती है — cloud सिर्फ़ नक़ल रखता है, रास्ते में कभी नहीं आता।

   कैसे:
     - Supabase में एक ही table: jcm_kv(k, v jsonb, updated_at) — फ़ोन के
       local store (db.js) का सीधा अक्स, हर key की एक row।
     - हर local लिखाई store के setItem से गुज़रती है → वहीँ hook लगाकर बदली
       key "dirty" सूची में जुड़ती है (यह सूची भी store में ही रहती है, इसलिए
       app बंद होकर खुले तो भी बाक़ी बदलाव याद रहते हैं), और कुछ सेकंड के
       debounce के बाद एक ही POST (upsert) में सब चला जाता है।
     - Pull में हर row का updated_at आख़िरी बार देखे गए (seen) से मिलाया जाता
       है: नया हो और वह key यहाँ dirty न हो, तभी local पर लिखा जाता है।
       dirty key पर हमेशा फ़ोन वाला रूप जीतता है — फ़ोन ही असली बही है।
     - घड़ी का भरोसा नहीं: तुलना सिर्फ़ server के updated_at से होती है,
       फ़ोन के समय से कभी नहीं।
     - पहली बार जोड़ने पर दोनों तरफ़ data हो तो कुछ भी मिटाया नहीं जाता:
       entry/खरीद (id वाली सूचियाँ) id से मिलाकर एक कर दी जाती हैं, बाक़ी
       (दरें, शिफ्ट, लिस्ट) में फ़ोन वाला रहता है — और सब वापस cloud में
       धकेल दिया जाता है।
     - app database को कभी सीधे नहीं छूती: सारा आना-जाना एक ही secure API
       endpoint (Edge Function jcm-sync) से होता है, और वह हर call पर चाबी
       (access token, Bearer) जाँचता है — server पर सिर्फ़ चाबी का hash रखा
       है। कोई email/password/login नहीं; tables पर सीधी पहुँच सबके लिए बंद।
     - jcm.supa* (चाबी वग़ैरह), jcm.api/jcm.key (पुराने Sheet के राज़),
       jcm.draft (अधूरा फ़ॉर्म) और jcm.up* (अपडेट-जाँच) कभी cloud नहीं जाते।
*/
(function (root) {
  'use strict';

  var K_CFG = 'jcm.supa';        // { url, token } — endpoint का पता और app की चाबी
  var K_SEEN = 'jcm.supaSeen';   // { key: updated_at } — आख़िरी बार cloud में इस रूप में देखा था
  var K_DIRTY = 'jcm.supaDirty'; // [key,…] — local में बदला, cloud भेजना बाक़ी
  var K_META = 'jcm.supaMeta';   // { lastSync } — सिर्फ़ दिखाने के लिए
  var TIMEOUT_MS = 20000;
  var DEBOUNCE_MS = 2500;

  // कौन-सी keys cloud जाती हैं: jcm.* सब, सिवाय राज़ और फ़ोन-निजी चीज़ों के।
  // तय allowlist नहीं रखी — नई data-key अपने-आप sync होने लगे (db.js वाला ही सबक़)।
  function syncable(k) {
    if (typeof k !== 'string' || k.indexOf('jcm.') !== 0) return false;
    if (k.indexOf('jcm.supa') === 0) return false;                      // token/खाता
    if (k === 'jcm.api' || k === 'jcm.key') return false;               // पुराने Sheet के राज़
    if (k === 'jcm.draft' || k === 'jcm.probe') return false;           // क्षणिक
    if (k.indexOf('jcm.up') === 0) return false;                        // अपडेट-जाँच की याद
    return true;
  }

  /* टक्कर (दोनों तरफ़ अलग data) पर कुछ भी मिटे नहीं — हर key का अपना जोड़:
     - entry/खरीद: id से union
     - नाम-सूचियाँ: नाम से union (local का क्रम पहले, cloud के नए नाम पीछे)
     बाक़ी keys (दरें, शिफ्ट) में फ़ोन वाला रहता है — वे एक ही मान की सेटिंग
     हैं, दो सूचियों का जोड़ नहीं।                                            */
  function unionArr(a, b, keyOf) {
    var out = (a || []).slice(), have = {};
    out.forEach(function (x) { have[keyOf(x)] = 1; });
    (b || []).forEach(function (x) { var k = keyOf(x); if (k != null && !have[k]) { have[k] = 1; out.push(x); } });
    return out;
  }
  var MERGERS = {
    'jcm.queue': function (L, C) { return unionArr(L, C, function (x) { return x && x.id; }); },
    'jcm.buys': function (L, C) { return unionArr(L, C, function (x) { return x && x.id; }); },
    'jcm.lists': function (L, C) {
      L = L || {}; C = C || {};
      var byName = function (x) { return String(x); };
      return Object.assign({}, C, L, {
        labour: unionArr(L.labour, C.labour, byName),
        goods: unionArr(L.goods, C.goods, byName),
        types: unionArr(L.types, C.types, byName)
      });
    },
    'jcm.buylists': function (L, C) {
      L = L || {}; C = C || {};
      return Object.assign({}, C, L, {
        items: unionArr(L.items, C.items, function (x) { return x && (x.name != null ? String(x.name) : String(x)); }),
        parties: unionArr(L.parties, C.parties, function (x) { return String(x); })
      });
    }
  };

  function createSupa(opts) {
    var storage = opts.storage;
    var fetchFn = opts.fetchFn;
    var now = opts.now || function () { return new Date(); };
    var onApplied = opts.onApplied || function () { };   // pull से कुछ बदला → UI ताज़ा करे
    var onState = opts.onState || function () { };       // हालत बदली → संकेत ताज़ा करे
    var debounceMs = opts.debounceMs != null ? opts.debounceMs : DEBOUNCE_MS;
    var setTimer = opts.setTimer || function (f, ms) { return setTimeout(f, ms); };
    var clearTimer = opts.clearTimer || function (t) { clearTimeout(t); };

    function get(k, d) { try { var v = storage.getItem(k); return v == null ? d : JSON.parse(v); } catch (_) { return d; } }
    function set(k, v) { storage.setItem(k, JSON.stringify(v)); }

    var suppress = false;      // pull का लिखा हुआ फिर dirty न बन जाए
    var timer = null;
    var syncing = false;
    var again = false;         // sync के बीच नई लिखाई आई → ख़त्म होते ही एक बार और
    var problem = '';          // '' | 'auth' | 'net' | 'server' | 'paused'
    var problemText = '';

    /* ---- store पर hook: हर लिखाई यहाँ से गुज़रती है ----
       dirty-निशान value से *पहले* लिखा जाता है: बीच में app मर जाए तो बुरा
       हाल बस इतना कि एक अनबदली key दुबारा भेज दी जाएगी (बेकार पर बेजोखिम)।
       उल्टा क्रम होता तो value लिखने और निशान लगने के बीच मरने पर वह बदलाव
       cloud कभी न पहुँचता — और किसी को पता भी न चलता।                       */
    function attach() {
      var origSet = storage.setItem.bind(storage);
      var origDel = storage.removeItem.bind(storage);
      storage.setItem = function (k, v) { if (!suppress) noteWrite(k); origSet(k, v); if (!suppress) schedulePush(k); };
      storage.removeItem = function (k) { if (!suppress) noteWrite(k); origDel(k); if (!suppress) schedulePush(k); };
    }

    function noteWrite(k) {
      if (!syncable(k) || !supa.enabled()) return;
      var d = get(K_DIRTY, []);
      if (d.indexOf(k) < 0) { d.push(k); set(K_DIRTY, d); }
    }

    function schedulePush(k) {
      if (!syncable(k) || !supa.enabled()) return;
      onState();
      if (timer) clearTimer(timer);
      timer = setTimer(function () { timer = null; supa.syncNow(); }, debounceMs);
    }

    /* ---- HTTP: सब कुछ एक ही endpoint से ----
       POST {url}/functions/v1/jcm-sync, Authorization: Bearer <चाबी>।
       endpoint server पर चाबी का hash मिलाता है — ग़लत/बदली चाबी = 401। */
    function call(body, tmo) {
      var cfg = supa.cfg();
      if (!cfg || !cfg.url || !cfg.token) { var e0 = new Error('auth'); e0.auth = true; return Promise.reject(e0); }
      return rawCall(cfg.url, cfg.token, body, tmo);
    }
    function rawCall(url, token, body, tmo) {
      var ctrl = (typeof AbortController !== 'undefined') ? new AbortController() : null;
      var t = ctrl ? setTimer(function () { ctrl.abort(); }, tmo || TIMEOUT_MS) : null;
      return fetchFn(url.replace(/\/+$/, '') + '/functions/v1/jcm-sync', {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: ctrl ? ctrl.signal : undefined
      }).then(function (res) {
        if (t) clearTimer(t);
        return res.json().catch(function () { return {}; }).then(function (j) {
          if (res.status === 401) { var e = new Error((j && j.error) || 'चाबी ग़लत'); e.auth = true; throw e; }
          if (!res.ok) { var e2 = new Error((j && j.error) || ('HTTP ' + res.status)); e2.res = res; throw e2; }
          return j;
        });
      }, function (e) {
        if (t) clearTimer(t);
        if (e && e.name === 'AbortError') throw new Error('Server ने समय पर जवाब नहीं दिया (timeout)।');
        throw e;
      });
    }

    function setProblem(p, text) { problem = p; problemText = text || ''; onState(); }

    function classify(e, res) {
      if (e && e.auth) { setProblem('auth', 'चाबी नहीं चली (ग़लत या बदल दी गई) — नई चाबी डालो।'); return; }
      if (res && res.status >= 500) {
        setProblem('paused', 'Supabase जवाब नहीं दे रहा (HTTP ' + res.status + ') — free project हफ़्ते भर बंद रहे तो सो जाता है; dashboard खोलते ही जग जाता है।');
        return;
      }
      setProblem('net', 'network नहीं मिला — बदलाव फ़ोन में हैं, network आते ही अपने-आप जाएँगे। (न जाए तो फ़ोन की तारीख़-समय भी जाँच लेना।)');
    }

    // ---- pull: cloud → फ़ोन ----
    function pull() {
      return call({ op: 'pull' }).then(function (j) {
        var rows = (j && j.rows) || [];
        var seen = get(K_SEEN, {});
        var dirty = get(K_DIRTY, []);
        var applied = 0;
        (rows || []).forEach(function (r) {
          if (!r || !syncable(r.k)) return;
          if (seen[r.k] === r.updated_at) return;                    // कुछ नया नहीं
          var incoming = JSON.stringify(r.v);
          var localRaw = storage.getItem(r.k);
          if (dirty.indexOf(r.k) >= 0 || (localRaw != null && !(r.k in seen))) {
            // local बदला हुआ है, या पहली बार दोनों तरफ़ data है → कुछ मिटाओ मत
            if (MERGERS[r.k] && localRaw != null) {
              var merged = mergeWith(MERGERS[r.k], localRaw, incoming);
              if (merged != null && merged !== localRaw) { suppress = true; try { storage.setItem(r.k, merged); } finally { suppress = false; } applied++; }
            }
            // फ़ोन वाला रूप जीतता है — dirty में डाल दो ताकि cloud भी वही हो जाए
            if (dirty.indexOf(r.k) < 0) { dirty.push(r.k); }
            return;
          }
          if (incoming !== localRaw) {
            suppress = true;
            try { storage.setItem(r.k, incoming); } finally { suppress = false; }
            applied++;
          }
          seen[r.k] = r.updated_at;
        });
        set(K_SEEN, seen); set(K_DIRTY, dirty);
        if (applied) onApplied();
        return applied;
      });
    }

    function mergeWith(fn, localRaw, cloudRaw) {
      try { return JSON.stringify(fn(JSON.parse(localRaw), JSON.parse(cloudRaw))); }
      catch (_) { return null; }   // कुछ भी टेढ़ा हो तो जोड़ छोड़ो, local ही रहे
    }

    // ---- push: फ़ोन → cloud ----
    function push() {
      var dirty = get(K_DIRTY, []);
      if (!dirty.length) return Promise.resolve(0);
      var rows = [], gone = [], sentVal = {};
      dirty.forEach(function (k) {
        var raw = storage.getItem(k);
        sentVal[k] = raw;
        if (raw == null) { gone.push(k); return; }                  // key मिटी → cloud से भी मिटाओ
        var v; try { v = JSON.parse(raw); } catch (_) { v = raw; }
        rows.push({ k: k, v: v });
      });
      var p = Promise.resolve();
      if (rows.length) {
        p = p.then(function () {
          return call({ op: 'push', rows: rows }).then(function (j) {
            var seen = get(K_SEEN, {});
            ((j && j.rows) || []).forEach(function (r) { if (r && r.k) seen[r.k] = r.updated_at; });
            set(K_SEEN, seen);
          });
        });
      }
      gone.forEach(function (k) {
        p = p.then(function () {
          return call({ op: 'del', k: k }).then(function () {
            var seen = get(K_SEEN, {});
            delete seen[k]; set(K_SEEN, seen);
          });
        });
      });
      return p.then(function () {
        /* dirty से सिर्फ़ वही key निकालो जिसकी क़ीमत अब भी वही है जो भेजी थी।
           push के बीच वही key फिर बदल जाए तो वह dirty ही रहती है (पुरानी
           क़ीमत cloud गई, नई अगली बारी में) — वरना cloud चुपचाप पुराना रह जाता। */
        var after = get(K_DIRTY, []).filter(function (k) {
          if (dirty.indexOf(k) < 0) return true;                    // push के बीच आई नई key
          return storage.getItem(k) !== sentVal[k];                 // भेजने के बाद फिर बदली
        });
        set(K_DIRTY, after);
        return rows.length + gone.length;
      });
    }

    var supa = {
      attach: attach,
      syncable: syncable,

      cfg: function () { return get(K_CFG, null); },
      enabled: function () { var c = supa.cfg(); return !!(c && c.url && c.token); },

      // पहली बार जोड़ना: चाबी को ping से परखो → save → (merge-सुरक्षित) pull → सब push
      connect: function (url, token) {
        url = String(url || '').trim().replace(/\/+$/, '');
        token = String(token || '').trim();
        var localDev = /^http:\/\/(localhost|127\.0\.0\.1)([:/]|$)/.test(url);   // सिर्फ़ जाँच के लिए
        if (!/^https:\/\//.test(url) && !localDev) return Promise.reject(new Error('Project URL https:// से शुरू होना चाहिए।'));
        if (!token) return Promise.reject(new Error('चाबी खाली है — वही jcm-… वाली चाबी डालो।'));
        return rawCall(url, token, { op: 'ping' }).then(function () {
          set(K_CFG, { url: url, token: token, connectedAt: now().toISOString() });
          setProblem('', '');
          // इस फ़ोन का सब कुछ भेजने के लिए तैयार रखो (pull पहले merge कर लेगा)
          var d = get(K_DIRTY, []);
          allLocalKeys().forEach(function (k) { if (d.indexOf(k) < 0) d.push(k); });
          set(K_DIRTY, d);
          set(K_SEEN, {});
          return supa.syncNow();
        }, function (e) {
          if (e && e.auth) throw new Error('चाबी ग़लत है — वही jcm-… वाली चाबी डालो।');
          throw e;
        });
      },

      // चाबी बदली/मरी हो — नई डालकर वहीं से आगे
      relogin: function (token) {
        var c = supa.cfg();
        if (!c) return Promise.reject(new Error('पहले cloud backup जोड़ो।'));
        token = String(token || '').trim();
        if (!token) return Promise.reject(new Error('चाबी खाली है।'));
        return rawCall(c.url, token, { op: 'ping' }).then(function () {
          c.token = token; set(K_CFG, c);
          setProblem('', '');
          return supa.syncNow();
        }, function (e) {
          if (e && e.auth) throw new Error('यह चाबी भी नहीं चली — Claude से नई चाबी बनवा लो।');
          throw e;
        });
      },

      disconnect: function () {
        storage.removeItem(K_CFG); storage.removeItem(K_SEEN); storage.removeItem(K_DIRTY); storage.removeItem(K_META);
        setProblem('', '');
      },

      // pull फिर push — एक बार में एक ही; बीच में लिखाई आए तो ख़त्म होते ही दुबारा
      syncNow: function () {
        if (!supa.enabled()) return Promise.resolve({ off: true });
        if (syncing) { again = true; return Promise.resolve({ busy: true }); }
        syncing = true;
        return pull().then(function (applied) {
          return push().then(function (pushed) {
            set(K_META, { lastSync: now().toISOString() });
            setProblem('', '');
            return { applied: applied, pushed: pushed };
          });
        }).catch(function (e) {
          classify(e, e && e.res);
          return { error: (e && e.message) || String(e) };
        }).then(function (r) {
          syncing = false;
          if (again) { again = false; return supa.syncNow().then(function () { return r; }); }
          return r;
        });
      },

      kick: function () {   // online/visibility पर हल्का धक्का
        if (supa.enabled()) supa.syncNow();
      },

      state: function () {
        var c = supa.cfg();
        var meta = get(K_META, null);
        return {
          on: supa.enabled(),
          busy: syncing,
          url: c ? c.url : '',
          pending: get(K_DIRTY, []).length,
          lastSync: meta ? meta.lastSync : '',
          problem: problem,
          problemText: problemText
        };
      }
    };

    function allLocalKeys() {
      // db.js store अपनी सारी keys बता देता है; न बता सके तो जानी-पहचानी सूची
      var ks = (typeof storage.keys === 'function') ? storage.keys()
        : ['jcm.queue', 'jcm.buys', 'jcm.buylists', 'jcm.rates', 'jcm.shift', 'jcm.lists'];
      return ks.filter(function (k) { return syncable(k) && storage.getItem(k) != null; });
    }

    return supa;
  }

  var api = { createSupa: createSupa };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.JCMSUPA = api;
})(typeof window !== 'undefined' ? window : globalThis);
