/* JCM लोडिंग — db.js : फ़ोन का local database (IndexedDB)

   क्यों: पूरी app बिना किसी server के चल सके, और data localStorage की ~5MB सीमा में न अटके।

   कैसे:
     - असली store IndexedDB है (बहुत बड़ी capacity, browser इसे आसानी से नहीं हटाता)।
     - open() पर पूरा data एक बार memory में आ जाता है → उसके बाद हर read तुरंत (synchronous),
       इसलिए app.js का मौजूदा localStorage-जैसा code ज्यों का त्यों चलता है।
     - हर write: पहले memory, फिर IndexedDB में (क्रम से, एक-एक करके)।
     - IndexedDB न चले (बहुत पुराना WebView / private mode) → अपने-आप localStorage पर लौट जाता है।
     - पहली बार: localStorage में पड़ा पुराना data IndexedDB में migrate हो जाता है (कुछ खोता नहीं)।
*/
(function (root) {
  'use strict';

  var DB_NAME = 'jcm-loading';
  var DB_VERSION = 1;
  var STORE = 'kv';
  var KEYS = ['jcm.api', 'jcm.key', 'jcm.lists', 'jcm.queue', 'jcm.draft'];

  function idb() {
    return root.indexedDB || root.mozIndexedDB || root.webkitIndexedDB || null;
  }

  function openDb() {
    return new Promise(function (resolve, reject) {
      var I = idb();
      if (!I) { reject(new Error('IndexedDB उपलब्ध नहीं')); return; }
      var req;
      try { req = I.open(DB_NAME, DB_VERSION); } catch (e) { reject(e); return; }
      req.onupgradeneeded = function () {
        var db = req.result;
        if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
      };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error || new Error('IndexedDB open fail')); };
      req.onblocked = function () { reject(new Error('IndexedDB blocked')); };
    });
  }

  function idbReadAll(db) {
    return new Promise(function (resolve, reject) {
      var out = {};
      var tx = db.transaction(STORE, 'readonly');
      var st = tx.objectStore(STORE);
      KEYS.forEach(function (k) {
        var r = st.get(k);
        r.onsuccess = function () { if (r.result !== undefined) out[k] = r.result; };
      });
      tx.oncomplete = function () { resolve(out); };
      tx.onerror = function () { reject(tx.error || new Error('IndexedDB read fail')); };
      tx.onabort = function () { reject(tx.error || new Error('IndexedDB read abort')); };
    });
  }

  function idbWrite(db, k, v) {
    return new Promise(function (resolve, reject) {
      var tx = db.transaction(STORE, 'readwrite');
      var st = tx.objectStore(STORE);
      if (v === null) st.delete(k); else st.put(v, k);
      tx.oncomplete = function () { resolve(); };
      tx.onerror = function () { reject(tx.error || new Error('IndexedDB write fail')); };
      tx.onabort = function () { reject(tx.error || new Error('IndexedDB write abort')); };
    });
  }

  // localStorage safe wrappers (private mode में throw कर सकता है)
  function lsGet(k) { try { return root.localStorage.getItem(k); } catch (_) { return null; } }
  function lsSet(k, v) { try { root.localStorage.setItem(k, v); return true; } catch (_) { return false; } }
  function lsDel(k) { try { root.localStorage.removeItem(k); } catch (_) { } }

  function createStore() {
    var mem = {};           // key → string (localStorage जैसा ही format: JSON string)
    var db = null;
    var backend = 'memory'; // 'indexeddb' | 'localstorage' | 'memory'
    var lastError = '';
    var chain = Promise.resolve();   // writes क्रम से चलें
    var readyP = null;

    function persist(k, v) {
      lastError = '';
      if (backend === 'indexeddb' && db) {
        chain = chain.then(function () { return idbWrite(db, k, v); }).catch(function (e) {
          lastError = (e && e.message) || String(e);
          // IndexedDB बीच में टूट जाए तो कम-से-कम localStorage में बचा लो
          if (v === null) lsDel(k); else lsSet(k, v);
        });
        return chain;
      }
      if (backend === 'localstorage') {
        var ok = (v === null) ? (lsDel(k), true) : lsSet(k, v);
        if (!ok) lastError = 'localStorage भर गया — पुरानी entries export करके हटाओ।';
      } else {
        lastError = 'कोई storage उपलब्ध नहीं — data सिर्फ़ इस बार के लिए है।';
      }
      return Promise.resolve();
    }

    var store = {
      // app.js को localStorage जैसा ही interface मिलता है
      getItem: function (k) { return Object.prototype.hasOwnProperty.call(mem, k) ? mem[k] : null; },
      setItem: function (k, v) { mem[k] = String(v); persist(k, String(v)); },
      removeItem: function (k) { delete mem[k]; persist(k, null); },

      backend: function () { return backend; },
      lastError: function () { return lastError; },
      flush: function () { return chain; },

      ready: function () {
        if (readyP) return readyP;
        readyP = (async function () {
          try {
            db = await openDb();
            var rows = await idbReadAll(db);
            backend = 'indexeddb';
            var found = 0;
            KEYS.forEach(function (k) { if (rows[k] != null) { mem[k] = rows[k]; found++; } });
            if (!found) {
              // पहली बार: localStorage में पुराना data हो तो उठा लो
              var moved = 0;
              KEYS.forEach(function (k) {
                var v = lsGet(k);
                if (v != null) { mem[k] = v; persist(k, v); moved++; }
              });
              if (moved) lastError = '';
            }
          } catch (e) {
            // IndexedDB नहीं चला → localStorage पर चलो
            backend = lsSet('jcm.probe', '1') ? 'localstorage' : 'memory';
            lsDel('jcm.probe');
            if (backend === 'localstorage') {
              KEYS.forEach(function (k) { var v = lsGet(k); if (v != null) mem[k] = v; });
            }
            lastError = backend === 'localstorage'
              ? 'IndexedDB नहीं चला, localStorage से काम चल रहा है।'
              : 'कोई storage उपलब्ध नहीं — data save नहीं होगा।';
          }
          return store;
        })();
        return readyP;
      },

      // सेटिंग screen पर दिखाने के लिए (कितनी जगह इस्तेमाल हो रही है)
      estimate: async function () {
        try {
          if (root.navigator && navigator.storage && navigator.storage.estimate) {
            var e = await navigator.storage.estimate();
            return { usage: e.usage || 0, quota: e.quota || 0 };
          }
        } catch (_) { }
        return null;
      },

      bytes: function () {
        var n = 0;
        Object.keys(mem).forEach(function (k) { n += k.length + String(mem[k]).length; });
        return n;
      }
    };
    return store;
  }

  var api = { createStore: createStore, KEYS: KEYS, DB_NAME: DB_NAME };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.JCMDB = api;
})(typeof window !== 'undefined' ? window : globalThis);
