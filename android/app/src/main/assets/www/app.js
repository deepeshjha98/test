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

  const APP_VERSION = '1.20.0';
  const K = { api: 'jcm.api', key: 'jcm.key', lists: 'jcm.lists', queue: 'jcm.queue', draft: 'jcm.draft', shift: 'jcm.shift', rates: 'jcm.rates', buys: 'jcm.buys', buyLists: 'jcm.buylists' };
  const DEFAULT_SHIFT = { start: '08:30', finish: '18:30' };   // मिल का सामान्य समय; ⚙ सेटिंग से बदला जा सकता है
  // पैसे की दरें — ⚙ सेटिंग से बदली जा सकती हैं
  const DEFAULT_RATES = { wage: 50, perSmall: 3, perBig: 3, perBag: 3 };   // ₹/मज़दूर-घंटा, और छोटे/बड़े बोरे की अपनी-अपनी दर

  /* लोडिंग-अनलोडिंग में दो नाप के बोरे होते हैं — छोटा और बड़ा — और दोनों का
     चार्ज अलग। पुरानी entries में सिर्फ़ एक ही गिनती लिखी जाती थी; उन्हें बड़ा
     माना जाता है, और बड़े की दर पुरानी ₹/बोरा से ही शुरू होती है, इसलिए
     upgrade से किसी पुराने हिसाब की रक़म नहीं बदलती।                        */
  function bagSplit(e) {
    const s = Number(e && e.bagsSmall), b = Number(e && e.bagsBig);
    if (isFinite(s) || isFinite(b)) {
      return { small: Math.max(0, isFinite(s) ? s : 0), big: Math.max(0, isFinite(b) ? b : 0) };
    }
    return { small: 0, big: Math.max(0, Number(e && e.bags) || 0) };
  }
  function bagTotal(e) { const x = bagSplit(e); return x.small + x.big; }
  function bagPay(x, rates) { return x.small * rates.perSmall + x.big * rates.perBig; }
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

  /* release के JSON से यह तय करना कि नई build है या नहीं।
     tag "build-9" का 9 ही versionCode है (workflow github.run_number देता है),
     इसलिए तुलना हमेशा पूरे अंक पर होती है — नाम की स्ट्रिंग पर नहीं।   */
  function pickUpdate(rel, currentCode, skipped) {
    if (!rel || typeof rel !== 'object') return null;
    const m = /^build-(\d+)$/.exec(String(rel.tag_name || ''));
    if (!m) return null;
    const code = parseInt(m[1], 10);
    if (!isFinite(code) || !(code > (currentCode || 0))) return null;
    // जिस build को user ने "अभी नहीं" कह दिया, वह फिर नहीं पूछी जाती —
    // पर उससे नई कोई build आए तो पट्टी दुबारा दिखेगी।
    if (code <= (Number(skipped) || 0)) return null;
    const assets = Array.isArray(rel.assets) ? rel.assets : [];
    let apk = null;
    for (let i = 0; i < assets.length; i++) {
      const a = assets[i];
      const u = String((a && a.browser_download_url) || '');
      if (/\.apk$/i.test(String((a && a.name) || '')) &&
          u.indexOf('https://github.com/deepeshjha98/test/releases/download/') === 0) { apk = u; break; }
    }
    if (!apk) return null;
    return { code: code, name: String(rel.name || rel.tag_name), url: apk };
  }

  // ══════════════════════ खरीद का हिसाब (purchase cost) ══════════════════════
  /* एक "खरीद" = एक ट्रक। उसमें एक या कई lines — हर line यानी एक सामान, एक सप्लायर से।
     कुछ सामान बोरे के भाव आता है (चोकर: 35kg बोरा ₹1000), कुछ क्विंटल के (चना ₹7050/क्विं)।
     एक ही सामान अलग-अलग सप्लायर या अलग-अलग वज़न के बोरे में आए तो वे अलग lines हैं।

     ख़र्च दो जगह लगते हैं:
       line के अपने ख़र्च   — उसी सामान के (गद्दी, टैक्स…)
       ट्रक के साझा ख़र्च   — भाड़ा, अनलोडिंग… ये सब lines पर बँटते हैं
     बँटवारा वज़न के अनुपात में होता है (भाड़े का असली आधार वही है), पर
     मूल्य या बोरों के अनुपात में भी किया जा सकता है।                              */

  const EXPENSE_KINDS = ['flat', 'perQuintal', 'perBag', 'percent'];

  /* भाव किस हिसाब से लिखा होता है — चार असली सूरतें:
       bag      ₹/बोरा या ₹/कार्टून   (चोकर ₹1000/बोरा)
       quintal  ₹/क्विंटल             (चना ₹7050/क्विं)
       unit     ₹/पैकेट-पाउच-बोतल      (कभी-कभी पाउच का भाव लिखा होता है)
       lump     एकमुश्त कुल रक़म        (तेल वाला 5 कार्टून का एक साथ ₹15,000 लिखता है)  */
  const RATE_BYS = ['bag', 'quintal', 'unit', 'lump'];

  /* बाहर वाले डिब्बे (बोरा/कार्टून/बैग) और अंदर वाली इकाई (पैकेट/पाउच/बोतल) के लिए
     एक-एक आम बोलचाल का शब्द — पूरी app में यहीं से आता है, इसलिए बदलना हो तो
     सिर्फ़ इन दो लाइनों में बदलेगा।                                            */
  const PACK = 'पैक';
  const UNIT = 'पीस';

  /* सामान तीन ही किस्म का होता है — यही तय करता है कि entry में कौन-से खाने पूछे जाएँ:
       loose  रैंडम वज़न     — हर पैक का वज़न अलग; कुल kg भरा जाता है
       fixed  फिक्स्ड वज़न   — हर पैक बराबर; एक ही सामान दो वज़न में आ सकता है
       child  अंदर पीस      — पैक का वज़न भी तय, और उसके अंदर तय गिनती में पीस  */
  const ITEM_KINDS = ['loose', 'fixed', 'child'];

  function itemKind(x) {
    if (x && ITEM_KINDS.indexOf(x.kind) >= 0) return x.kind;
    // पुराने रिकॉर्ड में किस्म लिखी ही नहीं थी — वज़न/गिनती से पहचानो
    if (Math.max(0, Number(x && x.units) || 0) > 0) return 'child';
    const kgs = x && x.kgs;
    const hasKg = Array.isArray(kgs) ? kgs.length > 0 : /[1-9]/.test(String(kgs || ''));
    return hasKg ? 'fixed' : 'loose';
  }

  // किस किस्म पर भाव के कौन-से तरीक़े का मतलब बनता है
  function ratesForKind(kind) {
    return kind === 'child' ? ['bag', 'quintal', 'unit', 'lump'] : ['bag', 'quintal', 'lump'];
  }

  /* सामान की मास्टर जानकारी। पहले सिर्फ़ नाम रखा जाता था; अब नाम के साथ
     बोरे का वज़न और भाव का तरीक़ा भी, ताकि हर entry में दुबारा न भरना पड़े।
       kgs खाली  → हर बोरे का वज़न कम-ज़्यादा (खल्ली, धान) — कुल kg भरा जाएगा
       kgs में एक → वही वज़न अपने-आप भर जाएगा (चोकर 35, चना 30)
       kgs में कई → एक ही सामान दो पैक में आता है, entry में चुन लेना है     */
  function buyItem(x) {
    if (typeof x === 'string') x = { name: x };
    // अंक ऐसे निकालो कि ऋण-चिह्न साथ रहे — वरना "-5" चुपचाप 5 बन जाता
    const src = Array.isArray(x && x.kgs) ? x.kgs
      : (String((x && x.kgs) || '').match(/-?\d*\.?\d+/g) || []);
    const kgs = [], seen = {};
    src.forEach(function (k) {
      const n = Number(k);
      if (isFinite(n) && n > 0 && !seen[n]) { seen[n] = 1; kgs.push(n); }
    });
    kgs.sort(function (a, b) { return a - b; });
    const kind = itemKind(x);
    const units = Math.max(0, Number(x && x.units) || 0);
    /* किस्म के हिसाब से record साफ़ रखो — रैंडम वज़न वाले पर वज़न, और
       बिना-पीस वाले पर पीस की गिनती पड़ी न रह जाए, वरना किस्म बदलने के बाद
       पुरानी क़ीमत चुपचाप हिसाब में लौट आती।                                */
    const rate = RATE_BYS.indexOf(x && x.rateBy) >= 0 ? x.rateBy : 'bag';
    return {
      name: String((x && x.name) || '').trim(),
      kind: kind,
      kgs: kind === 'loose' ? [] : kgs,
      units: kind === 'child' ? units : 0,
      rateBy: ratesForKind(kind).indexOf(rate) >= 0 ? rate : 'bag'
    };
  }
  function cleanBuyItems(list) {
    const out = [], seen = {};
    (Array.isArray(list) ? list : String(list == null ? '' : list).split('\n')).forEach(function (x) {
      const it = buyItem(x);
      if (!it.name || seen[it.name]) return;
      seen[it.name] = 1; out.push(it);
    });
    return out;
  }
  function findBuyItem(items, name) {
    const n = String(name || '').trim();
    for (let i = 0; i < (items || []).length; i++) if (items[i] && items[i].name === n) return items[i];
    return null;
  }
  function cleanExpList(list) {
    return (Array.isArray(list) ? list : []).map(function (x) {
      return { name: String((x && x.name) || '').trim(),
               kind: EXPENSE_KINDS.indexOf(x && x.kind) >= 0 ? x.kind : 'flat',
               value: Number(x && x.value) || 0 };
    });
  }

  // एक ख़र्च की रक़म — जिस चीज़ पर लग रहा है उसके हिसाब से
  function expenseAmount(ex, ctx) {
    const v = Number(ex && ex.value) || 0;
    const kg = Number(ctx && ctx.kg) || 0;
    const bags = Number(ctx && ctx.bags) || 0;
    const basic = Number(ctx && ctx.basic) || 0;
    switch (ex && ex.kind) {
      case 'perQuintal': return v * (kg / 100);
      case 'perBag': return v * bags;
      case 'percent': return v * basic / 100;
      default: return v;                                  // सीधी रक़म
    }
  }
  function sumExpenses(list, ctx) {
    return (Array.isArray(list) ? list : []).reduce(function (t, ex) { return t + expenseAmount(ex, ctx); }, 0);
  }

  // एक line का वज़न और मूल भाव
  /* वज़न और भाव दो अलग बातें हैं — इन्हें जोड़ना गलत था। चारों हाल असली हैं:

       चोकर          हर बोरा 35kg बराबर          भाव ₹1000 / बोरा
       चना, दाल      हर बोरा 30kg बराबर          भाव ₹7050 / क्विंटल
       खल्ली, धान    कुल वज़न पता, बोरे कम-ज़्यादा   भाव ₹/क्विंटल
       (और चौथा) कुल वज़न पता, भाव बोरे के हिसाब

     इसलिए line पर दो अलग चुनाव रहते हैं:
       weigh  = 'perBag' (बोरे × एक बोरे का kg)  या  'total' (कुल kg सीधा)
       rateBy = 'bag' (₹/बोरा)                    या  'quintal' (₹/क्विंटल)      */

  function lineWeigh(l) {
    // किस्म लिखी हो तो वही तय करती है — रैंडम वज़न माने कुल kg, बाक़ी में पैक × kg
    if (l && ITEM_KINDS.indexOf(l.kind) >= 0) return l.kind === 'loose' ? 'total' : 'perBag';
    if (l && (l.weigh === 'perBag' || l.weigh === 'total')) return l.weigh;
    return (l && l.mode === 'quintal') ? 'total' : 'perBag';      // पुराने रिकॉर्ड
  }
  function lineRateBy(l) {
    if (l && RATE_BYS.indexOf(l.rateBy) >= 0) return l.rateBy;
    return (l && l.mode === 'quintal') ? 'quintal' : 'bag';       // पुराने रिकॉर्ड
  }
  function lineKg(l) {
    if (lineWeigh(l) === 'total') {
      const kg = Math.max(0, Number(l && l.totalKg) || 0);
      if (kg > 0) return kg;
      return Math.max(0, Number(l && l.qtl) || 0) * 100;          // पुराने रिकॉर्ड क्विंटल में थे
    }
    return Math.max(0, Number(l && l.bags) || 0) * Math.max(0, Number(l && l.bagKg) || 0);
  }
  function lineUnitsPer(l) { return Math.max(0, Number(l && l.units) || 0); }
  function lineBase(l) {
    const bags = Math.max(0, Number(l && l.bags) || 0);
    const kg = lineKg(l);
    const rate = Math.max(0, Number(l && l.rate) || 0);
    const units = bags * lineUnitsPer(l);          // कुल छोटे पैकेट (50 बोरे × 16 पाउच)
    let basic;
    switch (lineRateBy(l)) {
      case 'quintal': basic = (kg / 100) * rate; break;
      case 'unit': basic = units * rate; break;
      // एकमुश्त: जो रक़म लिखी है वही कुल है, गिनती से गुणा नहीं होती
      case 'lump': basic = rate; break;
      default: basic = bags * rate;
    }
    return { bags: bags, kg: kg, units: units, basic: basic };
  }

  /* पूरा हिसाब। लौटाता है हर line का असली रेट (₹/क्विंटल और ₹/बोरा) और ट्रक का जोड़। */
  /* पहले सप्लायर हर सामान पर अलग भरा जाता था। पुरानी खरीद खोलने पर उसे नए
     ढाँचे में ले आओ: सब सामान एक ही सप्लायर के हों तो वही ट्रक का सप्लायर बने,
     अलग-अलग हों तो "कई सप्लायर" चालू रहे — कोई जानकारी न खोए।            */
  function normalizeBuyParty(b) {
    const p = Object.assign({}, b || {});
    p.lines = (Array.isArray(p.lines) ? p.lines : []).map(function (l) { return Object.assign({}, l); });
    const seen = {};
    p.lines.forEach(function (l) { const n = String(l.party || '').trim(); if (n) seen[n] = 1; });
    const uniq = Object.keys(seen);
    p.party = String(p.party || '').trim();
    if (!p.party && uniq.length === 1) p.party = uniq[0];
    p.multiParty = !!b && !!b.multiParty || uniq.length > 1 || (uniq.length === 1 && uniq[0] !== p.party);
    if (!p.multiParty) p.lines.forEach(function (l) { l.party = ''; });
    return p;
  }

  function purchaseCalc(p) {
    p = p || {};
    const basis = (p.basis === 'value' || p.basis === 'bags') ? p.basis : 'weight';
    /* सप्लायर आम तौर पर पूरे ट्रक का एक ही होता है, इसलिए वह ट्रक पर रखा जाता है।
       कभी-कभार (50-60 में एक गाड़ी) माल कई सप्लायर से आता है — तब line पर भरा
       सप्लायर ट्रक वाले को हरा देता है।                                          */
    const truckParty = String(p.party || '').trim();
    const rows = (Array.isArray(p.lines) ? p.lines : []).map(function (l) {
      const b = lineBase(l);
      const lineExp = sumExpenses(l && l.expenses, b);
      return {
        item: (l && l.item) || '', party: (l && l.party) || truckParty,
        weigh: lineWeigh(l), rateBy: lineRateBy(l),
        kind: lineWeigh(l) === 'total' ? 'loose' : (lineUnitsPer(l) > 0 ? 'child' : 'fixed'),
        packName: PACK, unitName: UNIT, unitsPer: lineUnitsPer(l),
        bags: b.bags, kg: b.kg, qtl: b.kg / 100, units: b.units, rate: Number(l && l.rate) || 0,
        basic: b.basic, lineExp: lineExp, partyExp: 0, value: b.basic + lineExp,
        share: 0, total: 0, perKg: null, perQuintal: null, perBag: null, perUnit: null
      };
    });

    /* ख़र्च का बँटवारा — किसी हिस्से के जोड़ पर ख़र्च लगाकर उसी हिस्से की
       lines में बाँटना। आधार शून्य हो (वज़न भरा ही न हो) तो बराबर-बराबर,
       ताकि ख़र्च कहीं गुम न हो।                                        */
    /* वज़न के आधार पर बाँटते समय जिस line का वज़न ही नहीं (तेल के कार्टून),
       उसे शून्य हिस्सा मिलता और उसका असली रेट कम दिखता। इसलिए ऐसी line पर
       चुपचाप बोरों/कार्टून की गिनती को आधार मान लिया जाता है।              */
    /* एक ही ट्रक में कुछ सामान का वज़न हो और कुछ का नहीं (अनाज + तेल के पैक), तो
       kg और पैक की गिनती एक ही हर में जुड़ जाते — वह बेमानी है और तेल पर भाड़ा
       लगभग शून्य गिरता। ऐसे में मूल्य के आधार पर बाँटना ही ईमानदार है।
       जब किसी का भी वज़न न हो, तब गिनती ही सही आधार है।                      */
    const someKg = rows.some(function (r) { return r.kg > 0; });
    const noKg = rows.some(function (r) { return !(r.kg > 0); });
    const mixedWeight = basis === 'weight' && someKg && noKg;
    const useBasis = mixedWeight ? 'value' : basis;
    const weightOf = function (r) {
      if (useBasis === 'value') return r.basic + r.lineExp;
      if (useBasis === 'bags') return r.bags;
      return r.kg > 0 ? r.kg : r.bags;
    };
    function spread(group, amount, into) {
      const tw = group.reduce(function (t, r) { return t + weightOf(r); }, 0);
      group.forEach(function (r) {
        r[into] = tw > 0 ? amount * weightOf(r) / tw : (group.length ? amount / group.length : 0);
      });
    }

    /* सप्लायर के ख़र्च — गद्दी, टैक्स वगैरह किसी एक सामान पर नहीं लगते,
       उस सप्लायर के पास से आए सारे सामान पर लगते हैं। इसलिए उसी सप्लायर की
       lines का जोड़ निकालकर ख़र्च उन्हीं में बाँटा जाता है।
       एक-सप्लायर वाले ट्रक में (आम हाल) यह एक ही ढेर बनता है।           */
    const pex = (p.partyExpenses && typeof p.partyExpenses === 'object') ? p.partyExpenses : {};
    const groups = {};
    rows.forEach(function (r) { (groups[r.party] || (groups[r.party] = [])).push(r); });
    let partyExpTotal = 0;
    Object.keys(groups).forEach(function (name) {
      const g = groups[name];
      const gt = g.reduce(function (t, r) {
        t.bags += r.bags; t.kg += r.kg; t.basic += r.basic; return t;
      }, { bags: 0, kg: 0, basic: 0 });
      const amt = sumExpenses(pex[name], gt);
      partyExpTotal += amt;
      spread(g, amt, 'partyExp');
    });
    rows.forEach(function (r) { r.value = r.basic + r.lineExp + r.partyExp; });

    const tot = rows.reduce(function (t, r) {
      t.bags += r.bags; t.kg += r.kg; t.units += r.units;
      t.basic += r.basic; t.lineExp += r.lineExp; t.value += r.value; return t;
    }, { bags: 0, kg: 0, units: 0, basic: 0, lineExp: 0, value: 0 });

    // साझा ख़र्च — भाड़ा, अनलोडिंग… ये पूरे ट्रक के जोड़ पर लगते हैं
    const tripExp = sumExpenses(p.expenses, { kg: tot.kg, bags: tot.bags, basic: tot.basic });
    spread(rows, tripExp, 'share');
    rows.forEach(function (r) {
      r.total = r.value + r.share;
      if (r.kg > 0) { r.perKg = r.total / r.kg; r.perQuintal = r.perKg * 100; }
      if (r.bags > 0) r.perBag = r.total / r.bags;
      if (r.units > 0) r.perUnit = r.total / r.units;     // ₹ प्रति पाउच/पैकेट/बोतल
    });

    const grand = tot.value + tripExp;
    return {
      basis: basis, basisUsed: useBasis, mixedWeight: mixedWeight, lines: rows,
      bags: tot.bags, kg: tot.kg, qtl: tot.kg / 100, units: tot.units,
      basic: tot.basic, lineExp: tot.lineExp, partyExp: partyExpTotal, tripExp: tripExp, total: grand,
      perKg: tot.kg > 0 ? grand / tot.kg : null,
      perQuintal: tot.kg > 0 ? (grand / tot.kg) * 100 : null
    };
  }

  // server जैसी ही validation (server authoritative है; यह user को तुरंत बताने के लिए)
  function validate(e, lists) {
    e = e || {};
    if (!/^\d{4}-\d{2}-\d{2}$/.test(e.date || '')) return 'दिनांक भरो।';
    if (!e.type) return 'कार्य प्रकार चुनो।';
    if (!e.goods) return 'सामान का प्रकार चुनो।';
    const T = /^\d{2}:\d{2}$/;
    if (!T.test(e.start || '') || !T.test(e.finish || '')) return 'स्टार्ट और फिनिश टाइम दोनों भरो।';
    const whole = function (v) { return v === '' || v === undefined || v === null || /^\d+$/.test(String(v)); };
    if (e.bagsSmall !== undefined || e.bagsBig !== undefined) {
      if (!whole(e.bagsSmall)) return 'छोटे बोरे की गिनती पूरा अंक में भरो।';
      if (!whole(e.bagsBig)) return 'बड़े बोरे की गिनती पूरा अंक में भरो।';
      if (bagTotal(e) <= 0) return 'छोटे या बड़े, कोई एक गिनती भरो।';
    } else if (!/^\d+$/.test(String(e.bags === undefined || e.bags === null ? '' : e.bags))) {
      return 'कुल बोरा पूरा अंक में भरो।';
    }
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

    /* भेजी हुई entries की एक हद तक ही नक़ल रखी जाती है — पर यह तभी सुरक्षित है
       जब Sheet में असली रिकॉर्ड मौजूद हो। सिर्फ़-फ़ोन वाले मोड में फ़ोन ही इकलौता
       रिकॉर्ड है, इसलिए वहाँ कुछ भी अपने-आप नहीं मिटता।                        */
    function prune(q) {
      if (core.localOnly()) return;
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
      /* Google Sheet बंद — URL और key हटते ही app सिर्फ़ फ़ोन पर चलती है।
         entries कहीं नहीं जातीं, पर जो पहले जा चुकी हैं वे Sheet में पड़ी रहती हैं
         (यहाँ से कुछ मिटाया नहीं जाता)। दुबारा URL डालते ही सब लौट आता है।     */
      disableSheet: function () {
        set(K.api, ''); set(K.key, '');
        return true;
      },
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
          bagsSmall: bagSplit(entry).small, bagsBig: bagSplit(entry).big,
          bags: String(bagTotal(entry)),     // कुल — Sheet, CSV और रिपोर्ट इसी को पढ़ते हैं
          labour: entry.labour.slice()
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
      /* पहले "भेजी हुई" entry फ़ोन से हटती ही नहीं थी (सोच यह थी कि Sheet ही सच है)।
         नतीजा — गलती सुधारने का कोई रास्ता नहीं बचता था, और Sheet बंद करने पर तो
         वह entry हमेशा के लिए जमकर बैठ जाती। अब हर entry हटाई जा सकती है; Sheet
         की row वहीं रहती है और UI उसी की चेतावनी देता है।                       */
      remove: function (id) {
        const q = core.queue(); const i = q.findIndex(function (x) { return x.id === id; });
        if (i < 0) return false;
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

      /* एक entry पर इंसेंटिव का हिसाब — entry भरते समय और सूची में दिखाने के लिए।
         total     = ₹perBag × बोरे            (जो लेबरों में बँटता है)
         perLabour = वही ÷ कितने लेबर          (हर आदमी के हिस्से)
         wage      = उसी काम पर लगी दिहाड़ी    (सिर्फ़ काम के घंटों वाले हिस्से पर)
         net       = total − wage              (दिहाड़ी काटकर शुद्ध)                */
      incentive: function (start, finish, bags, labourCount) {
        const rates = core.getRates();
        const sp = splitShift(start, finish, core.getShift());
        const n = Math.max(0, Number(labourCount) || 0);
        // bags सीधा अंक हो (पुराना तरीक़ा — बड़ा माना जाता है), {small,big} हो, या पूरी entry — तीनों चलते हैं
        const x = (bags && typeof bags === 'object') ? bagSplit(bags) : { small: 0, big: Math.max(0, Number(bags) || 0) };
        const total = bagPay(x, rates);
        const wage = rates.wage * (sp.work * n) / 60;
        return { total: total, perLabour: n ? total / n : 0, wage: wage, net: total - wage,
                 bags: x, bagCount: x.small + x.big, split: sp };
      },

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
          r.bags += bagTotal(e);
          r.totalMin += sp.total; r.workMin += sp.work; r.otMin += sp.ot;
          r.manMin += sp.total * n; r.manWorkMin += sp.work * n; r.manOtMin += sp.ot * n;

          (e.labour || []).forEach(function (nm) { bucket(byName, nm, sp, 1); });   // हर लेबर को पूरा समय
          bucket(byDay, e.date, sp, 1).bags += bagTotal(e);
          bucket(byType, e.type, sp, 1).bags += bagTotal(e);
          bucket(byGoods, e.goods, sp, 1).bags += bagTotal(e);
        });

        const byOt = function (a, b) { return (b.otMin - a.otMin) || (b.totalMin - a.totalMin) || a.name.localeCompare(b.name); };
        r.labour = Object.keys(byName).map(function (k) { return byName[k]; }).sort(byOt);
        r.types  = Object.keys(byType).map(function (k) { return byType[k]; }).sort(byOt);
        r.goods  = Object.keys(byGoods).map(function (k) { return byGoods[k]; }).sort(byOt);
        r.days   = Object.keys(byDay).map(function (k) { return byDay[k]; }).sort(function (a, b) { return b.name.localeCompare(a.name); });
        return r;
      },

      /* उत्पादकता: एक बोरा पर कितनी मेहनत — काम के घंटों में बनाम ओवरटाइम में?

         माप = मज़दूर-मिनट प्रति बोरा  (समय × कितने लेबर लगे) ÷ बोरे
         कम = बेहतर। लेबर की गिनती इसलिए जोड़ी कि 2 लेबर से 1 घंटा और
         4 लेबर से 1 घंटा — मेहनत बराबर नहीं है।

         ज़रूरी: entry में यह नहीं लिखा होता कि कितने बोरे 18:30 से पहले उठे और
         कितने बाद में। इसलिए मिली-जुली entries (जो खिड़की के आर-पार फैली हैं)
         को सीधी तुलना से बाहर रखा जाता है — वरना "बोरे बराबर रफ़्तार से उठे"
         मान लेना पड़ता, और तब दोनों रफ़्तारें अपने-आप बराबर निकलतीं (गोल हिसाब)।
         उन्हें अलग से least squares में जोड़ा जाता है — नीचे fit देखो।             */
      productivity: function (from, to) {
        const shift = core.getShift();
        const items = core.queue().filter(function (it) {
          const d = it.entry && it.entry.date;
          if (!d) return false;
          if (from && d < from) return false;
          if (to && d > to) return false;
          return bagTotal(it.entry) > 0 && (it.entry.labour || []).length > 0;
        });

        const blank = function () { return { entries: 0, bags: 0, min: 0, labourMin: 0, perBag: null, bagsPerLabourHour: null }; };
        const B = { work: blank(), ot: blank(), mixed: blank() };
        // least squares के जोड़ (मिली-जुली entries भी शामिल)
        let sAA = 0, sCC = 0, sAC = 0, sAB = 0, sCB = 0, nFit = 0;

        items.forEach(function (it) {
          const e = it.entry;
          const sp = splitShift(e.start, e.finish, shift);
          if (!sp.total) return;
          const n = e.labour.length, bags = bagTotal(e);     // रफ़्तार में छोटा+बड़ा जोड़कर
          const b = sp.ot === 0 ? B.work : sp.work === 0 ? B.ot : B.mixed;
          b.entries++; b.bags += bags; b.min += sp.total; b.labourMin += sp.total * n;

          const A = n * sp.work, C = n * sp.ot;      // मज़दूर-मिनट, दोनों हिस्सों में
          sAA += A * A; sCC += C * C; sAC += A * C; sAB += A * bags; sCB += C * bags; nFit++;
        });

        ['work', 'ot', 'mixed'].forEach(function (k) {
          const b = B[k];
          if (b.bags > 0) {
            b.perBag = b.labourMin / b.bags;                    // मज़दूर-मिनट प्रति बोरा
            b.bagsPerLabourHour = b.bags / (b.labourMin / 60);  // बोरा प्रति मज़दूर-घंटा
          }
        });

        // सीधी तुलना — सिर्फ़ साफ़ ढेरों से
        const cmp = { ok: false, diffPct: 0, verdict: '', slower: '', byPct: 0, enough: false };
        if (B.work.perBag && B.ot.perBag) {
          cmp.ok = true;
          cmp.diffPct = Math.round((B.ot.perBag - B.work.perBag) * 100 / B.work.perBag);
          cmp.verdict = Math.abs(cmp.diffPct) < 5 ? 'same' : (cmp.diffPct > 0 ? 'ot-slower' : 'ot-faster');
          // "कितना धीमा" हमेशा तेज़ वाले की तुलना में — दोनों दिशाओं में एक जैसा पढ़ा जाए
          if (cmp.verdict === 'ot-slower') { cmp.slower = 'ot'; cmp.byPct = Math.round((B.ot.perBag - B.work.perBag) * 100 / B.work.perBag); }
          else if (cmp.verdict === 'ot-faster') { cmp.slower = 'work'; cmp.byPct = Math.round((B.work.perBag - B.ot.perBag) * 100 / B.ot.perBag); }
          else { cmp.slower = 'same'; cmp.byPct = 0; }
          cmp.enough = B.work.entries >= 5 && B.ot.entries >= 5;   // इससे कम पर नतीजा डगमगाता है
        }

        /* least squares: बोरे = x·(मज़दूर-मिनट काम में) + y·(मज़दूर-मिनट OT में)
           x, y = बोरा प्रति मज़दूर-मिनट। मिली-जुली entries भी काम आती हैं।       */
        const fit = { ok: false, workPerBag: 0, otPerBag: 0, n: nFit };
        const det = sAA * sCC - sAC * sAC;
        if (nFit >= 4 && det > 1e-6 && sAA > 0 && sCC > 0) {
          const x = (sCC * sAB - sAC * sCB) / det;
          const y = (sAA * sCB - sAC * sAB) / det;
          if (x > 1e-9 && y > 1e-9) { fit.ok = true; fit.workPerBag = 1 / x; fit.otPerBag = 1 / y; }
        }

        return { shift: shift, buckets: B, compare: cmp, fit: fit, total: items.length };
      },

      getRates: function () {
        const v = get(K.rates, null);
        if (!v || !isFinite(v.wage) || v.wage < 0) return DEFAULT_RATES;
        /* पुरानी सेटिंग में एक ही ₹/बोरा था — दोनों नापों की दर वहीं से शुरू होती है,
           इसलिए upgrade के बाद हिसाब ज्यों का त्यों रहता है।                      */
        const s = isFinite(v.perSmall) ? v.perSmall : v.perBag;
        const b = isFinite(v.perBig) ? v.perBig : v.perBag;
        if (!isFinite(s) || !isFinite(b) || s < 0 || b < 0) return DEFAULT_RATES;
        return { wage: v.wage, perSmall: s, perBig: b, perBag: b };
      },
      /* तीसरी दलील न दो तो दोनों नापों की दर एक ही मानी जाती है — यही पुराना
         तरीक़ा था, और जिन मिलों में फ़र्क़ नहीं है उनके लिए अब भी ठीक है।     */
      setRates: function (wage, perSmall, perBig) {
        if (perBig === undefined || perBig === null || perBig === '') perBig = perSmall;
        const w = Number(wage), s = Number(perSmall), b = Number(perBig);
        if (!isFinite(w) || w < 0) throw new Error('दिहाड़ी की दर अंक में भरो (₹ प्रति मज़दूर-घंटा)।');
        if (!isFinite(s) || s < 0) throw new Error('छोटे बोरे की दर अंक में भरो।');
        if (!isFinite(b) || b < 0) throw new Error('बड़े बोरे की दर अंक में भरो।');
        const v = { wage: w, perSmall: s, perBig: b, perBag: b };
        set(K.rates, v);
        return v;
      },

      /* पैसे का हिसाब — मिल की लागत और लेबर की कमाई, दोनों तरफ़ से।

         मिल का ख़र्च एक entry पर:
           दिहाड़ी  = ₹wage × मज़दूर-घंटे  — पर सिर्फ़ काम के घंटों वाले हिस्से पर
                     (ओवरटाइम में दिहाड़ी नहीं लगती)
           बोरा-दर = ₹perBag × बोरे        — हमेशा, दोनों हिस्सों में

         लेबर की कमाई उसी सिक्के का दूसरा पहलू है:
           काम के घंटों में = दिहाड़ी (जो वैसे भी मिलती) + बोरा-दर का हिस्सा
           ओवरटाइम में      = सिर्फ़ बोरा-दर का हिस्सा
         इसीलिए ओवरटाइम में जल्दी ख़त्म करने का दबाव है, काम के घंटों में नहीं —
         यह हिसाब उसी शक़ को नापता है।                                            */
      money: function (from, to) {
        const rates = core.getRates();
        const shift = core.getShift();
        const items = core.queue().filter(function (it) {
          const d = it.entry && it.entry.date;
          if (!d) return false;
          if (from && d < from) return false;
          if (to && d > to) return false;
          return bagTotal(it.entry) > 0 && (it.entry.labour || []).length > 0;
        });

        const blank = function () {
          return { entries: 0, bags: 0, labourMin: 0, workLabourMin: 0, otLabourMin: 0,
                   wage: 0, piece: 0, cost: 0, costPerBag: null, earnPerLabourHour: null, piecePerLabourHour: null,
                   net: 0, netPerBag: null, netPerLabourHour: null };
        };
        const B = { work: blank(), ot: blank(), mixed: blank(), all: blank() };

        items.forEach(function (it) {
          const e = it.entry;
          const sp = splitShift(e.start, e.finish, shift);
          if (!sp.total) return;
          const n = e.labour.length, x = bagSplit(e), bags = x.small + x.big;
          const wLM = sp.work * n, oLM = sp.ot * n;
          const wage = rates.wage * wLM / 60;     // दिहाड़ी सिर्फ़ काम के घंटों वाले हिस्से पर
          const piece = bagPay(x, rates);         // छोटे और बड़े की अपनी-अपनी दर
          const key = sp.ot === 0 ? 'work' : sp.work === 0 ? 'ot' : 'mixed';
          [B[key], B.all].forEach(function (b) {
            b.entries++; b.bags += bags; b.labourMin += sp.total * n;
            b.workLabourMin += wLM; b.otLabourMin += oLM;
            b.wage += wage; b.piece += piece; b.cost += wage + piece;
          });
        });

        ['work', 'ot', 'mixed', 'all'].forEach(function (k) {
          const b = B[k];
          // दिहाड़ी काटकर शुद्ध इंसेंटिव: जो बोरा-दर दी, उसमें से उसी काम पर लगी दिहाड़ी घटाकर।
          // ओवरटाइम में दिहाड़ी शून्य है, इसलिए वहाँ पूरा इंसेंटिव शुद्ध रहता है।
          // काम के घंटों में यह ऋणात्मक भी हो सकता है — मतलब इंसेंटिव उस समय की दिहाड़ी तक नहीं ढँकता।
          b.net = b.piece - b.wage;
          if (b.bags > 0) { b.costPerBag = b.cost / b.bags; b.netPerBag = b.net / b.bags; }
          if (b.labourMin > 0) {
            b.earnPerLabourHour = b.cost / (b.labourMin / 60);      // लेबर को कुल कितना, प्रति मज़दूर-घंटा
            b.piecePerLabourHour = b.piece / (b.labourMin / 60);    // उसमें से सिर्फ़ बोरा-दर वाला हिस्सा
            b.netPerLabourHour = b.net / (b.labourMin / 60);        // दिहाड़ी काटकर, प्रति मज़दूर-घंटा
          }
        });

        /* सुस्ती की क़ीमत: अगर काम के घंटों वाला काम भी ओवरटाइम की रफ़्तार से होता
           तो कितने मज़दूर-घंटे बचते, और उनकी दिहाड़ी कितने की थी।
           मानक = सिर्फ़ पूरी तरह OT वाली entries की रफ़्तार (साफ़ तुलना)।        */
        const waste = { ok: false, excessLabourMin: 0, rupees: 0, otPerBag: 0, workPerBag: 0 };
        const pw = B.work, po = B.ot;
        if (pw.bags > 0 && po.bags > 0 && po.labourMin > 0) {
          waste.otPerBag = po.labourMin / po.bags;
          waste.workPerBag = pw.labourMin / pw.bags;
          waste.excessLabourMin = pw.labourMin - pw.bags * waste.otPerBag;
          waste.rupees = (waste.excessLabourMin / 60) * rates.wage;
          waste.ok = true;
        }

        return { rates: rates, shift: shift, buckets: B, waste: waste, total: items.length };
      },

      // ---------- खरीद (purchase) ----------
      buyLists: function () {
        const v = get(K.buyLists, null);
        // पुरानी सूची सिर्फ़ नामों की थी — पढ़ते समय नए ढाँचे में आ जाती है
        return { items: cleanBuyItems((v && v.items) || []), parties: (v && v.parties) || [] };
      },
      setBuyLists: function (items, parties) {
        const v = { items: cleanBuyItems(items), parties: cleanNames(parties) };
        set(K.buyLists, v);
        return v;
      },

      buys: function () { return get(K.buys, []); },

      /* खरीद save — नई हो तो id मिलती है, पुरानी हो तो जगह पर बदल जाती है।
         हिसाब यहीं जमाकर रख लिया जाता है ताकि बाद में दरें बदलें तो भी
         पुरानी खरीद का रिकॉर्ड वही रहे जो उस दिन था।                      */
      saveBuy: function (b) {
        if (!b || !Array.isArray(b.lines) || !b.lines.length) throw new Error('कम से कम एक सामान डालो।');
        const calc = purchaseCalc(b);
        // तेल/सूजी जैसे सामान का वज़न लिखा ही नहीं होता — तब कार्टून की गिनती काफ़ी है
        if (!(calc.kg > 0) && !(calc.bags > 0)) throw new Error('वज़न भरो, या बोरे/कार्टून की गिनती।');
        const clean = {
          id: b.id || uuid(),
          date: b.date || todayLocal(now()),
          vehicle: String(b.vehicle || '').trim(),
          party: String(b.party || '').trim(),
          multiParty: !!b.multiParty,
          basis: calc.basis,
          lines: b.lines.map(function (l) {
            return {
              item: String(l.item || '').trim(), party: String(l.party || '').trim(),
              weigh: lineWeigh(l), rateBy: lineRateBy(l),
              kind: lineWeigh(l) === 'total' ? 'loose' : (lineUnitsPer(l) > 0 ? 'child' : 'fixed'),
              units: lineUnitsPer(l),
              bags: Number(l.bags) || 0, bagKg: Number(l.bagKg) || 0, totalKg: lineWeigh(l) === 'total' ? lineKg(l) : 0,
              rate: Number(l.rate) || 0,
              expenses: cleanExpList(l.expenses)
            };
          }),
          expenses: cleanExpList(b.expenses),
          partyExpenses: (function () {
            const src = (b.partyExpenses && typeof b.partyExpenses === 'object') ? b.partyExpenses : {};
            const out = {};
            // खाली ढेर सहेजने का कोई मतलब नहीं — form उन्हें ज़रूरत पड़ने पर बना देता है
            Object.keys(src).forEach(function (k) {
              const arr = cleanExpList(src[k]);
              if (arr.length) out[k] = arr;
            });
            return out;
          })(),
          savedAt: now().toISOString()
        };
        const all = core.buys();
        const i = all.findIndex(function (x) { return x.id === clean.id; });
        if (i >= 0) all[i] = clean; else all.unshift(clean);
        all.sort(function (a, b2) { return String(b2.date).localeCompare(String(a.date)) || String(b2.savedAt).localeCompare(String(a.savedAt)); });
        set(K.buys, all);
        return clean;
      },

      removeBuy: function (id) {
        const all = core.buys();
        const i = all.findIndex(function (x) { return x.id === id; });
        if (i < 0) return false;
        all.splice(i, 1); set(K.buys, all); return true;
      },

      calcBuy: function (b) { return purchaseCalc(b); },

      /* किसी सामान का औसत खरीद रेट — कई ट्रकों को जोड़कर।
         हर line का अपना रेट अलग हो सकता है, इसलिए औसत वज़न के भार से निकाला जाता है। */
      buyRates: function (from, to) {
        const byItem = {};
        core.buys().forEach(function (b) {
          if (from && b.date < from) return;
          if (to && b.date > to) return;
          purchaseCalc(b).lines.forEach(function (r) {
            // बिना वज़न वाला सामान (तेल के पैक) भी गिना जाए — पहले छूट जाता था
            if (!(r.kg > 0) && !(r.bags > 0)) return;
            /* एक ही सामान अलग-अलग नाप के पैक में आता हो (चना 30kg और 50kg) तो
               उन्हें एक पंक्ति में जोड़ना गलत होगा — ₹/पैक दो अलग चीज़ों का औसत बन
               जाता। इसलिए हर नाप की अपनी पंक्ति; नाम वही रहता है।              */
            const packKg = (r.kind !== 'loose' && r.bags > 0 && r.kg > 0)
              ? Math.round((r.kg / r.bags) * 1000) / 1000 : 0;
            const nm = r.item || '(बिना नाम)';
            const k = nm + '\u0000' + packKg + '\u0000' + r.unitsPer;
            const e = byItem[k] || (byItem[k] = { item: nm, packKg: packKg, unitsPer: r.unitsPer,
                                                 kg: 0, bags: 0, units: 0, total: 0, lines: 0,
                                                 parties: {}, history: [] });
            e.kg += r.kg; e.bags += r.bags; e.units += r.units; e.total += r.total; e.lines++;
            if (r.party) e.parties[r.party] = true;
            /* हर खरीद अपने-आप में एक रिकॉर्ड — औसत में घुलकर ग़ायब न हो जाए।
               नया माल नए भाव पर आए तो वह भाव अलग से दिखना चाहिए।           */
            e.history.push({ date: b.date, savedAt: b.savedAt || '', vehicle: b.vehicle || '', party: r.party,
                             kg: r.kg, qtl: r.kg / 100, bags: r.bags, units: r.units, total: r.total,
                             perQuintal: r.perQuintal, perBag: r.perBag, perUnit: r.perUnit });
          });
        });
        return Object.keys(byItem).map(function (k) {
          const e = byItem[k];
          // नई खरीद पहले — तारीख़ बराबर हो तो जो बाद में दर्ज हुई वह ऊपर
          e.history.sort(function (a, b2) {
            return String(b2.date).localeCompare(String(a.date)) ||
                   String(b2.savedAt).localeCompare(String(a.savedAt));
          });
          const last = e.history[0] || null;
          return { item: e.item, packKg: e.packKg, unitsPer: e.unitsPer,
                   lines: e.lines, kg: e.kg, qtl: e.kg / 100, bags: e.bags, units: e.units,
                   total: e.total, packName: PACK, unitName: UNIT,
                   /* दिखाने वाला भाव = सबसे ताज़ा खरीद का, औसत का नहीं।
                      औसत भी साथ रहता है (avg*) पर वह मुख्य आँकड़ा नहीं।     */
                   perQuintal: last ? last.perQuintal : null,
                   perBag: last ? last.perBag : null,
                   perUnit: last ? last.perUnit : null,
                   lastDate: last ? last.date : '',
                   avgPerQuintal: e.kg > 0 ? e.total / (e.kg / 100) : null,
                   avgPerBag: e.bags > 0 ? e.total / e.bags : null,
                   avgPerUnit: e.units > 0 ? e.total / e.units : null,
                   history: e.history,
                   parties: Object.keys(e.parties).sort() };
        }).sort(function (a, b2) { return b2.total - a.total; });
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
                      'काम के घंटे', 'ओवरटाइम', 'छोटा बोरा', 'बड़ा बोरा', 'कुल बोरा',
                      'लेबर संख्या', 'लेबर', 'लेबर-घंटे (काम)', 'लेबर-घंटे (OT)',
                      'स्थिति', 'बनाई गई', 'Sheet row'];
        const rows = core.queue().slice().reverse().map(function (it, i) {
          const e = it.entry;
          const sp = splitShift(e.start, e.finish, sh);
          const n = e.labour.length;
          return [i + 1, e.date, e.type, e.goods, e.start, e.finish, hhmm(sp.total),
                  hhmm(sp.work), hhmm(sp.ot), bagSplit(e).small, bagSplit(e).big, bagTotal(e),
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

  const api = { createCore: createCore, bagSplit: bagSplit, bagTotal: bagTotal, DEFAULT_RATES: DEFAULT_RATES, validate: validate, uuid: uuid, todayLocal: todayLocal, durationText: durationText, fmtDate: fmtDate, cleanNames: cleanNames, pickUpdate: pickUpdate, normalizeBuyParty: normalizeBuyParty, RATE_BYS: RATE_BYS, ITEM_KINDS: ITEM_KINDS, itemKind: itemKind, ratesForKind: ratesForKind, PACK: PACK, UNIT: UNIT, buyItem: buyItem, cleanBuyItems: cleanBuyItems, findBuyItem: findBuyItem, lineWeigh: lineWeigh, lineRateBy: lineRateBy, lineKg: lineKg, purchaseCalc: purchaseCalc, expenseAmount: expenseAmount, EXPENSE_KINDS: EXPENSE_KINDS, splitShift: splitShift, hhmm: hhmm, DEFAULT_SHIFT: DEFAULT_SHIFT, APP_VERSION: APP_VERSION };
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
    $('inc').textContent = (function () {
      const x = { small: Number($('bagsSmall').value) || 0, big: Number($('bagsBig').value) || 0 };
      const bags = x.small + x.big;
      const n = Object.keys(selLabour).filter(function (y) { return selLabour[y]; }).length;
      if (!bags || !n) return '';
      const I = core.incentive($('start').value, $('finish').value, { bagsSmall: x.small, bagsBig: x.big }, n);
      const sp2 = core.split($('start').value, $('finish').value);
      let t = bags + ' बोरा (छोटे ' + x.small + ' · बड़े ' + x.big + ') — इंसेंटिव ₹' + Math.round(I.total) +
        ', हर लेबर ₹' + I.perLabour.toFixed(0);
      if (sp2.total) {
        t += '  ·  लेबर-घंटे ' + hhmm(sp2.total * n);
        t += (sp2.work === 0 && sp2.ot > 0)
          ? '  ·  ओवरटाइम — दिहाड़ी नहीं, पूरा शुद्ध'
          : '  ·  दिहाड़ी ₹' + Math.round(I.wage) +
            '  ·  काटकर ' + (I.net < 0 ? '−₹' : '+₹') + Math.abs(I.net).toFixed(0);
      }
      return t;
    })();
  }
  function formEntry() {
    return {
      date: $('date').value, type: selType, goods: $('goods').value, start: $('start').value, finish: $('finish').value,
      bagsSmall: $('bagsSmall').value, bagsBig: $('bagsBig').value,
      labour: Object.keys(selLabour).filter(function (n) { return selLabour[n]; })
    };
  }
  function loadEntry(e) {
    $('date').value = e.date || todayLocal(); selType = e.type || selType; $('goods').value = e.goods || '';
    $('start').value = e.start || ''; $('finish').value = e.finish || '';
    const bs = bagSplit(e);
    $('bagsSmall').value = bs.small || ''; $('bagsBig').value = bs.big || '';
    selLabour = {}; (e.labour || []).forEach(function (n) { selLabour[n] = true; });
    renderSel();
  }
  function saveDraft() { core.setDraft(formEntry()); }
  function resetForm(keepContext) {
    const e = formEntry();
    $('start').value = ''; $('finish').value = ''; $('bagsSmall').value = ''; $('bagsBig').value = ''; selLabour = {};
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
    // सिर्फ़-फ़ोन मोड में "बाकी/अटकी/Sheet में गईं" का कोई मतलब नहीं — बस कुल गिनती
    $('countsBox').hidden = solo;
    $('soloBox').hidden = !solo;
    if (solo) $('nAll').textContent = q.length;
    $('lblPending').textContent = 'बाकी (pending)';
    $('nPending').textContent = nP; $('nFailed').textContent = nF; $('nSent').textContent = nS;
    $('badge').textContent = solo ? '' : ((nP + nF) ? String(nP + nF) : '');
    const box = $('items'); box.innerHTML = '';
    if (!q.length) { box.innerHTML = '<div class="empty">अभी कोई entry नहीं।</div>'; return; }

    /* क्रम: पहले वे जो अभी Sheet में नहीं गईं (उन पर काम बाक़ी है), फिर भेजी हुई —
       दोनों में नई तारीख़ ऊपर। पहले सिर्फ़ जोड़ने का क्रम था, इसलिए पुरानी तारीख़
       की entry बाद में भरने पर सबसे ऊपर आ जाती और सूची बेतरतीब दिखती।        */
    const order = q.slice().sort(function (a, b) {
      const ua = a.status === 'sent' ? 1 : 0, ub = b.status === 'sent' ? 1 : 0;
      if (ua !== ub) return ua - ub;
      const da = String(a.entry.date || ''), db = String(b.entry.date || '');
      if (da !== db) return db.localeCompare(da);
      return String(b.createdAt || '').localeCompare(String(a.createdAt || ''));
    });

    order.forEach(function (it) {
      const e = it.entry; const d = document.createElement('div'); d.className = 'buy';
      // सिर्फ़-फ़ोन मोड में Sheet का कोई ज़िक्र नहीं — वह अब मतलब ही नहीं रखता
      const st = solo ? 'फ़ोन में'
               : it.status === 'pending' ? 'बाकी'
               : it.status === 'sent' ? ('Sheet row ' + (it.result && it.result.serial != null ? it.result.serial : '?'))
               : 'अटकी';
      const sp = core.split(e.start, e.finish);
      const bs = bagSplit(e), tot = bs.small + bs.big;
      const labMin = sp.total * e.labour.length;     // कुल मज़दूर-मिनट = घड़ी का समय × लेबर
      const I = core.incentive(e.start, e.finish, e, e.labour.length);
      const names = e.labour.join(', ');

      d.innerHTML =
        '<div class="bh"><div class="bhl"><b>' + esc(fmtDate(e.date)) + '</b>' +
          '<div class="dim">' + esc(e.type + ' · ' + e.goods) + '</div></div>' +
          '<span class="st ' + it.status + '">' + esc(st) + '</span></div>' +

        // एक नज़र में: समय, बोरे, लेबर
        '<div class="facts">' +
          '<div><span>' + esc(e.start) + '–' + esc(e.finish) + '</span><em>' + esc(hhmm(sp.total)) + '</em>' +
            '<i>लेबर-घंटे ' + esc(hhmm(labMin)) + '</i></div>' +
          '<div><span>बोरे</span><em>' + tot + '</em>' +
            '<i>' + (bs.small && bs.big ? 'छोटे ' + bs.small + ' · बड़े ' + bs.big
                   : bs.small ? 'सब छोटे' : 'सब बड़े') + '</i></div>' +
          '<div><span>लेबर</span><em>' + e.labour.length + '</em></div>' +
        '</div>' +

        '<div class="s">काम ' + hhmm(sp.work) +
          (sp.ot ? ' · <b style="color:#ef6c00">ओवरटाइम ' + hhmm(sp.ot) + '</b>' : '') + '</div>' +
        /* "हर लेबर ₹x" की जगह अब वह हिसाब जिससे शुद्ध बनता है:
           इंसेंटिव, उतने ही समय की दिहाड़ी, और दोनों का फ़र्क़।

           ओवरटाइम में दिहाड़ी लगती ही नहीं, इसलिए वहाँ "दिहाड़ी ₹0 · काटकर +₹360"
           लिखना उलझाता है (काटा क्या?) — नियम सीधे लिख देना साफ़ है।        */
        '<div class="s">इंसेंटिव <b>₹' + Math.round(I.total) + '</b> · ' +
          (sp.work === 0 && sp.ot > 0
            ? 'ओवरटाइम — दिहाड़ी नहीं, पूरा शुद्ध'
            : 'दिहाड़ी ₹' + Math.round(I.wage) + ' · काटकर <b style="color:' +
              (I.net < 0 ? '#c62828' : '#2e7d32') + '">' +
              (I.net < 0 ? '−₹' : '+₹') + Math.abs(I.net).toFixed(0) + '</b>') + '</div>' +
        /* दोनों हिस्से वाली entry में दिहाड़ी सिर्फ़ काम के हिस्से पर लगी है —
           यह न लिखा हो तो वह कम दिखकर अजीब लगती है।                        */
        (sp.work > 0 && sp.ot > 0
          ? '<div class="s" style="color:#6b7480">ओवरटाइम में दिहाड़ी नहीं — ये ₹' +
            Math.round(I.wage) + ' सिर्फ़ काम के ' + esc(hhmm(sp.work * e.labour.length)) +
            ' लेबर-घंटे पर</div>'
          : '') +

        // नाम लंबे होते हैं — 3 से ज़्यादा हों तो समेट दो
        (e.labour.length > 3
          ? '<details><summary>' + e.labour.length + ' लेबर — नाम देखो</summary><div class="s">' + esc(names) + '</div></details>'
          : '<div class="s">' + esc(names) + '</div>') +
        (it.error ? '<div class="e">' + esc(it.error) + '</div>' : '');

      /* Edit और हटाओ हर entry पर — पहले "Sheet में जा चुकी" entries पर ये छिपे थे,
         जिससे गलती सुधारने का कोई रास्ता ही नहीं बचता था। जो सचमुच Sheet में जा
         चुकी है उस पर चेतावनी दी जाती है कि वहाँ की row अपने-आप नहीं बदलेगी।   */
      const wrap = document.createElement('div');
      if (it.status === 'failed') {
        const b = document.createElement('button'); b.className = 'btn blue sm'; b.textContent = '↻ फिर भेजो';
        b.onclick = function () { core.retry(it.id); renderList(); doSync(true); }; wrap.appendChild(b);
      }
      const inSheet = it.status === 'sent' && !core.localOnly();
      const rowNo = it.result && it.result.serial != null ? it.result.serial : '?';
      const ed = document.createElement('button'); ed.className = 'btn ghost sm'; ed.textContent = '✎ Edit';
      ed.onclick = function () {
        const warn = inSheet
          ? 'यह entry form में लौटेगी। Sheet की row ' + rowNo + ' अपने-आप नहीं बदलेगी — उसे वहाँ ख़ुद ठीक करना होगा। ठीक?'
          : 'यह entry form में लौटेगी और सूची से हटेगी। ठीक?';
        if (!confirm(warn)) return;
        core.remove(it.id); loadEntry(e); showView('entry'); renderList();
      };
      wrap.appendChild(ed);
      const rm = document.createElement('button'); rm.className = 'btn danger sm'; rm.textContent = '🗑 हटाओ';
      rm.onclick = function () {
        const warn = inSheet
          ? 'फ़ोन से हट जाएगी। Sheet की row ' + rowNo + ' वहीं रहेगी — उसे ख़ुद हटाना होगा। पक्का?'
          : 'पक्का हटाना है?';
        if (!confirm(warn)) return;
        core.remove(it.id); renderList();
      };
      wrap.appendChild(rm);
      d.appendChild(wrap);
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
    ['entry', 'list', 'buy', 'report', 'settings'].forEach(function (x) { $('view-' + x).hidden = (x !== v); });
    const tabs = document.querySelectorAll('nav.tabs button');
    tabs.forEach(function (b) { b.className = b.getAttribute('data-view') === v ? 'on' : ''; });
    if (v === 'list') renderList();
    if (v === 'report') renderReport();
    if (v === 'buy') { if (!draftBuy) { showBuyForm(false); renderBuyList(); } }
    if (v === 'settings') {
      $('api').value = core.getApi(); $('key').value = core.getKey();
      shiftInfo(); ratesInfo(); fillLocalLists(); listsInfo(); dbInfo(); sheetState();
      const bl = core.buyLists();
      draftItems = bl.items.map(itemToDraft);
      renderItemList();
      $('blParties').value = bl.parties.join('\n');
      $('buyListsInfo').textContent = bl.items.length + ' सामान · ' + bl.parties.length + ' सप्लायर';
    }
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
        return '<td' + (i === 2 && c !== '—' ? ' class="ot"' : '') + '>' + esc(c) + '</td>';
      }).join('') + '</tr>';
    });
    if (totalRow && rows.length) {
      h += '<tr>' + totalRow.map(function (c, i) {
        return '<td style="font-weight:700' + (i === 2 ? ';color:#ef6c00' : '') + '">' + esc(c) + '</td>';
      }).join('') + '</tr>';
    }
    el.innerHTML = h + '</tbody>';
  }

  function num(v, d) { return (v == null) ? '—' : v.toFixed(d === undefined ? 2 : d); }

  function renderReport() {
    const P = core.productivity($('repFrom').value, $('repTo').value);
    const W = P.buckets.work, O = P.buckets.ot, M = P.buckets.mixed;
    $('repShift').textContent = 'शिफ्ट: ' + P.shift.start + ' – ' + P.shift.finish + ' (⚙ में बदल सकते हो)';

    // ── मुख्य जवाब
    let v = '';
    if (!P.total) {
      v = '<div class="empty">इस अवधि में बोरे वाली कोई entry नहीं।</div>';
    } else if (!P.compare.ok) {
      const missing = !O.perBag ? 'ओवरटाइम' : 'काम के घंटों';
      v = '<div class="vd"><div class="say">तुलना अभी नहीं हो सकती</div>' +
          '<div class="sub">पूरी तरह ' + missing + ' में हुई कोई entry नहीं मिली। दोनों तरह की entries आने पर यहाँ जवाब दिखेगा।</div></div>';
    } else {
      const k = P.compare.slower, pc = P.compare.byPct;
      const cls = k === 'work' ? 'slow' : k === 'ot' ? 'fast' : 'same';
      const big = k === 'same' ? 'लगभग बराबर' : '+' + pc + '%';
      const say = k === 'work' ? '<b>काम के घंटों में</b> हर बोरा पर <b>' + pc + '% ज़्यादा</b> समय लगता है'
                : k === 'ot' ? '<b>ओवरटाइम में</b> हर बोरा पर <b>' + pc + '% ज़्यादा</b> समय लगता है'
                : 'काम के घंटों और ओवरटाइम में रफ़्तार लगभग एक जैसी है';
      v = '<div class="vd"><div class="num ' + cls + '">' + big + '</div><div class="say">' + say + '</div>' +
          '<div class="sub">काम के घंटे ' + num(W.perBag) + ' मज़दूर-मिनट/बोरा · ओवरटाइम ' + num(O.perBag) + '</div></div>';
      if (!P.compare.enough) {
        v += '<div class="warn2">⚠ अभी सिर्फ़ ' + W.entries + ' + ' + O.entries +
             ' साफ़ entries हैं — नतीजा शुरुआती है। दोनों तरफ़ 5+ entries जमा होने पर भरोसा करें।</div>';
      }
    }
    $('verdict').innerHTML = v;

    // ── आमने-सामने
    const col = function (b) {
      return [b.entries || 0, b.bags || 0, hhmm(b.labourMin), num(b.perBag), num(b.bagsPerLabourHour, 1)];
    };
    const cw = col(W), co = col(O);
    const labels = ['entries', 'कुल बोरा', 'मज़दूर-घंटे', 'मज़दूर-मिनट / बोरा', 'बोरा / मज़दूर-घंटा'];
    let h = '<thead><tr><th></th><th>काम के घंटे</th><th>ओवरटाइम</th></tr></thead><tbody>';
    labels.forEach(function (lb, i) {
      const hot = (i === 3 || i === 4);
      h += '<tr><td>' + esc(lb) + '</td>' +
           '<td' + (hot ? ' style="font-weight:700"' : '') + '>' + esc(cw[i]) + '</td>' +
           '<td' + (hot ? ' style="font-weight:700;color:#ef6c00"' : '') + '>' + esc(co[i]) + '</td></tr>';
    });
    $('repCmp').innerHTML = h + '</tbody>';

    // ── मिली-जुली + least squares
    let mx = '';
    if (M.entries) {
      mx = M.entries + ' entries शिफ्ट के आर-पार फैली हैं (' + M.bags + ' बोरा) — इनमें यह पता नहीं कि ' +
           'कौन सा बोरा किस तरफ़ उठा, इसलिए ऊपर की सीधी तुलना से बाहर रखी हैं।';
    }
    if (P.fit.ok) {
      mx += (mx ? ' ' : '') + 'सबको (मिली-जुली समेत) एक साथ हल करने पर: काम ' + num(P.fit.workPerBag) +
            ' · ओवरटाइम ' + num(P.fit.otPerBag) + ' मज़दूर-मिनट/बोरा।';
    }
    $('repMixed').textContent = mx;

    renderMoney();

    // ── और विवरण
    const r = core.report($('repFrom').value, $('repTo').value);
    $('repTotal').textContent = hhmm(r.totalMin);
    $('repWork').textContent = hhmm(r.workMin);
    $('repOt').textContent = hhmm(r.otMin);
    const pct = r.totalMin ? Math.round(r.otMin * 100 / r.totalMin) : 0;
    $('repHead').innerHTML = r.count
      ? r.count + ' entry · ' + r.bags + ' बोरा · कुल समय का <b>' + pct + '%</b> ओवरटाइम · लेबर-घंटे ' + hhmm(r.manMin)
      : 'कोई entry नहीं।';

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

  function rs(v) {   // ₹1,23,456 — भारतीय अंक-शैली, ऋणात्मक पर − आगे
    const n = Math.round(v || 0);
    let t;
    try { t = Math.abs(n).toLocaleString('en-IN'); } catch (_) { t = String(Math.abs(n)); }
    return (n < 0 ? '−₹' : '₹') + t;
  }

  function renderMoney() {
    const M = core.money($('repFrom').value, $('repTo').value);
    const W = M.buckets.work, O = M.buckets.ot, X = M.buckets.mixed, A = M.buckets.all;
    $('rateLine').textContent = 'दिहाड़ी ₹' + M.rates.wage + '/मज़दूर-घंटा (सिर्फ़ काम के घंटों में) · ₹' +
      M.rates.perSmall + '/छोटा · ₹' + M.rates.perBig + '/बड़ा बोरा (दोनों हिस्सों में)। ⚙ में बदल सकते हो।';

    // सुस्ती की क़ीमत
    let wb = '';
    if (M.waste.ok && Math.abs(M.waste.rupees) >= 1) {
      const bad = M.waste.rupees > 0;
      wb = '<div class="money"><div class="rs ' + (bad ? 'bad' : 'good') + '">' + rs(Math.abs(M.waste.rupees)) + '</div>' +
           '<div class="cap">' + (bad
             ? 'इस अवधि में काम के घंटों की सुस्ती पर लगी दिहाड़ी — अगर वही काम ओवरटाइम की रफ़्तार से होता तो ' +
               hhmm(Math.abs(M.waste.excessLabourMin)) + ' मज़दूर-घंटे बचते'
             : 'काम के घंटों में रफ़्तार ओवरटाइम से बेहतर रही — ' + hhmm(Math.abs(M.waste.excessLabourMin)) +
               ' मज़दूर-घंटे की बचत') + '</div></div>';
    }
    $('wasteBox').innerHTML = wb;

    const row = function (lb, a, b, cc, bold) {
      return '<tr><td>' + esc(lb) + '</td>' +
        '<td' + (bold ? ' style="font-weight:700"' : '') + '>' + esc(a) + '</td>' +
        '<td' + (bold ? ' style="font-weight:700' + (cc ? ';color:#ef6c00' : '') + '"' : '') + '>' + esc(b) + '</td></tr>';
    };
    const money2 = function (v) { return v == null ? '—' : '₹' + v.toFixed(2); };
    let h = '<thead><tr><th></th><th>काम के घंटे</th><th>ओवरटाइम</th></tr></thead><tbody>';
    h += row('दिहाड़ी', rs(W.wage), rs(O.wage));
    h += row('बोरा-दर', rs(W.piece), rs(O.piece));
    h += row('मिल की कुल लागत', rs(W.cost), rs(O.cost));
    h += row('लागत / बोरा', money2(W.costPerBag), money2(O.costPerBag), true, true);
    h += row('लेबर की कमाई / मज़दूर-घंटा', money2(W.earnPerLabourHour), money2(O.earnPerLabourHour));
    h += row('उसमें बोरा-दर से', money2(W.piecePerLabourHour), money2(O.piecePerLabourHour), true, true);
    $('repMoney').innerHTML = h + '</tbody>';

    // ── इंसेंटिव, दिहाड़ी काटकर
    const sign = function (v) { return (v == null) ? '—' : (v > 0 ? '+' : '') + rs(v); };
    const sign2 = function (v) { return (v == null) ? '—' : (v > 0 ? '+₹' : v < 0 ? '−₹' : '₹') + Math.abs(v).toFixed(2); };
    let nh = '<thead><tr><th></th><th>काम के घंटे</th><th>ओवरटाइम</th></tr></thead><tbody>';
    nh += row('इंसेंटिव दिया (₹' + M.rates.perSmall + '/छोटा · ₹' + M.rates.perBig + '/बड़ा)', rs(W.piece), rs(O.piece));
    nh += row('उसी काम पर लगी दिहाड़ी', '−' + rs(W.wage), '−' + rs(O.wage));
    nh += '<tr><td><b>दिहाड़ी काटकर शुद्ध</b></td>' +
          '<td style="font-weight:800;color:' + (W.net < 0 ? '#c62828' : '#2e7d32') + '">' + esc(sign(W.net)) + '</td>' +
          '<td style="font-weight:800;color:' + (O.net < 0 ? '#c62828' : '#2e7d32') + '">' + esc(sign(O.net)) + '</td></tr>';
    nh += row('शुद्ध / बोरा', sign2(W.netPerBag), sign2(O.netPerBag), true, true);
    nh += row('शुद्ध / मज़दूर-घंटा', sign2(W.netPerLabourHour), sign2(O.netPerLabourHour), true, true);
    $('repNet').innerHTML = nh + '</tbody>';

    let nn = '';
    if (A.net !== 0) nn += 'इस अवधि में कुल शुद्ध इंसेंटिव ' + sign(A.net) + '। ';
    if (W.net < 0 && W.entries) {
      nn += 'काम के घंटों में यह ऋणात्मक है — मतलब जितना इंसेंटिव दिया, उससे ज़्यादा की दिहाड़ी उसी समय पर लग गई। ';
    }
    nn += 'ओवरटाइम में दिहाड़ी लगती ही नहीं, इसलिए वहाँ पूरा इंसेंटिव शुद्ध रहता है — ' +
          'दोनों की तुलना सीधे मत कीजिए, यह फ़र्क ढाँचे का है। असली सवाल यह है कि काम के घंटों का शुद्ध ' +
          'सुस्ती से और नीचे तो नहीं जा रहा।';
    $('netNote').textContent = nn;

    let note = '';
    if (X.entries) note += 'शिफ्ट के आर-पार फैली ' + X.entries + ' entries इस तालिका में अलग नहीं दिखतीं, पर कुल में गिनी गई हैं — ' +
      'उनकी दिहाड़ी सिर्फ़ काम के घंटों वाले हिस्से पर लगी। ';
    if (A.cost) note += 'इस अवधि में कुल ' + rs(A.cost) + ' (दिहाड़ी ' + rs(A.wage) + ' + बोरा-दर ' + rs(A.piece) + ')। ';
    note += 'ध्यान: "लागत/बोरा" ओवरटाइम में हमेशा कम दिखेगी क्योंकि वहाँ दिहाड़ी लगती ही नहीं — ' +
            'यह रफ़्तार का सबूत नहीं। रफ़्तार ऊपर वाले समय के आँकड़े से देखिए।';
    $('moneyNote').textContent = note;
  }

  // ---- app का अपडेट (सिर्फ़ APK में; browser में यह पुल नहीं होता)
  const UPDATE_API = 'https://api.github.com/repos/deepeshjha98/test/releases/latest';
  const UPDATE_CHECK_GAP_MS = 6 * 60 * 60 * 1000;   // 6 घंटे में एक बार से ज़्यादा नहीं
  const UPDATE_SKIP_KEY = 'jcm.upSkip';
  let pendingUpdate = null;

  function native() { return (typeof JCMNative !== 'undefined') ? JCMNative : null; }

  function skippedCode() {
    try { return Number(localStorage.getItem(UPDATE_SKIP_KEY) || 0) || 0; } catch (_) { return 0; }
  }

  /* पट्टी सिर्फ़ तभी दिखे जब सचमुच नई build मौजूद हो। इसलिए दिखाना और छिपाना
     दोनों एक ही जगह से होते हैं, और जाँच में कुछ न मिले तो यह छिप जाती है। */
  function showUpdateBar(u) {
    pendingUpdate = u;
    $('upName').textContent = 'नया version आया है (v1.0.' + u.code + ')';
    $('upBtn').disabled = false;
    $('upBtn').textContent = '⬆ अपडेट करें';
    $('upBar').hidden = false;
  }
  function hideUpdateBar() {
    pendingUpdate = null;
    $('upBar').hidden = true;
  }

  async function checkUpdate(manual) {
    const N = native();
    if (!N) { if (manual) toast('अपडेट सिर्फ़ installed app में जाँची जा सकती है।', 'err', 3500); return; }
    if (!manual) {
      const last = Number(localStorage.getItem('jcm.upCheck') || 0);
      if (Date.now() - last < UPDATE_CHECK_GAP_MS) return;
    }
    try {
      if (manual) toast('जाँच रहा है…');
      const res = await fetch(UPDATE_API, { headers: { 'Accept': 'application/vnd.github+json' } });
      const rel = JSON.parse(await res.text());
      try { localStorage.setItem('jcm.upCheck', String(Date.now())); } catch (_) { }
      // हाथ से जाँचने का मतलब है "मुझे अब देखना है" — तब छोड़ा हुआ version भी दिखाओ
      const u = pickUpdate(rel, N.versionCode(), manual ? 0 : skippedCode());
      if (u) { showUpdateBar(u); if (manual) toast('नया version मिला — ऊपर "अपडेट करें" दबाओ', 'ok', 4000); }
      else { hideUpdateBar(); if (manual) toast('✔ आपकी app पहले से नई है (v' + N.versionName() + ')', 'ok', 3500); }
    } catch (e) {
      if (manual) toast('जाँच नहीं हो सकी — internet देखो।', 'err', 3500);
    }
  }

  // Java से आने वाला हाल
  root.JCMUpdateStatus = function (state, msg) {
    if (state === 'downloading') { $('upBtn').disabled = true; $('upBtn').textContent = '⬇ उतर रही है…'; toast('अपडेट उतर रही है…'); }
    else if (state === 'installing') { $('upBtn').textContent = '⬇ install…'; toast('अब "Update" दबाकर install कर दो', 'ok', 5000); }
    else if (state === 'error') { $('upBtn').disabled = false; $('upBtn').textContent = '⬆ अपडेट करें'; toast(msg || 'अपडेट नहीं हो पाई', 'err', 5000); }
  };

  // ══════════════ ⚙ में सामान की सूची (नाम + बोरे का वज़न) ══════════════
  /* नाम और वज़न के खानों में टाइप करते समय पूरा हिस्सा दुबारा नहीं बनता —
     वरना हर अक्षर पर keyboard बंद हो जाता। ढाँचा बदले तभी दुबारा बनता है। */
  /* मास्टर का record → form वाली नक़ल। यह एक ही जगह पर रहे, क्योंकि पहले यह
     दो जगह लिखा था और दोनों में packName/units/unitName छूट गए थे — नतीजा:
     कोई भी सामान बदलते ही बाक़ी सबकी पैक-जानकारी मिट जाती।                 */
  function itemToDraft(x) {
    return { name: x.name, kind: x.kind, kgs: x.kgs.join(', '), units: x.units || '', rateBy: x.rateBy };
  }

  let draftItems = [];
  let draftItem = null;      // popup में खुला सामान (नक़ल)
  let draftItemAt = -1;      // -1 = नया

  // टाइल पर बस इतना: नाम, और छोटे अक्षरों में वज़न + भाव
  const BRIEF_RATE = { bag: PACK, quintal: 'क्विं', unit: UNIT, lump: 'एकमुश्त' };
  function itemBrief(it) {
    const kgs = String(it.kgs || '').replace(/\s*,\s*/g, ',').replace(/\s+/g, ',').trim();
    const n = Math.max(0, Number(it.units) || 0);
    const k = itemKind(it);
    const qty = k === 'loose' ? 'रैंडम' : (kgs || '—') + (k === 'child' ? '×' + (n || '—') : '');
    return qty + ' · ' + (BRIEF_RATE[it.rateBy] || PACK);
  }

  function renderItemList() {
    let h = '';
    draftItems.forEach(function (it, i) {
      h += '<button class="tile" data-openbi="' + i + '">' +
        '<b>' + esc(it.name || '(बिना नाम)') + '</b><span>' + esc(itemBrief(it)) + '</span></button>';
    });
    h += '<button class="tile add" data-openbi="-1">➕ सामान</button>';
    $('blItemList').innerHTML = h;
  }

  function saveItemsNow() {
    const l = core.setBuyLists(draftItems, $('blParties').value);
    draftItems = l.items.map(itemToDraft);
    renderItemList();
    $('buyListsInfo').textContent = l.items.length + ' सामान · ' + l.parties.length + ' सप्लायर';
    return l;
  }

  function openMasterModal(i) {
    draftItemAt = (i == null || i < 0) ? -1 : i;
    // नया सामान सबसे आम किस्म पर खुलता है — फिक्स्ड वज़न वाला बोरा
    draftItem = draftItemAt < 0 ? { name: '', kind: 'fixed', kgs: '', units: '', rateBy: 'bag' }
                                : Object.assign({}, draftItems[draftItemAt]);
    $('imtTitle').textContent = draftItemAt < 0 ? 'नया सामान' : 'सामान बदलो';
    $('imtDel').hidden = draftItemAt < 0;
    renderMasterModal();
    $('imtModal').hidden = false;
  }
  function closeMasterModal() { $('imtModal').hidden = true; draftItem = null; draftItemAt = -1; }


  const KIND_TITLE = { loose: 'रैंडम वज़न', fixed: 'फिक्स्ड वज़न', child: 'अंदर ' + UNIT };
  const RATE_LABEL = { bag: '₹ / ' + PACK, quintal: '₹ / क्विंटल', unit: '₹ / ' + UNIT, lump: 'एकमुश्त रक़म' };

  function renderMasterModal() {
    const it = draftItem, kind = itemKind(it);

    let h = '<label style="margin-top:0">नाम</label>' +
      '<input type="text" data-mi="name" value="' + esc(it.name) + '" placeholder="चना">' +

      '<label>किस तरह का सामान है?</label>' +
      '<div class="chips2" style="margin-bottom:0">';
    ITEM_KINDS.forEach(function (k) {
      h += '<button data-mikind="' + k + '"' + (kind === k ? ' class="on"' : '') + '>' + esc(KIND_TITLE[k]) + '</button>';
    });
    h += '</div><div class="hint" style="margin-top:6px">' +
      (kind === 'loose'
        ? 'हर ' + esc(PACK) + ' का वज़न कम-ज़्यादा (खल्ली, धान)। entry में कुल kg भरा जाएगा।'
        : kind === 'fixed'
          ? 'हर ' + esc(PACK) + ' का वज़न बराबर (चोकर 35, चना 30)।'
          : 'एक ' + esc(PACK) + ' के अंदर तय गिनती में ' + esc(UNIT) + ' (सूजी का 25kg ' + esc(PACK) + ' = 50 ' + esc(UNIT) + ', तेल का ' + esc(PACK) + ' = 16 ' + esc(UNIT) + ')।') +
      '</div>';

    // किस्म के हिसाब से ही खाने — रैंडम वज़न पर कोई वज़न नहीं पूछा जाता
    if (kind === 'fixed' || kind === 'child') {
      h += '<label>एक ' + esc(PACK) + ' का वज़न (kg)</label>' +
        '<input type="text" inputmode="decimal" data-mi="kgs" value="' + esc(it.kgs) + '" placeholder="30">' +
        '<div class="hint" style="margin-top:6px">एक ही सामान दो वज़न में आता हो तो दोनों लिखो — जैसे <b>30, 50</b>।' +
        (kind === 'child' ? ' तेल के ' + esc(PACK) + ' जैसा वज़न लिखा ही न हो तो <b>खाली छोड़ दो</b>।' : '') + '</div>';
    }
    if (kind === 'child') {
      h += '<label>एक ' + esc(PACK) + ' में कितने ' + esc(UNIT) + '?</label>' +
        '<input type="number" inputmode="numeric" step="any" data-mi="units" value="' + esc(it.units || '') + '" placeholder="16">';
    }

    h += '<label>भाव किस हिसाब से लिखा होता है?</label><div class="chips2" style="margin-bottom:0">';
    // ₹/पीस तभी चुना जा सके जब पीस की गिनती भरी हो — वरना मूल रक़म शून्य बन जाती
    ratesForKind(kind).filter(function (k) {
      return k !== 'unit' || Math.max(0, Number(it.units) || 0) > 0;
    }).forEach(function (k) {
      h += '<button data-mirate="' + k + '"' + (it.rateBy === k ? ' class="on"' : '') + '>' + esc(RATE_LABEL[k]) + '</button>';
    });
    h += '</div><div class="hint" style="margin-top:6px">सप्लायर कई ' + esc(PACK) +
      ' की रक़म एक साथ लिखता हो (5 ' + esc(PACK) + ' = ₹15,000) तो <b>एकमुश्त रक़म</b> चुनो।</div>';
    $('imtBody').innerHTML = h;
  }

  $('imtClose').onclick = closeMasterModal;
  $('imtCancel').onclick = closeMasterModal;
  $('imtOk').onclick = function () {
    if (!draftItem) return;
    const nm = String(draftItem.name || '').trim();
    if (!nm) { toast('सामान का नाम लिखो।', 'err', 3000); return; }
    if (itemKind(draftItem) === 'child' && !(Math.max(0, Number(draftItem.units) || 0) > 0)) {
      toast('एक ' + PACK + ' में कितने ' + UNIT + ' — यह भरो।', 'err', 3500); return;
    }
    const clash = draftItems.some(function (x, i) {
      return i !== draftItemAt && String(x.name || '').trim() === nm;
    });
    if (clash) { toast('"' + nm + '" पहले से सूची में है।', 'err', 3500); return; }
    if (draftItemAt < 0) draftItems.push(draftItem); else draftItems[draftItemAt] = draftItem;
    closeMasterModal();
    saveItemsNow();
    toast('✔ सूची save हुई', 'ok');
  };
  $('imtDel').onclick = function () {
    if (draftItemAt < 0) return;
    if (!confirm('"' + (draftItems[draftItemAt].name || 'यह सामान') + '" हटाना है?')) return;
    draftItems.splice(draftItemAt, 1);
    closeMasterModal();
    saveItemsNow();
    toast('हटा दिया', 'ok');
  };
  $('imtModal').addEventListener('input', function (ev) {
    const t = ev.target;
    if (!t || !t.hasAttribute || !t.hasAttribute('data-mi') || !draftItem) return;
    draftItem[t.getAttribute('data-mi')] = t.value;   // टाइप करते समय popup दुबारा नहीं बनता
  });
  $('imtModal').addEventListener('click', function (ev) {
    const t = ev.target.closest ? ev.target.closest('[data-mirate],[data-mikind]') : null;
    if (!t || !draftItem) return;
    if (t.hasAttribute('data-mikind')) {
      const k = t.getAttribute('data-mikind');
      draftItem.kind = k;
      /* जो खाने अब नहीं दिखेंगे उनकी क़ीमत मिटाई नहीं जाती — गलती से चिप दब जाए
         तो वापस दबाते ही पुराने वज़न लौट आते हैं। सहेजते समय buyItem ख़ुद किस्म
         के हिसाब से साफ़ कर देता है, इसलिए छिपी क़ीमत हिसाब में नहीं आती।     */
      // भाव का जो तरीक़ा इस किस्म पर नहीं चलता (₹/पीस बिना पीस के), उसे बदलो
      if (ratesForKind(k).indexOf(draftItem.rateBy) < 0) draftItem.rateBy = 'bag';
    } else {
      draftItem.rateBy = t.getAttribute('data-mirate');
    }
    renderMasterModal();
  });
  $('blItemList').addEventListener('click', function (ev) {
    const t = ev.target.closest ? ev.target.closest('[data-openbi]') : null;
    if (t) openMasterModal(parseInt(t.getAttribute('data-openbi'), 10));
  });

  // ══════════════════ खरीद की screen ══════════════════
  let draftBuy = null;
  let draftLine = null;        // popup में खुला सामान — असली line की नक़ल, "जोड़ो" दबाने पर ही लगती है
  let draftLineAt = -1;        // -1 = नया सामान, वरना draftBuy.lines का index
  const KIND_LABEL = { flat: 'सीधी रक़म ₹', perQuintal: '₹ / क्विंटल', perBag: '₹ / ' + PACK, percent: '% मूल पर' };

  function newLine() { return { item: '', party: '', kind: 'fixed', rateBy: 'bag', units: '', bags: '', bagKg: '', totalKg: '', rate: '', expenses: [] }; }
  function blankBuy() {
    // सामान शुरू में एक भी नहीं — "➕ सामान जोड़ो" से popup खुलेगा
    return { date: todayLocal(), vehicle: '', party: '', multiParty: false, basis: 'weight', lines: [], expenses: [], partyExpenses: {} };
  }
  function lineParty(l) { return String((l && l.party) || '').trim() || String((draftBuy && draftBuy.party) || '').trim(); }

  function optsHtml(list, sel) {
    let h = '<option value="">-- चुनो --</option>';
    (list || []).forEach(function (n) { h += '<option value="' + esc(n) + '"' + (n === sel ? ' selected' : '') + '>' + esc(n) + '</option>'; });
    return h;
  }
  function kindOpts(sel) {
    let h = '';
    EXPENSE_KINDS.forEach(function (k) { h += '<option value="' + k + '"' + (k === sel ? ' selected' : '') + '>' + esc(KIND_LABEL[k]) + '</option>'; });
    return h;
  }
  function expRows(list, prefix) {
    let h = '';
    (list || []).forEach(function (x, i) {
      h += '<div class="row3" style="margin-top:6px">' +
        '<div><input type="text" placeholder="ख़र्च का नाम" data-e="' + prefix + '" data-i="' + i + '" data-f="name" value="' + esc(x.name || '') + '"></div>' +
        '<div><select data-e="' + prefix + '" data-i="' + i + '" data-f="kind">' + kindOpts(x.kind) + '</select></div>' +
        '<div style="flex:0 0 84px"><input type="number" inputmode="decimal" step="any" placeholder="0" data-e="' + prefix + '" data-i="' + i + '" data-f="value" value="' + esc(x.value === '' || x.value == null ? '' : x.value) + '"></div>' +
        '<button class="xbtn" data-rmexp="' + prefix + '" data-i="' + i + '">✕</button></div>';
    });
    return h;
  }

  function renderBuyForm() {
    const L = core.buyLists();
    $('bDate').value = draftBuy.date;
    $('bVeh').value = draftBuy.vehicle;
    $('bParty').innerHTML = optsHtml(L.parties, draftBuy.party);
    $('bMulti').checked = !!draftBuy.multiParty;
    $('bPartyHint').textContent = draftBuy.multiParty
      ? 'हर सामान का सप्लायर उसी के popup में भरो; जो खाली रहेगा उस पर ऊपर वाला ही लगेगा।'
      : 'एक ही बार चुनो — ट्रक के सारे सामान पर यही लगेगा।';

    let h = '';
    if (!draftBuy.lines.length) {
      h = '<div class="card"><div class="empty">अभी कोई सामान नहीं।<br>नीचे "➕ सामान जोड़ो" दबाओ।</div></div>';
    }
    draftBuy.lines.forEach(function (l, i) {
      const pk = PACK, un = UNIT;
      const nu = Math.max(0, Number(l.units) || 0);
      const wt = lineWeigh(l) === 'total'
        ? (esc(l.bags || '0') + ' ' + esc(pk) + (l.totalKg ? ', कुल ' + esc(l.totalKg) + 'kg' : ''))
        : (esc(l.bags || '0') + ' ' + esc(pk) + (l.bagKg ? ' × ' + esc(l.bagKg) + 'kg' : ''));
      const rbl = l.rateBy === 'quintal' ? '/क्विं' : l.rateBy === 'unit' ? '/' + esc(un)
                : l.rateBy === 'lump' ? ' एकमुश्त' : '/' + esc(pk);
      const qty = wt + (nu ? ' × ' + nu + ' ' + esc(un) : '') + ' · ₹' + esc(l.rate || '0') + rbl;
      const pty = String(l.party || '').trim();
      h += '<div class="card lrow">' +
        '<div class="top"><b>' + esc(l.item || '(सामान नहीं चुना)') + '</b></div>' +
        '<div class="s">' + qty + (pty ? ' · सप्लायर ' + esc(pty) : '') +
          (l.expenses && l.expenses.length ? ' · ' + l.expenses.length + ' ख़र्च' : '') + '</div>' +
        '<div class="res" id="lres' + i + '"></div>' +
        '<div style="display:flex;gap:8px;margin-top:8px">' +
          '<button class="btn ghost sm" data-editline="' + i + '" style="flex:1">✎ बदलो</button>' +
          '<button class="btn danger sm" data-rmline="' + i + '" style="flex:1">🗑 हटाओ</button>' +
        '</div>' +
      '</div>';
    });
    $('bLines').innerHTML = h;
    renderPartyExp();
    $('bExp').innerHTML = expRows(draftBuy.expenses, 'T');
    document.querySelectorAll('#bBasis button').forEach(function (b) {
      const k = b.getAttribute('data-basis');
      b.className = k === draftBuy.basis ? 'on' : '';
      if (k === 'bags') b.textContent = PACK;      // शब्द एक ही जगह से आए
    });
    recalcBuy();
  }

  // ---- सामान का popup
  function openItemModal(i) {
    draftLineAt = (i == null || i < 0) ? -1 : i;
    draftLine = draftLineAt < 0 ? newLine() : JSON.parse(JSON.stringify(draftBuy.lines[draftLineAt]));
    $('imTitle').textContent = draftLineAt < 0 ? 'सामान जोड़ो' : 'सामान बदलो';
    $('imOk').textContent = draftLineAt < 0 ? '✔ जोड़ो' : '✔ ठीक है';
    renderItemModal();
    $('itemModal').hidden = false;
  }
  function closeItemModal() {
    $('itemModal').hidden = true;
    draftLine = null; draftLineAt = -1;
  }
  function renderItemModal() {
    const L = core.buyLists();
    const l = draftLine;
    const perBag = lineWeigh(l) === 'perBag', rb = lineRateBy(l);
    const master = findBuyItem(L.items, l.item);
    const pack = PACK, unit = UNIT;
    const nUnits = lineUnitsPer(l);
    const rateLbl = rb === 'quintal' ? '₹ / क्विंटल' : rb === 'unit' ? '₹ / ' + unit
                  : rb === 'lump' ? 'कुल रक़म ₹' : '₹ / ' + pack;
    let h = '<label style="margin-top:0">सामान</label>' +
      '<select data-m="item">' + optsHtml(L.items.map(function (x) { return x.name; }), l.item) + '</select>';
    if (draftBuy.multiParty) {
      h += '<label>इस सामान का सप्लायर</label>' +
        '<select data-m="party">' + optsHtml(L.parties, l.party) + '</select>' +
        '<div class="hint" style="margin-top:6px">खाली छोड़ोगे तो ट्रक वाला सप्लायर' +
        (draftBuy.party ? ' (' + esc(draftBuy.party) + ')' : '') + ' लगेगा।</div>';
    }
    /* वज़न कैसे भरा जाएगा यह सामान की अपनी किस्म तय करती है (⚙ में एक बार),
       इसलिए यहाँ दुबारा नहीं पूछा जाता — बस उसी के हिसाब से खाने बदल जाते हैं। */
    h += '<label>भाव किस हिसाब से?</label>' +
      '<div class="chips2">' +
        ratesForKind(nUnits > 0 ? 'child' : 'fixed').map(function (k) {
          return '<button data-mrate="' + k + '"' + (rb === k ? ' class="on"' : '') + '>' +
            esc(k === 'lump' ? 'एकमुश्त' : RATE_LABEL[k]) + '</button>';
        }).join('') +
      '</div>' +
      (perBag && master && master.kgs.length > 1
        ? '<label>इस बार कौन-सा ' + esc(pack) + '?</label><div class="chips2">' + master.kgs.map(function (k) {
            return '<button data-mkg="' + k + '"' + (Number(l.bagKg) === k ? ' class="on"' : '') + '>' + k + ' kg</button>';
          }).join('') + '</div>'
        : '') +
      '<div class="row3">' +
        '<div><label>' + esc(pack) + '</label><input type="number" inputmode="numeric" step="1" data-m="bags" value="' + esc(l.bags) + '"></div>' +
        (perBag
          ? '<div><label>एक ' + esc(pack) + ' kg' + (nUnits ? ' (हो तो)' : '') + '</label><input type="number" inputmode="decimal" step="any" data-m="bagKg" value="' + esc(l.bagKg) + '"></div>'
          : '<div><label>कुल kg' + (nUnits ? ' (हो तो)' : '') + '</label><input type="number" inputmode="decimal" step="any" data-m="totalKg" value="' + esc(l.totalKg) + '"></div>') +
        // अंदर पीस वाले पर गिनती यहीं बदली जा सके — इस बार 15 आए तो 15 लिख दो
        (nUnits
          ? '<div><label>एक ' + esc(pack) + ' में ' + esc(unit) + '</label><input type="number" inputmode="numeric" step="1" data-m="units" value="' + esc(l.units) + '"></div>'
          : '<div><label>' + esc(rateLbl) + '</label><input type="number" inputmode="decimal" step="any" data-m="rate" value="' + esc(l.rate) + '"></div>') +
      '</div>' +
      (nUnits ? '<label>' + esc(rateLbl) + '</label><input type="number" inputmode="decimal" step="any" data-m="rate" value="' + esc(l.rate) + '">' : '') +
      (nUnits
        ? '<div class="hint" style="margin-top:6px">एक ' + esc(pack) + ' में <b>' + nUnits + ' ' + esc(unit) +
          '</b>।' + (rb === 'lump' ? ' सप्लायर ने जो कुल रक़म लिखी है वही भरो — ₹/' + esc(pack) + ' और ₹/' + esc(unit) + ' अपने-आप निकलेंगे।' : '') +
          (!perBag || !l.bagKg ? ' वज़न लिखा न हो तो kg खाली छोड़ दो।' : '') + '</div>'
        : '<div class="hint" style="margin-top:6px">' + (perBag
            ? esc(pack) + ' × एक ' + esc(pack) + ' का kg से कुल वज़न बन जाएगा।'
            : 'हर ' + esc(pack) + ' का वज़न बराबर न हो (खल्ली, धान) तो कुल kg यहाँ भरो — गिनती सिर्फ़ ऊपर।') + '</div>') +
      /* ख़र्च यहाँ नहीं पूछे जाते — गद्दी/टैक्स सप्लायर के सारे सामान पर लगते हैं,
         किसी एक सामान पर नहीं। पुरानी खरीद में जो line-ख़र्च भरे थे वे दिखते
         रहते हैं ताकि कोई पुराना हिसाब चुपचाप न बदल जाए।                  */
      (l.expenses && l.expenses.length
        ? '<label>इस सामान के पुराने ख़र्च</label>' + expRows(l.expenses, 'M') +
          '<div class="hint" style="margin-top:6px">नए ढाँचे में ये ख़र्च सप्लायर पर लगते हैं। ' +
          'चाहो तो यहाँ से ✕ करके नीचे "सप्लायर के ख़र्च" में डाल दो।</div>'
        : '') +
      '<div class="res" id="imRes"></div>';
    $('imBody').innerHTML = h;
    recalcItemModal();
  }
  /* सामान चुनते ही उसकी मास्टर जानकारी लग जाती है — वज़न और भाव का तरीक़ा।
     यही इसका मक़सद है: बार-बार वही चीज़ न भरनी पड़े।                      */
  function applyItemDefaults() {
    const m = findBuyItem(core.buyLists().items, draftLine.item);
    if (!m) return;
    draftLine.kind = m.kind;
    /* भाव का तरीक़ा बदल रहा हो तो पहले टाइप किए अंक साफ़ कर दो — वरना
       "7050 ₹/क्विंटल" चुपचाप "7050 ₹/पैक" बनकर तिगुना नतीजा दे देता। */
    if (draftLine.rateBy !== m.rateBy) draftLine.rate = '';
    draftLine.rateBy = m.rateBy;
    draftLine.units = m.units || '';
    if (m.kind === 'loose') {
      draftLine.bagKg = '';        // हर पैक कम-ज़्यादा — entry में कुल kg भरा जाएगा
    } else {
      /* एक ही सामान दो वज़न में आता हो तो अपने-आप मत चुनो — छोटा वज़न चुपचाप
         लग जाने से पूरी रक़म कम बैठती है। इस बार कौन-सा आया, यह पूछा जाएगा। */
      if (m.kgs.length > 1) { if (m.kgs.indexOf(Number(draftLine.bagKg)) < 0) draftLine.bagKg = ''; }
      else if (m.kgs.indexOf(Number(draftLine.bagKg)) < 0) draftLine.bagKg = m.kgs[0] || '';
      draftLine.totalKg = '';
    }
  }

  // ── सप्लायर के ख़र्च (गद्दी, टैक्स…) — हर सप्लायर का अपना ढेर
  let pexKeys = [];
  function renderPartyExp() {
    if (!draftBuy.partyExpenses || typeof draftBuy.partyExpenses !== 'object') draftBuy.partyExpenses = {};
    // ट्रक में जो सप्लायर सचमुच मौजूद हैं, उन्हीं के ख़र्च पूछो
    const seen = {};
    pexKeys = [];
    draftBuy.lines.forEach(function (l) {
      const n = lineParty(l);
      if (!seen[n]) { seen[n] = 1; pexKeys.push(n); }
    });
    if (!pexKeys.length) pexKeys = [String(draftBuy.party || '').trim()];
    let h = '';
    pexKeys.forEach(function (name, i) {
      const list = draftBuy.partyExpenses[name] || (draftBuy.partyExpenses[name] = []);
      h += (pexKeys.length > 1 ? '<label' + (i ? '' : ' style="margin-top:0"') + '>' + esc(name || '(सप्लायर नहीं चुना)') + '</label>' : '') +
        expRows(list, 'P' + i) +
        '<button class="btn ghost sm" data-addexp="P' + i + '" style="width:100%">➕ ख़र्च</button>';
    });
    $('bPex').innerHTML = h;
  }

  function recalcItemModal() {
    if (!draftLine || !$('imRes')) return;
    const x = purchaseCalc({ basis: 'weight', party: draftBuy.party, lines: [draftLine], expenses: [] }).lines[0];
    const per = [];
    if (x.perQuintal != null) per.push(rs(x.perQuintal) + '/क्विं');
    if (x.perBag != null) per.push(rs(x.perBag) + '/' + x.packName);
    if (x.perUnit != null) per.push(rs(x.perUnit) + '/' + x.unitName);
    $('imRes').textContent = (x.kg > 0 || x.bags > 0)
      ? (x.kg > 0 ? x.qtl.toFixed(2) + ' क्विं · ' : x.bags + ' ' + x.packName +
          (x.units ? ' · ' + x.units + ' ' + x.unitName : '') + ' · ') +
        'मूल ' + rs(x.basic) + (x.lineExp ? ' + ख़र्च ' + rs(x.lineExp) : '') +
        (per.length ? ' → ' + per.join(' · ') : '') + '  (साझा ख़र्च अलग जुड़ेगा)'
      : 'गिनती और रेट भरो';
  }

  function recalcBuy() {
    const r = core.calcBuy(draftBuy);
    r.lines.forEach(function (x, i) {
      const el = $('lres' + i);
      if (!el) return;
      const ex = x.lineExp + x.partyExp;
      const per = [];
      if (x.perQuintal != null) per.push(rs(x.perQuintal) + '/क्विं');
      if (x.perBag != null) per.push(rs(x.perBag) + '/' + x.packName);
      if (x.perUnit != null) per.push(rs(x.perUnit) + '/' + x.unitName);
      el.textContent = (x.kg > 0 || x.bags > 0)
        ? (x.kg > 0 ? x.qtl.toFixed(2) + ' क्विं · ' : '') + 'मूल ' + rs(x.basic) +
          (ex ? ' + ख़र्च ' + rs(ex) : '') + (x.share ? ' + भाड़े का हिस्सा ' + rs(x.share) : '') +
          (per.length ? ' → ' + per.join(' · ') : '')
        : 'गिनती और रेट भरो';
    });
    let h = '<label style="margin-top:0">नतीजा</label>';
    if (!(r.kg > 0) && !(r.bags > 0)) { h += '<div class="empty">गिनती भरते ही यहाँ असली रेट दिखने लगेगा।</div>'; }
    else {
      // जिस चीज़ का कोई मतलब ही नहीं (तेल का क्विंटल) उसका कॉलम मत दिखाओ
      const anyKg = r.lines.some(function (x) { return x.kg > 0; });
      const anyUnit = r.lines.some(function (x) { return x.units > 0; });
      h += '<div class="scroll"><table class="rep"><thead><tr><th>सामान</th>' +
        (anyKg ? '<th>क्विंटल</th><th>₹/क्विं</th>' : '') +
        '<th>₹/' + PACK + '</th>' + (anyUnit ? '<th>₹/' + UNIT + '</th>' : '') + '</tr></thead><tbody>';
      r.lines.forEach(function (x) {
        h += '<tr><td>' + esc(x.item || '—') + (x.party ? '<br><span style="color:#6b7480;font-size:12px">' + esc(x.party) + '</span>' : '') + '</td>' +
          (anyKg ? '<td>' + (x.kg > 0 ? x.qtl.toFixed(2) : '—') + '</td>' +
                   '<td style="font-weight:700">' + esc(x.perQuintal == null ? '—' : rs(x.perQuintal)) + '</td>' : '') +
          '<td style="font-weight:700">' + esc(x.perBag == null ? '—' : rs(x.perBag)) + '</td>' +
          (anyUnit ? '<td>' + esc(x.perUnit == null ? '—' : rs(x.perUnit)) + '</td>' : '') + '</tr>';
      });
      h += '</tbody></table></div>' +
        '<div class="kv" style="margin-top:8px">कुल ' + (anyKg ? r.qtl.toFixed(2) + ' क्विंटल · ' : '') +
        r.bags + ' ' + PACK + (r.units ? ' · ' + r.units + ' ' + UNIT : '') + '<br>' +
        'मूल ' + rs(r.basic) + ' + सप्लायर के ख़र्च ' + rs(r.partyExp + r.lineExp) +
        ' + साझा ख़र्च ' + rs(r.tripExp) + ' = <b>' + rs(r.total) + '</b></div>' +
        (r.mixedWeight
          ? '<div class="warn2">कुछ सामान का वज़न नहीं है, इसलिए साझा ख़र्च वज़न के बजाय ' +
            '<b>मूल्य</b> के हिसाब से बाँटा गया — वरना बिना वज़न वाले पर लगभग कुछ पड़ता ही नहीं।</div>'
          : '');
    }
    $('bResult').innerHTML = h;
  }

  // "30kg" या "25kg × 50" — पैक की नाप एक ही जगह से बने
  function packLabel(kg, units) {
    if (!(kg > 0)) return units > 0 ? '× ' + units : '—';
    return hhKg(kg) + 'kg' + (units > 0 ? ' × ' + units : '');
  }
  function hhKg(kg) { return String(Math.round(kg * 1000) / 1000); }

  let rateRows = [];

  function openHist(i) {
    const x = rateRows[i];
    if (!x) return;
    $('hTitle').textContent = x.item + ' · ' + packLabel(x.packKg, x.unitsPer);
    const uni = x.units > 0;
    let h = '<div class="kv">ताज़ा भाव <b>' +
      (x.perQuintal != null ? rs(x.perQuintal) + '/क्विं' : rs(x.perBag) + '/' + PACK) + '</b>' +
      (x.lastDate ? ' · ' + esc(fmtDate(x.lastDate)) : '') + '<br>' +
      '<span style="color:#6b7480">सब ' + x.lines + ' खरीद मिलाकर औसत ' +
      (x.avgPerQuintal != null ? rs(x.avgPerQuintal) + '/क्विं' : rs(x.avgPerBag) + '/' + PACK) + '</span></div>' +
      '<label>हर खरीद अलग-अलग — नई ऊपर</label><div class="scroll"><table class="rep"><thead><tr>' +
      '<th>तारीख़</th><th>मात्रा</th><th>₹/क्विं</th><th>₹/' + esc(PACK) + '</th>' +
      (uni ? '<th>₹/' + esc(UNIT) + '</th>' : '') + '</tr></thead><tbody>';
    x.history.forEach(function (r) {
      h += '<tr><td>' + esc(fmtDate(r.date)) +
        (r.party ? '<span class="pack">' + esc(r.party) + '</span>' : '') + '</td>' +
        '<td>' + esc(r.kg > 0 ? r.qtl.toFixed(2) + ' क्विं' : r.bags + ' ' + PACK) + '</td>' +
        (r.perQuintal == null ? '<td>—</td>' : '<td class="ot">' + esc(rs(r.perQuintal)) + '</td>') +
        '<td>' + esc(r.perBag == null ? '—' : rs(r.perBag)) + '</td>' +
        (uni ? '<td>' + esc(r.perUnit == null ? '—' : rs(r.perUnit)) + '</td>' : '') + '</tr>';
    });
    $('hBody').innerHTML = h + '</tbody></table></div>';
    $('histModal').hidden = false;
  }
  function closeHist() { $('histModal').hidden = true; }
  $('hClose').onclick = closeHist;
  $('hOk').onclick = closeHist;
  $('buyRates').addEventListener('click', function (ev) {
    const t = ev.target.closest ? ev.target.closest('[data-hist]') : null;
    if (t) openHist(parseInt(t.getAttribute('data-hist'), 10));
  });

  function renderBuyList() {
    /* क्विंटल का कॉलम (कुल कितना आया) हटा दिया — रोज़ के काम में उसकी ज़रूरत नहीं।
       उसकी जगह पैक की नाप, जिससे यह भी साफ़ हो जाता है कि दो पंक्तियों वाला
       एक ही सामान असल में दो अलग नाप का है।

       भाव अब सबसे ताज़ा खरीद का दिखता है, औसत का नहीं — वरना नया माल नए भाव
       पर आने पर वह पुराने में घुलकर छिप जाता। नाम के नीचे पिछले दो भाव भी,
       और पंक्ति दबाने पर पूरा इतिहास।                                        */
    rateRows = core.buyRates('', '');
    const anyUnit = rateRows.some(function (x) { return x.units > 0; });
    let rh = '<thead><tr><th>सामान</th><th>' + esc(PACK) + '</th><th>₹/क्विं</th><th>₹/' + esc(PACK) + '</th>' +
      (anyUnit ? '<th>₹/' + esc(UNIT) + '</th>' : '') + '</tr></thead><tbody>';
    if (!rateRows.length) rh += '<tr><td colspan="' + (anyUnit ? 5 : 4) + '" style="text-align:center;color:#6b7480">कुछ नहीं</td></tr>';
    rateRows.forEach(function (x, i) {
      // पिछले दो भाव — वही जो ताज़ा से पहले आए थे
      const prev = x.history.slice(1, 3).map(function (h) {
        const v = h.perQuintal != null ? h.perQuintal : h.perBag;
        return v == null ? '' : rs(v);
      }).filter(Boolean);
      rh += '<tr class="tap" data-hist="' + i + '">' +
        '<td>' + esc(x.item) +
          (prev.length ? '<span class="prev">पिछले ' + esc(prev.join(' · ')) + '</span>' : '') + '</td>' +
        '<td>' + esc(packLabel(x.packKg, x.unitsPer)) + '</td>' +
        (x.perQuintal == null ? '<td>—</td>' : '<td class="ot">' + esc(rs(x.perQuintal)) + '</td>') +
        '<td>' + esc(x.perBag == null ? '—' : rs(x.perBag)) + '</td>' +
        (anyUnit ? '<td>' + esc(x.perUnit == null ? '—' : rs(x.perUnit)) + '</td>' : '') + '</tr>';
    });
    $('buyRates').innerHTML = rh + '</tbody>';

    const all = core.buys();
    const box = $('buyList');
    if (!all.length) { box.innerHTML = '<div class="empty">अभी कोई खरीद दर्ज नहीं।</div>'; return; }
    let h = '<label style="margin-top:0">दर्ज खरीद</label>';
    all.forEach(function (b) {
      const r = core.calcBuy(b);
      const seen = {}, parties = [];
      r.lines.forEach(function (x) { if (x.party && !seen[x.party]) { seen[x.party] = 1; parties.push(x.party); } });
      // एक ही सप्लायर हो तो उसका नाम ऊपर एक बार — हर पंक्ति पर दोहराना शोर है
      const one = parties.length === 1 ? parties[0] : '';
      const uni = r.lines.some(function (x) { return x.units > 0; });

      let rowsHtml = '';
      r.lines.forEach(function (x) {
        rowsHtml += '<tr><td>' + esc(x.item || '—') +
          (one ? '' : (x.party ? '<br><span class="dim">' + esc(x.party) + '</span>' : '')) + '</td>' +
          '<td>' + esc(x.kg > 0 ? x.qtl.toFixed(2) + ' क्विं' : x.bags + ' ' + PACK) + '</td>' +
          (x.perQuintal == null ? '<td>—</td>' : '<td class="ot">' + esc(rs(x.perQuintal)) + '</td>') +
          '<td>' + esc(x.perBag == null ? '—' : rs(x.perBag)) + '</td>' +
          (uni ? '<td>' + esc(x.perUnit == null ? '—' : rs(x.perUnit)) + '</td>' : '') + '</tr>';
      });
      const tbl = '<div class="scroll"><table class="rep"><thead><tr>' +
        '<th>सामान</th><th>मात्रा</th><th>₹/क्विं</th><th>₹/' + PACK + '</th>' +
        (uni ? '<th>₹/' + UNIT + '</th>' : '') + '</tr></thead><tbody>' + rowsHtml + '</tbody></table></div>';

      h += '<div class="buy">' +
        '<div class="bh"><div class="bhl"><b>' + esc(fmtDate(b.date)) + '</b>' +
          '<div class="dim">' + esc([one, b.vehicle].filter(Boolean).join(' · ') ||
            (parties.length > 1 ? parties.length + ' सप्लायर' : '')) + '</div></div>' +
          '<span class="st sent">' + esc(rs(r.total)) + '</span></div>' +
        // लंबी सूची अपने-आप न फैले — गिनती दिखाकर, दबाने पर खुले
        (r.lines.length > 4
          ? '<details><summary>' + r.lines.length + ' सामान — देखो</summary>' + tbl + '</details>'
          : tbl) +
        '<div><button class="btn ghost sm" data-editbuy="' + esc(b.id) + '">✎ खोलो</button>' +
        '<button class="btn danger sm" data-delbuy="' + esc(b.id) + '">🗑 हटाओ</button></div></div>';
    });
    box.innerHTML = h;
  }

  function showBuyForm(on) { if (!on) closeItemModal(); $('buyFormWrap').hidden = !on; $('buyListWrap').hidden = on; }

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
    const N = native();
    $('verInfo').textContent = N
      ? 'अभी लगी हुई: v' + N.versionName() + ' (build ' + N.versionCode() + ')'
      : 'browser में चल रही है — अपडेट सिर्फ़ installed app में।';
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
  ['start', 'finish', 'bagsSmall', 'bagsBig', 'date', 'goods'].forEach(function (id) { $(id).addEventListener('change', function () { renderSel(); saveDraft(); }); $(id).addEventListener('input', saveDraft); });

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
  function sheetState() {
    const on = !core.localOnly();
    $('offSheet').hidden = !on;
    $('sheetState').textContent = on
      ? 'अभी entries Google Sheet में भी जाती हैं।'
      : 'अभी सब कुछ सिर्फ़ फ़ोन में है — कहीं नहीं जाता, कुछ अपने-आप मिटता भी नहीं। ' +
        'दुबारा चालू करना हो तो ऊपर Web App URL डालकर save कर दो।';
  }
  $('saveSettings').onclick = function () {
    core.setApi($('api').value); core.setKey($('key').value);
    sheetState(); modeHints(); renderList(); toast('सेटिंग save हो गई', 'ok');
  };
  $('offSheet').onclick = function () {
    if (!confirm('Google Sheet बंद कर दें?\n\nआगे से हर entry सिर्फ़ फ़ोन में रहेगी। ' +
                 'Sheet में जो पहले जा चुकी हैं वे वहीं पड़ी रहेंगी — यहाँ से कुछ नहीं मिटेगा।\n\n' +
                 'जब चाहो, URL दुबारा डालकर चालू कर सकते हो।')) return;
    core.disableSheet();
    $('api').value = ''; $('key').value = '';
    sheetState(); modeHints(); renderList(); renderLists();
    toast('✔ Sheet बंद — अब सब कुछ फ़ोन में', 'ok', 4000);
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

  // ---- अपडेट के बटन
  $('upBtn').onclick = function () {
    const N = native();
    if (!N || !pendingUpdate) return;
    if (!N.canInstall()) {
      toast('पहले इस app को "Install unknown apps" की इजाज़त दो — सेटिंग खोल रहा हूँ', 'err', 5000);
      N.openInstallSettings();
      return;
    }
    N.downloadAndInstall(pendingUpdate.url);
  };
  $('upSkip').onclick = function () {
    const c = pendingUpdate ? pendingUpdate.code : 0;
    try { if (c) localStorage.setItem(UPDATE_SKIP_KEY, String(c)); } catch (_) { }
    hideUpdateBar();
    toast('ठीक — इसके लिए फिर नहीं पूछूँगा। ⚙ में "अपडेट जाँचो" से कभी भी देख सकते हो।', 'ok', 4500);
  };
  $('checkUpdate').onclick = function () { checkUpdate(true); };

  // ---- खरीद के बटन
  $('newBuy').onclick = function () { draftBuy = blankBuy(); renderBuyForm(); showBuyForm(true); window.scrollTo(0, 0); };
  $('cancelBuy').onclick = function () { closeItemModal(); draftBuy = null; showBuyForm(false); renderBuyList(); };
  $('addLine').onclick = function () { openItemModal(-1); };
  $('imClose').onclick = closeItemModal;
  $('imCancel').onclick = closeItemModal;
  $('imOk').onclick = function () {
    if (!draftLine) return;
    if (!String(draftLine.item || '').trim()) { toast('पहले सामान चुनो।', 'err', 3000); return; }
    const chk = purchaseCalc({ lines: [draftLine], party: draftBuy.party });
    const x = chk.lines[0];
    if (!(x.bags > 0) && !(x.kg > 0)) { toast('वज़न भरो, या ' + PACK + ' की गिनती।', 'err', 3500); return; }
    /* एक ही सामान दो वज़न में आता हो तो इस बार कौन-सा — यह पहले पूछो, क्योंकि
       यही सबसे काम का संदेश है; वरना नीचे वाली जाँच "वज़न भरो" कहकर रोकेगी और
       उससे यह पता ही नहीं चलेगा कि ऊपर चिप दबाना है।                        */
    const mm = findBuyItem(core.buyLists().items, draftLine.item);
    if (mm && mm.kgs.length > 1 && !(Number(draftLine.bagKg) > 0)) {
      toast('इस बार कौन-सा ' + PACK + ' आया — ऊपर से चुनो।', 'err', 3500); return;
    }
    /* जिस हिसाब से भाव लिखा है, उसी का हर शून्य न हो — वरना मूल रक़म चुपचाप ₹0
       बन जाती और ट्रक का कुल कम बैठता, बिना कहीं कुछ दिखे।                  */
    const need = { quintal: [x.kg, 'वज़न'], unit: [x.units, UNIT + ' की गिनती'],
                   bag: [x.bags, PACK + ' की गिनती'], lump: [x.bags, PACK + ' की गिनती'] }[x.rateBy];
    if (need && !(need[0] > 0)) { toast(need[1] + ' भरो — उसके बिना रक़म ₹0 बन जाएगी।', 'err', 4000); return; }
    if (draftLineAt < 0) draftBuy.lines.push(draftLine); else draftBuy.lines[draftLineAt] = draftLine;
    closeItemModal();
    renderBuyForm();
  };
  $('bParty').onchange = function () { draftBuy.party = $('bParty').value; renderBuyForm(); };
  $('bMulti').onchange = function () {
    draftBuy.multiParty = $('bMulti').checked;
    // बंद करते ही हर सामान का अलग सप्लायर हट जाता है — वरना छिपा हुआ रह जाता
    if (!draftBuy.multiParty) draftBuy.lines.forEach(function (l) { l.party = ''; });
    renderBuyForm();
  };
  $('addTripExp').onclick = function () { draftBuy.expenses.push({ name: '', kind: 'flat', value: '' }); renderBuyForm(); };
  ['bDate', 'bVeh'].forEach(function (id) {
    $(id).addEventListener('input', function () { draftBuy.date = $('bDate').value; draftBuy.vehicle = $('bVeh').value; });
  });
  document.querySelectorAll('#bBasis button').forEach(function (b) {
    b.onclick = function () { draftBuy.basis = b.getAttribute('data-basis'); renderBuyForm(); };
  });

  /* form के अंदर के सारे खाने एक ही जगह से सँभाले जाते हैं (event delegation)।
     टाइप करते समय सिर्फ़ नतीजा दुबारा बनता है, पूरा form नहीं — वरना हर अक्षर पर
     keyboard बंद हो जाता और cursor कूदता। ढाँचा बदले (row जुड़े/हटे) तभी पूरा form। */
  function lineExpList(prefix) {
    if (prefix === 'T') return draftBuy.expenses;            // पूरे ट्रक के साझा ख़र्च
    if (prefix === 'M') return draftLine ? draftLine.expenses : [];   // popup में खुले सामान के
    if (prefix.charAt(0) === 'P') {                          // किसी सप्लायर के ख़र्च
      const name = pexKeys[parseInt(prefix.slice(1), 10)];
      if (name == null) return [];
      return draftBuy.partyExpenses[name] || (draftBuy.partyExpenses[name] = []);
    }
    const i = parseInt(prefix.slice(1), 10);
    return draftBuy.lines[i] ? draftBuy.lines[i].expenses : [];
  }
  function onBuyInput(ev) {
    const t = ev.target;
    if (!t || !t.hasAttribute) return;
    if (t.hasAttribute('data-m')) {                            // popup का कोई खाना
      if (!draftLine) return;
      const f = t.getAttribute('data-m');
      draftLine[f] = t.value;
      // सामान बदला तो उसका वज़न/भाव अपने-आप लग जाता है, इसलिए पूरा popup दुबारा
      if (f === 'item') { applyItemDefaults(); renderItemModal(); } else recalcItemModal();
    } else if (t.hasAttribute('data-l')) {
      const l = draftBuy.lines[parseInt(t.getAttribute('data-l'), 10)];
      if (l) { l[t.getAttribute('data-f')] = t.value; recalcBuy(); }
    } else if (t.hasAttribute('data-e')) {
      const pre = t.getAttribute('data-e');
      const x = lineExpList(pre)[parseInt(t.getAttribute('data-i'), 10)];
      if (x) { x[t.getAttribute('data-f')] = t.value; if (pre === 'M') recalcItemModal(); else recalcBuy(); }
    }
  }
  function onBuyChange(ev) {                                   // select वाले
    const t = ev.target;
    if (t && t.hasAttribute && (t.hasAttribute('data-m') || t.hasAttribute('data-l') || t.hasAttribute('data-e'))) {
      t.dispatchEvent(new Event('input', { bubbles: true }));
    }
  }
  function onBuyClick(ev) {
    const t = ev.target.closest ? ev.target.closest('[data-rmline],[data-editline],[data-addexp],[data-rmexp],[data-mrate],[data-mkg]') : null;
    if (!t) return;
    const inModal = !!(t.closest && t.closest('#itemModal'));
    if (t.hasAttribute('data-editline')) { openItemModal(parseInt(t.getAttribute('data-editline'), 10)); return; }
    if (t.hasAttribute('data-rmline')) {
      if (!confirm('यह सामान हटाना है?')) return;
      draftBuy.lines.splice(parseInt(t.getAttribute('data-rmline'), 10), 1);
    } else if (t.hasAttribute('data-addexp')) {
      lineExpList(t.getAttribute('data-addexp')).push({ name: '', kind: 'percent', value: '' });
    } else if (t.hasAttribute('data-rmexp')) {
      lineExpList(t.getAttribute('data-rmexp')).splice(parseInt(t.getAttribute('data-i'), 10), 1);
    } else if (t.hasAttribute('data-mrate')) {
      if (draftLine) draftLine.rateBy = t.getAttribute('data-mrate');
    } else if (t.hasAttribute('data-mkg')) {
      if (draftLine) draftLine.bagKg = t.getAttribute('data-mkg');
    }
    if (inModal) renderItemModal(); else renderBuyForm();
  }
  ['buyFormWrap', 'itemModal'].forEach(function (id) {
    $(id).addEventListener('input', onBuyInput);
    $(id).addEventListener('change', onBuyChange);
    $(id).addEventListener('click', onBuyClick);
  });

  $('saveBuy').onclick = function () {
    try {
      closeItemModal();
      core.saveBuy(draftBuy);
      draftBuy = null; showBuyForm(false); renderBuyList();
      toast('✔ खरीद save हो गई', 'ok');
    } catch (e) { toast(e.message, 'err', 4000); }
  };

  $('buyList').addEventListener('click', function (ev) {
    const t = ev.target.closest ? ev.target.closest('[data-editbuy],[data-delbuy]') : null;
    if (!t) return;
    if (t.hasAttribute('data-delbuy')) {
      if (!confirm('यह पूरी खरीद हटानी है?')) return;
      core.removeBuy(t.getAttribute('data-delbuy')); renderBuyList(); toast('हटा दी', 'ok');
    } else {
      const b = core.buys().find(function (x) { return x.id === t.getAttribute('data-editbuy'); });
      if (!b) return;
      draftBuy = normalizeBuyParty(JSON.parse(JSON.stringify(b)));
      renderBuyForm(); showBuyForm(true); window.scrollTo(0, 0);
    }
  });

  $('saveBuyLists').onclick = function () {
    saveItemsNow();
    toast('✔ खरीद की लिस्ट save हुई', 'ok');
  };

  // ---- विश्लेषण के बटन
  $('moreBtn').onclick = function () {
    const box = $('moreBox');
    box.hidden = !box.hidden;
    $('moreBtn').textContent = box.hidden ? 'और विवरण ▾' : 'विवरण छिपाओ ▴';
  };
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
  function ratesInfo() {
    const r = core.getRates();
    $('rWage').value = r.wage; $('rSmall').value = r.perSmall; $('rBig').value = r.perBig;
    $('ratesInfo').textContent = 'अभी: ₹' + r.wage + '/मज़दूर-घंटा दिहाड़ी · ₹' + r.perSmall + '/छोटा बोरा · ₹' + r.perBig + '/बड़ा बोरा' +
      (r.perSmall === r.perBig ? '' : ' — इससे पहले की entries बड़े बोरे में गिनी जाती हैं।');
  }
  $('saveRates').onclick = function () {
    try {
      core.setRates($('rWage').value, $('rSmall').value, $('rBig').value);
      ratesInfo();
      toast('✔ दरें save हुईं', 'ok');
    } catch (e) { toast(e.message, 'err', 4000); }
  };

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
    checkUpdate(false);   // चुपचाप, 6 घंटे में एक बार से ज़्यादा नहीं
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
