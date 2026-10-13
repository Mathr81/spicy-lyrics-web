package io.github.mathr81.spicylyrics;

import android.app.Activity;
import android.app.AlertDialog;
import android.app.PendingIntent;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.content.pm.PackageInstaller;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.util.Log;
import android.webkit.JavascriptInterface;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Toast;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.InputStream;
import java.io.OutputStream;
import java.net.URL;
import java.util.Scanner;

/**
 * The whole app: the hosted web page in a WebView drawn under the system bars,
 * and a self-updater.
 *
 * The page is loaded from the web deploy, so everything in it updates by itself.
 * Only this shell needs a new APK; CI publishes each build as the GitHub release
 * "android-v<versionCode>", and that is where the updater looks.
 */
public class MainActivity extends Activity {
    private static final String TAG = "SpicyLyrics";
    private static final String RELEASE_TAG_PREFIX = "android-v";

    private WebView web;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        // Edge to edge: the page gets the full window and keeps its own content
        // clear of the bars with env(safe-area-inset-*).
        getWindow().setDecorFitsSystemWindows(false);

        web = new WebView(this);
        web.setBackgroundColor(Color.BLACK);
        WebSettings settings = web.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true); // the Spotify session and every setting
        settings.setUseWideViewPort(true); // honour the page's viewport meta, as Chrome does
        web.addJavascriptInterface(this, "SpicyNative");
        web.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                Uri url = request.getUrl();
                String host = String.valueOf(url.getHost());
                // The app and Spotify's login stay here; any other page the user
                // opens (a contributor's profile, a track on Spotify) is a link out.
                boolean ours = host.equals(Uri.parse(BuildConfig.APP_URL).getHost())
                        || (host.endsWith(".spotify.com") && !host.equals("open.spotify.com"));
                if (ours || !request.isForMainFrame()) return false;
                try {
                    startActivity(new Intent(Intent.ACTION_VIEW, url));
                } catch (ActivityNotFoundException e) {
                    Log.w(TAG, "nothing can open " + url);
                }
                return true;
            }
        });
        setContentView(web);
        web.loadUrl(BuildConfig.APP_URL);

        checkForUpdate();
    }

    /**
     * Called by the page (web/src/wakelock.ts) while something is playing: a
     * WebView has no Screen Wake Lock API of its own.
     */
    @JavascriptInterface
    public void keepAwake(boolean on) {
        runOnUiThread(() -> web.setKeepScreenOn(on));
    }

    // --- Self-update -------------------------------------------------------

    private void checkForUpdate() {
        new Thread(() -> {
            try {
                // Newest first; other kinds of release may share the repo.
                JSONArray releases = new JSONArray(
                        read("https://api.github.com/repos/" + BuildConfig.REPO + "/releases?per_page=30"));
                for (int i = 0; i < releases.length(); i++) {
                    JSONObject release = releases.getJSONObject(i);
                    String tag = release.getString("tag_name");
                    if (!tag.startsWith(RELEASE_TAG_PREFIX)) continue;
                    int version = Integer.parseInt(tag.substring(RELEASE_TAG_PREFIX.length()));
                    JSONArray assets = release.getJSONArray("assets");
                    if (version > BuildConfig.VERSION_CODE && assets.length() > 0) {
                        String apk = assets.getJSONObject(0).getString("browser_download_url");
                        runOnUiThread(() -> offerUpdate(version, apk));
                    }
                    return;
                }
            } catch (Exception e) {
                // Offline, rate-limited, no release yet: try again next launch.
                Log.w(TAG, "update check failed", e);
            }
        }).start();
    }

    private static String read(String url) throws Exception {
        try (InputStream in = new URL(url).openStream();
             Scanner scanner = new Scanner(in, "UTF-8").useDelimiter("\\A")) {
            return scanner.hasNext() ? scanner.next() : "";
        }
    }

    // Asked rather than done silently: installing ends the running app.
    private void offerUpdate(int version, String apkUrl) {
        if (isFinishing() || isDestroyed()) return;
        new AlertDialog.Builder(this)
                .setTitle("Mise à jour disponible")
                .setMessage("La version " + version + " de l'app est prête (vous avez la "
                        + BuildConfig.VERSION_CODE + ").")
                .setNegativeButton("Plus tard", null)
                .setPositiveButton("Installer", (dialog, which) -> install(apkUrl))
                .show();
    }

    private void install(String apkUrl) {
        toast("Téléchargement de la mise à jour…");
        new Thread(() -> {
            try {
                PackageInstaller installer = getPackageManager().getPackageInstaller();
                PackageInstaller.SessionParams params =
                        new PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL);
                // Android 12+: no system prompt once this app is the one that
                // installed itself, i.e. from its second update on.
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                    params.setRequireUserAction(PackageInstaller.SessionParams.USER_ACTION_NOT_REQUIRED);
                }
                try (PackageInstaller.Session session = installer.openSession(installer.createSession(params))) {
                    try (InputStream in = new URL(apkUrl).openStream();
                         OutputStream out = session.openWrite("update.apk", 0, -1)) {
                        byte[] buffer = new byte[1 << 16];
                        for (int n; (n = in.read(buffer)) != -1; ) out.write(buffer, 0, n);
                        session.fsync(out);
                    }
                    // The outcome comes back to onNewIntent. Android checks the
                    // signature: an APK not signed with this app's key is refused.
                    Intent result = new Intent(this, MainActivity.class);
                    session.commit(PendingIntent.getActivity(this, 0, result,
                            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_MUTABLE).getIntentSender());
                }
            } catch (Exception e) {
                Log.w(TAG, "update failed", e);
                runOnUiThread(() -> toast("Mise à jour impossible : " + e.getMessage()));
            }
        }).start();
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        int status = intent.getIntExtra(PackageInstaller.EXTRA_STATUS, PackageInstaller.STATUS_SUCCESS);
        if (status == PackageInstaller.STATUS_PENDING_USER_ACTION) {
            // The system's own "install this update?" screen.
            startActivity((Intent) intent.getParcelableExtra(Intent.EXTRA_INTENT));
        } else if (status != PackageInstaller.STATUS_SUCCESS) {
            toast("Mise à jour impossible : " + intent.getStringExtra(PackageInstaller.EXTRA_STATUS_MESSAGE));
        }
    }

    private void toast(String text) {
        Toast.makeText(this, text, Toast.LENGTH_LONG).show();
    }
}
