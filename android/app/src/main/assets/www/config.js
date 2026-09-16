// (optional) यहाँ भरो तो हर phone पर app पहली बार खुलते ही configured मिलेगी।
// App में एक बार सेटिंग save हो गई तो यह file उसे नहीं बदलती।
window.JCM_CONFIG = {
  api: '',   // (पुराना) Apps Script Web App URL
  key: '',   // (पुराना) Code.gs का APP_KEY

  /* ☁️ Cloud backup (Supabase) — URL और anon key यहीं भरे हुए हैं, इसलिए
     ⚙ में सिर्फ़ email + password डालना होता है।
     ये दोनों client-side चीज़ें हैं (हर app में खुली जाती हैं) — ताले (RLS +
     signups बंद) बिना login कुछ नहीं खुलने देते। PASSWORD यहाँ कभी मत लिखना:
     repo public है — password ही असली चाबी है, वह सिर्फ़ फ़ोन पर डाला जाता है। */
  supa: {
    url: 'https://xpozollgargifqdfjaay.supabase.co',
    anonKey: 'sb_publishable_olKB4I9FIinJKHHfC9Ykeg_AJ7xd82n',
    email: 'app@jcm.mill'   // app का अपना खाता — user के सामने बस 'चाबी' बचती है
  }
};
