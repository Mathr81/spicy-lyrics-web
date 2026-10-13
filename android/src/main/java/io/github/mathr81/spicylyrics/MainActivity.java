package io.github.mathr81.spicylyrics;

import android.app.Activity;
import android.app.AlertDialog;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.PictureInPictureParams;
import android.content.ActivityNotFoundException;
import android.content.ComponentName;
import android.content.Intent;
import android.content.pm.PackageInstaller;
import android.content.res.Configuration;
import android.graphics.Color;
import android.media.MediaMetadata;
import android.media.session.MediaController;
import android.media.session.MediaSessionManager;
import android.media.session.PlaybackState;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.SystemClock;
import android.provider.Settings;
import android.util.Log;
import android.util.Rational;
import android.view.HapticFeedbackConstants;
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
import java.util.List;
import java.util.Scanner;

/**
 * The whole app: the hosted web page in a WebView drawn under the system bars,
 * plus what a page cannot do by itself — float over other apps, read Spotify's
 * playback on this phone, hold the screen on, update the app.
 *
 * The page is loaded from the web deploy, so everything in it updates by itself.
 * Only this shell needs a new APK; CI publishes each build as the GitHub release
 * "android-v<versionCode>", and that is where the updater looks.
 *
 * The page reaches this class as `window.SpicyNative` (the @JavascriptInterface
 * methods; web/src/native.ts is their other half). Those run on a WebView
 * thread, hence the runOnUiThread in each.
 */
public class MainActivity extends Activity {
    private static final String TAG = "SpicyLyrics";
    private static final String RELEASE_TAG_PREFIX = "android-v";
    private static final String SPOTIFY = "com.spotify.music";

    private WebView web;
    private boolean playing;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        // Edge to edge: the page gets the full window and keeps its own content
        // clear of the bars with env(safe-area-inset-*).
        getWindow().setDecorFitsSystemWindows(false);
        // Lyrics are for reading with the phone put down: still there after the
        // screen was locked, without unlocking.
        setShowWhenLocked(true);

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

    @Override
    protected void onResume() {
        super.onResume();
        linkSpotify(); // the user may be back from granting the access
    }

    @Override
    protected void onDestroy() {
        unlinkSpotify();
        super.onDestroy();
    }

    private void tellPage(String function, String argument) {
        web.evaluateJavascript("window." + function + "&&window." + function + "(" + argument + ")", null);
    }

    /** A WebView has no Screen Wake Lock API: the page asks for the screen here. */
    @JavascriptInterface
    public void keepAwake(boolean on) {
        runOnUiThread(() -> web.setKeepScreenOn(on));
    }

    @JavascriptInterface
    public void haptic() {
        runOnUiThread(() -> web.performHapticFeedback(HapticFeedbackConstants.CONTEXT_CLICK));
    }

    // --- Floating over other apps (picture-in-picture) ----------------------
    // Leaving the app while a song plays shrinks it to a window that stays on
    // top, so the lyrics are still there in Spotify. Paused, it just leaves.

    @JavascriptInterface
    public void setPlaying(boolean on) {
        runOnUiThread(() -> {
            playing = on;
            setPictureInPictureParams(pipParams());
        });
    }

