# Backend — Google Sheet में entries अपने-आप जाने के लिए

Phone की app सीधे Sheet में नहीं लिख सकती। बीच में यह छोटा program (`Code.gs`) चाहिए,
जो Google Apps Script पर चलता है और आपकी Sheet में row लिखता है।
एक ही बार लगाना है, लगभग 5 मिनट।

## Step 1 — Sheet में script खोलो
अपनी Google Sheet खोलो → ऊपर **Extensions → Apps Script**।
जो पुराना code दिखे उसे मिटाकर इस folder की `Code.gs` की **पूरी content** paste करो।

## Step 2 — अपनी key डालो
सबसे ऊपर वाली लाइन बदलो:
```js
var APP_KEY = 'yahan-apna-password';
```
यह password जैसी चीज़ है और **आप जो चाहें रख सकते हैं** — Google इसे जारी नहीं करता,
आप खुद बनाते हो। खाली छोड़ोगे तो जिसके पास URL होगा वह Sheet में लिख सकेगा, इसलिए कुछ ज़रूर डालो।

बस इतना ध्यान रखो:
- यही अक्षर app की ⚙ सेटिंग में भी डालने होंगे — **हूबहू वही** (छोटे/बड़े अक्षर का फ़र्क पड़ता है)।
- अंग्रेज़ी अक्षर + अंक रखो (फ़ोन पर टाइप करना आसान, गलती की गुंजाइश कम)।
- लंबा रखो (15+ अक्षर)। यही एकमात्र चीज़ है जो URL जानने वाले को रोकती है — `1234` जैसा मत रखो।
- आगे/पीछे के space अपने-आप हट जाते हैं, पर बीच के space गिने जाते हैं — इसलिए space न ही रखो तो अच्छा।

फिर **Ctrl+S** (Mac: ⌘S) से save करो।

## Step 3 — sheets बनाओ (एक बार)
ऊपर function की सूची में **`setupWorkbook`** चुनो → **▶ Run**।

पहली बार Google अनुमति माँगेगा:
**Review permissions** → अपना account चुनो → **Advanced** → **Go to project (unsafe)** → **Allow**।
(यह "unsafe" सिर्फ़ इसलिए लिखा आता है कि script आपने खुद लिखा है, Google ने जाँचा नहीं।)

Sheet में तीन tab बन जाएँगे:
| Sheet | किसलिए |
|---|---|
| `एंट्री` | सारी entries यहाँ जुड़ती जाएँगी |
| `लेबर सूची` | **B column** में लेबर के नाम — यहाँ नाम जोड़ो/हटाओ |
| `सूचियाँ` | **A** = सामान का प्रकार, **B** = कार्य प्रकार |

तीनों में नमूने के नाम पहले से भरे मिलेंगे — उन्हें अपने नामों से बदल दो।

## Step 4 — Deploy करो (यहीं URL बनता है)
**Deploy → New deployment** → ⚙ (gear) → **Web app** → फिर:
- **Execute as:** `Me`
- **Who has access:** `Anyone`

**Deploy** दबाओ → जो URL मिले (`…/macros/s/…/exec` पर ख़त्म होगा) उसे copy कर लो।
**यही URL** app की ⚙ सेटिंग वाले "Apps Script Web App URL" खाने में जाता है।

## Step 5 — app में जोड़ो
Phone में app → ⚙ सेटिंग → URL और key भरो → **🔌 Test करो** →
`✔ जुड़ गया: N लेबर, N सामान, N कार्य प्रकार` दिखे तो हो गया।

---

## आगे code बदलो तो
`Code.gs` बदलने के बाद **Deploy → Manage deployments → ✏️ (pencil) → Version: New version → Deploy**।
सिर्फ़ save करने से चालू URL नहीं बदलता — यह सबसे आम भूल है।

## कैसे काम करता है
- App हर request में `key` भेजती है; गलत key = कुछ नहीं लिखा जाता।
- हर entry के साथ एक `clientId` जाता है। Network टूटने पर app वही entry दुबारा भेजती है,
  पर server उसी `clientId` की row पहले से देखकर **दूसरी row नहीं बनाता** — Sheet में duplicate नहीं आते।
- Server भी वही जाँच करता है जो app करती है (तारीख़, समय, बोरा पूरा अंक, कम से कम एक लेबर)।
  गलत entry Sheet में नहीं जाती; app उसे "अटकी" दिखाती है और वह फ़ोन में सुरक्षित रहती है।
- एक साथ कई फ़ोन भेजें तो `LockService` से एक-एक करके row बनती हैं।

## अगर कुछ अटके
| दिक्कत | वजह |
|---|---|
| `Server से JSON नहीं मिला` | Deploy में "Who has access" = Anyone नहीं है, या URL `/exec` पर ख़त्म नहीं होता |
| `App key गलत है` | Apps Script का `APP_KEY` और app की ⚙ key अलग हैं |
| लिस्ट खाली आई | `लेबर सूची` के B column / `सूचियाँ` में नाम नहीं भरे |
| code बदला पर असर नहीं | Step "आगे code बदलो तो" — New version से deploy नहीं किया |
