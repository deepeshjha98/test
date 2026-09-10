package com.jhaji.loading;

import android.app.Activity;
import android.app.DownloadManager;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.provider.Settings;
import android.webkit.JavascriptInterface;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import androidx.annotation.NonNull;
import androidx.core.content.FileProvider;
import androidx.webkit.WebViewAssetLoader;

import java.io.File;

/**
 * झाजी चूड़ा मिल — लोडिंग/अनलोडिंग app.
 * पूरी app (assets/www) APK के अंदर है; WebView उसे https://appassets.androidplatform.net/assets/www/ से चलाता है
 * (secure origin → localStorage/fetch सामान्य browser जैसे)। Data Apps Script web app पर fetch से जाता है।
 */
public class MainActivity extends Activity {

    private static final String START_URL = "https://appassets.androidplatform.net/assets/www/index.html";
    private static final String APP_HOST = "appassets.androidplatform.net";

    /** अपडेट सिर्फ़ अपने ही repo की release से — किसी और URL से APK कभी install नहीं होगी। */
    private static final String UPDATE_URL_PREFIX = "https://github.com/deepeshjha98/test/releases/download/";
    private static final String UPDATE_FILE = "jcm-update.apk";

    private WebView web;
    private long updateDownloadId = -1;
    private BroadcastReceiver downloadDone;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        web = new WebView(this);
        setContentView(web);

        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);          // app का logic JS में है
        s.setDomStorageEnabled(true);          // localStorage = offline queue यहीं रहती है
        s.setDatabaseEnabled(true);
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(false);
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        s.setCacheMode(WebSettings.LOAD_DEFAULT);
        s.setSupportZoom(false);
        s.setBuiltInZoomControls(false);
        s.setMediaPlaybackRequiresUserGesture(true);

        final WebViewAssetLoader loader = new WebViewAssetLoader.Builder()
                .addPathHandler("/assets/", new WebViewAssetLoader.AssetsPathHandler(this))
                .build();

        web.setWebViewClient(new WebViewClient() {
            @Override
            public WebResourceResponse shouldInterceptRequest(@NonNull WebView view, @NonNull WebResourceRequest request) {
                return loader.shouldInterceptRequest(request.getUrl());
            }

            @Override
            public boolean shouldOverrideUrlLoading(@NonNull WebView view, @NonNull WebResourceRequest request) {
                Uri uri = request.getUrl();
                if (APP_HOST.equals(uri.getHost())) return false;   // app के अंदर के pages
                try {
                    startActivity(new Intent(Intent.ACTION_VIEW, uri));   // बाहरी link → browser
                } catch (Exception ignored) { }
                return true;
            }
        });
        web.setWebChromeClient(new WebChromeClient());   // alert/confirm/date-picker के लिए
        web.addJavascriptInterface(new Bridge(), "JCMNative");   // सिर्फ़ हमारी अपनी bundled JS ही इसे छू सकती है
        registerDownloadWatcher();

        if (savedInstanceState != null) {
            web.restoreState(savedInstanceState);
        } else {
            web.loadUrl(START_URL);
        }
    }

    @Override
    protected void onSaveInstanceState(@NonNull Bundle outState) {
        super.onSaveInstanceState(outState);
        web.saveState(outState);
    }

    @Override
    public void onBackPressed() {
        if (web != null && web.canGoBack()) web.goBack();
        else super.onBackPressed();
    }

    @Override
    protected void onDestroy() {
        if (downloadDone != null) {
            try { unregisterReceiver(downloadDone); } catch (Exception ignored) { }
            downloadDone = null;
        }
        if (web != null) web.destroy();
        super.onDestroy();
    }

    // ───────────────────────── app के अंदर से अपडेट ─────────────────────────

    /** APK उतरते ही installer खोल दो। */
    private void registerDownloadWatcher() {
        downloadDone = new BroadcastReceiver() {
            @Override
            public void onReceive(Context ctx, Intent intent) {
                long id = intent.getLongExtra(DownloadManager.EXTRA_DOWNLOAD_ID, -1);
                if (id != updateDownloadId || updateDownloadId == -1) return;
                updateDownloadId = -1;
                File apk = updateFile();
                if (apk == null || !apk.exists() || apk.length() < 1024) {
                    toWeb("error", "अपडेट उतर नहीं पाई — network जाँचो।");
                    return;
                }
                toWeb("installing", "");
                openInstaller(apk);
            }
        };
        IntentFilter f = new IntentFilter(DownloadManager.ACTION_DOWNLOAD_COMPLETE);
        if (Build.VERSION.SDK_INT >= 33) registerReceiver(downloadDone, f, Context.RECEIVER_EXPORTED);
        else registerReceiver(downloadDone, f);
    }

    private File updateFile() {
        File dir = getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS);
        return dir == null ? null : new File(dir, UPDATE_FILE);
    }

    private void openInstaller(File apk) {
        try {
            Uri uri = FileProvider.getUriForFile(this, getPackageName() + ".fileprovider", apk);
            Intent i = new Intent(Intent.ACTION_VIEW);
            i.setDataAndType(uri, "application/vnd.android.package-archive");
            i.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);
            startActivity(i);
        } catch (Exception e) {
            toWeb("error", "Installer नहीं खुला: " + e.getMessage());
        }
    }

    /** Java से JS को हाल बताना। */
    private void toWeb(final String state, final String msg) {
        final String js = "window.JCMUpdateStatus && window.JCMUpdateStatus("
                + jsStr(state) + "," + jsStr(msg) + ")";
        runOnUiThread(new Runnable() {
            @Override public void run() {
                if (web != null) web.evaluateJavascript(js, null);
            }
        });
    }

    private static String jsStr(String s) {
        if (s == null) s = "";
        StringBuilder b = new StringBuilder("\"");
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            if (c == '"' || c == '\\') b.append('\\').append(c);
            else if (c == '\n' || c == '\r') b.append(' ');
            else if (c < 0x20) b.append(' ');
            else b.append(c);
        }
        return b.append('"').toString();
    }

    /** WebView की JS को दिया गया पुल। सिर्फ़ app की अपनी files इस WebView में चलती हैं। */
    private class Bridge {

        @JavascriptInterface
        public int versionCode() {
            try {
                return (int) getPackageManager().getPackageInfo(getPackageName(), 0).versionCode;
            } catch (Exception e) { return 0; }
        }

        @JavascriptInterface
        public String versionName() {
            try {
                return getPackageManager().getPackageInfo(getPackageName(), 0).versionName;
            } catch (Exception e) { return ""; }
        }

        /** Android 8+ पर "unknown apps install" की इजाज़त इसी app को चाहिए। */
        @JavascriptInterface
        public boolean canInstall() {
            if (Build.VERSION.SDK_INT < 26) return true;
            try { return getPackageManager().canRequestPackageInstalls(); }
            catch (Exception e) { return false; }
        }

        @JavascriptInterface
        public void openInstallSettings() {
            runOnUiThread(new Runnable() {
                @Override public void run() {
                    try {
                        Intent i = new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                                Uri.parse("package:" + getPackageName()));
                        i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                        startActivity(i);
                    } catch (Exception e) {
                        toWeb("error", "सेटिंग नहीं खुली — Settings → Apps → JCM लोडिंग → Install unknown apps");
                    }
                }
            });
        }

        /** नई APK उतारो, फिर installer खोलो। URL अपने ही repo का होना चाहिए। */
        @JavascriptInterface
        public void downloadAndInstall(final String url) {
            if (url == null || !url.startsWith(UPDATE_URL_PREFIX)) {
                toWeb("error", "अनजान डाउनलोड पता — रोका गया।");
                return;
            }
            runOnUiThread(new Runnable() {
                @Override public void run() {
                    try {
                        File apk = updateFile();
                        if (apk == null) { toWeb("error", "फ़ोन में जगह नहीं मिली।"); return; }
                        if (apk.exists() && !apk.delete()) { toWeb("error", "पुरानी फ़ाइल नहीं हटी।"); return; }

                        DownloadManager dm = (DownloadManager) getSystemService(Context.DOWNLOAD_SERVICE);
                        if (dm == null) { toWeb("error", "DownloadManager उपलब्ध नहीं।"); return; }

                        DownloadManager.Request r = new DownloadManager.Request(Uri.parse(url));
                        r.setTitle("JCM लोडिंग — अपडेट");
                        r.setDescription("नई APK उतर रही है…");
                        r.setMimeType("application/vnd.android.package-archive");
                        r.setDestinationUri(Uri.fromFile(apk));
                        r.setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED);
                        updateDownloadId = dm.enqueue(r);
                        toWeb("downloading", "");
                    } catch (Exception e) {
                        toWeb("error", "डाउनलोड शुरू नहीं हुआ: " + e.getMessage());
                    }
                }
            });
        }
    }
}
