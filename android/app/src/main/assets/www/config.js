// (optional) यहाँ भरो तो हर phone पर app पहली बार खुलते ही configured मिलेगी।
// App में एक बार सेटिंग save हो गई तो यह file उसे नहीं बदलती।
window.JCM_CONFIG = {
  /* ☁️ Cloud backup — app सिर्फ़ अपना API endpoint बुलाती है:
       POST {url}/functions/v1/jcm-sync  (Authorization: Bearer <चाबी>)
     URL client-side है, खुला रखना ठीक है। चाबी यहाँ कभी मत लिखना — repo
     public है; चाबी सिर्फ़ फ़ोन पर एक बार डाली जाती है। */
  supa: {
    url: 'https://xpozollgargifqdfjaay.supabase.co'
  }
};
