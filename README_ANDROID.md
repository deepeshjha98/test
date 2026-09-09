# JCM लोडिंग — Android app (APK), cloud में build

**क्या है:** वही app (form / सूची / सेटिंग, offline queue, Google Sheet sync) — पूरी app APK के अंदर bundled है,
कोई website host करने की ज़रूरत नहीं। APK GitHub Actions (cloud) पर बनता है — तुम्हारे Mac पर Android Studio नहीं चाहिए।
Phone पर .apk download → Install → home screen पर "JCM लोडिंग"।

```
jcm-android-repo/
  .github/workflows/build-apk.yml        push/Run पर APK बनाकर Releases में डालता है
  .github/workflows/make-keystore.yml    एक बार: signing key बनाता है
  android/                               Android project (WebView wrapper, Java, कोई Kotlin नहीं)
    app/src/main/assets/www/             app की files (index.html, app.js, config.js, icons)
    app/src/main/java/.../MainActivity.java
  README_ANDROID.md
```
(Backend वही है: नया `Code.gs` + deploy — README_PWA.md का Step 1 पहले कर लो।)

## Step 1 — repo बनाओ और push करो (Mac पर, 3 मिनट)
```bash
cd jcm-android-repo
git init && git add -A && git commit -m "JCM loading app"
# github.com पर नया PRIVATE repo बनाओ (जैसे jcm-loading-android), फिर:
git remote add origin git@github.com:<username>/jcm-loading-android.git
git branch -M main && git push -u origin main
```
Push होते ही **Actions → "Build APK"** अपने-आप चलेगा (4–6 मिनट)।

## Step 2 — signing key (एक बार, 5 मिनट — ज़रूरी)
बिना इसके हर build अलग debug key से sign होगा → नई APK install करने से पहले पुरानी uninstall करनी पड़ेगी (phone की pending entries मिट जाएँगी)।
1. Actions → **"Make keystore (एक बार)"** → Run workflow → पूरा होने पर artifact `keystore-SAVE-THIS-PRIVATELY` download करो।
2. Repo → Settings → Secrets and variables → Actions → **New repository secret** — चार बार:
   `KEYSTORE_BASE64` (KEYSTORE_BASE64.txt की पूरी content), `KEYSTORE_PASSWORD`, `KEY_ALIAS` (= `jcm`), `KEY_PASSWORD` (SECRETS.txt में)।
3. `release.keystore` + `SECRETS.txt` कहीं सुरक्षित रखो (खो गया तो आगे updates के लिए फिर uninstall/reinstall)। Artifact delete कर दो।
4. Actions → "Build APK" → Run workflow → अब release key से signed।

## Step 3 — phone पर install
Repo → **Releases** → latest → `jcm-loading-v1.0.N.apk` phone में download → खोलो → "Install unknown apps" allow → Install।
पहली बार खोलो → ⚙ सेटिंग → Web App URL + App key → **Test** → ✔ → ➕ नई entry।

**Pre-configure (recommended):** `android/app/src/main/assets/www/config.js` में `api` और `key` भर दो → push → नई build में हर phone पहले से configured।
(जिसके पास APK, वह entry कर सकता है — private repo, APK और key private रखो।)

## Update कैसे
कुछ भी बदलो (config.js, app.js, index.html…) → `git push` → नई build → Releases से नई APK → install (पुरानी के ऊपर; data सुरक्षित, बशर्ते Step 2 किया हो)।
versionCode अपने-आप बढ़ता है (GitHub run number)।

## Claude Code से
- यही सब Claude Code कर सकता है: repo push, workflow चलाना (`gh workflow run "Build APK"`), Releases से APK लाना (`gh release download`)।
- Local build चाहिए तो Claude Code से कहो: `brew install --cask temurin@17 android-commandlinetools` → `sdkmanager "platforms;android-34" "build-tools;34.0.0"` → `cd android && gradle assembleRelease` (Gradle 8.9)।
  Prompt: "इस repo का android/ project Gradle 8.9 + JDK 17 से assembleRelease करो; SDK न हो तो sdkmanager से platforms;android-34 और build-tools;34.0.0 install करो; APK path बताओ।"

## पहली build में कुछ अटके तो
Actions → failed run → log की आखिरी 40 लाइनें भेज दो। आम कारण: repo में `.github/` folder push नहीं हुआ (hidden folder), या secrets के नाम में typo।

## जाँच (पहली बार)
1. Install → ⚙ Test ✔  2. एक entry → 📋 सूची में "Sheet row N" + Sheet में row  3. Airplane mode में entry → off → अपने-आप sync
4. Phone rotate/back/app switch → form का draft बचा रहता है  5. Sheet के `लेबर सूची` में नया नाम → ⚙ लिस्ट refresh → chip आ गया