    private PictureInPictureParams pipParams() {
        PictureInPictureParams.Builder params =
                new PictureInPictureParams.Builder().setAspectRatio(new Rational(4, 3));
        // Android 12+ shrinks the app by itself on the way home, gesture included.
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) params.setAutoEnterEnabled(playing);
        return params.build();
    }

    @Override
    protected void onUserLeaveHint() {
        super.onUserLeaveHint();
        if (playing && Build.VERSION.SDK_INT < Build.VERSION_CODES.S) {
            enterPictureInPictureMode(pipParams());
        }
    }

    @Override
    public void onPictureInPictureModeChanged(boolean floating, Configuration newConfig) {
        super.onPictureInPictureModeChanged(floating, newConfig);
        tellPage("__spicyPip", String.valueOf(floating)); // the page's small layout
    }

    // --- Spotify's media session --------------------------------------------
    // What Spotify is doing on this phone, read from the system the moment it
    // changes, instead of from Spotify's servers once a second. Android only
    // shows other apps' sessions to a notification listener the user has
    // enabled: MediaLink is that listener, and reads no notification.

    private volatile MediaController spotify;
    private boolean watchingSessions;

    private final MediaSessionManager.OnActiveSessionsChangedListener sessionsChanged = this::attach;

    private final MediaController.Callback sessionChanged = new MediaController.Callback() {
        @Override
        public void onPlaybackStateChanged(PlaybackState state) {
            reportSession();
        }

        @Override
        public void onMetadataChanged(MediaMetadata metadata) {
            reportSession();
        }

        @Override
        public void onSessionDestroyed() {
            attach(null);
        }
    };

    private ComponentName mediaLink() {
        return new ComponentName(this, MediaLink.class);
    }

    @JavascriptInterface
    public boolean linkGranted() {
        return getSystemService(NotificationManager.class).isNotificationListenerAccessGranted(mediaLink());
    }

    @JavascriptInterface
    public void requestLink() {
        runOnUiThread(() -> {
            try {
                startActivity(new Intent(Settings.ACTION_NOTIFICATION_LISTENER_DETAIL_SETTINGS)
                        .putExtra(Settings.EXTRA_NOTIFICATION_LISTENER_COMPONENT_NAME, mediaLink().flattenToString()));
            } catch (ActivityNotFoundException e) {
                startActivity(new Intent(Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS));
            }
        });
    }

    /** The page is ready to hear about the session (again, after a reload). */
    @JavascriptInterface
    public void subscribe() {
        runOnUiThread(this::linkSpotify);
    }

    private void linkSpotify() {
        if (!linkGranted()) {
            unlinkSpotify();
            return;
        }
        try {
            MediaSessionManager sessions = getSystemService(MediaSessionManager.class);
            if (!watchingSessions) {
                sessions.addOnActiveSessionsChangedListener(sessionsChanged, mediaLink());
                watchingSessions = true;
            }
            attach(sessions.getActiveSessions(mediaLink()));
        } catch (SecurityException e) {
            Log.w(TAG, "media sessions unavailable", e);
            unlinkSpotify();
        }
    }

    private void unlinkSpotify() {
        if (watchingSessions) {
            getSystemService(MediaSessionManager.class).removeOnActiveSessionsChangedListener(sessionsChanged);
            watchingSessions = false;
        }
        attach(null);
    }

    private void attach(List<MediaController> sessions) {
        MediaController found = null;
        if (sessions != null) {
            for (MediaController session : sessions) {
                if (SPOTIFY.equals(session.getPackageName())) {
                    found = session;
                    break;
                }
            }
        }
        MediaController current = spotify;
        boolean same = found != null && current != null
                && found.getSessionToken().equals(current.getSessionToken());
        if (!same) {
            if (current != null) current.unregisterCallback(sessionChanged);
            if (found != null) found.registerCallback(sessionChanged);
            spotify = found;
        }
        reportSession();
    }

    /** To the page: null without a session, else where the session is right now. */
    private void reportSession() {
        MediaController session = spotify;
        PlaybackState state = session == null ? null : session.getPlaybackState();
        MediaMetadata metadata = session == null ? null : session.getMetadata();
        String report = "null";
        if (state != null && metadata != null) {
            boolean isPlaying = state.getState() == PlaybackState.STATE_PLAYING;
            long position = state.getPosition();
            if (isPlaying) {
                position += (long) ((SystemClock.elapsedRealtime() - state.getLastPositionUpdateTime())
                        * state.getPlaybackSpeed());
            }
            try {
                report = new JSONObject()
                        .put("playing", isPlaying)
                        .put("positionMs", position)
                        .put("title", metadata.getString(MediaMetadata.METADATA_KEY_TITLE))
                        .toString();
            } catch (Exception e) {
                Log.w(TAG, "session report failed", e);
            }
        }
        tellPage("__spicyNative", report);
    }

    @JavascriptInterface
    public boolean transport(String action, double positionMs) {
        MediaController session = spotify;
        if (session == null) return false;
        MediaController.TransportControls controls = session.getTransportControls();
        switch (action) {
            case "play": controls.play(); break;
            case "pause": controls.pause(); break;
            case "next": controls.skipToNext(); break;
            case "prev": controls.skipToPrevious(); break;
            case "seek": controls.seekTo((long) positionMs); break;
            default: return false;
        }
        return true;
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
