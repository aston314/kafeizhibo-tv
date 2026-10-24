package cc.kafeizhibo.tv;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.app.AlertDialog;
import android.content.Intent;
import android.content.ComponentName;
import android.content.Context;
import android.content.ServiceConnection;
import android.net.Uri;
import android.graphics.Color;
import android.os.Bundle;
import android.os.IBinder;
import android.os.Handler;
import android.os.Looper;
import android.view.KeyEvent;
import android.view.View;
import android.view.WindowManager;
import android.webkit.JavascriptInterface;
import android.webkit.ValueCallback;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import androidx.media3.common.util.UnstableApi;
import org.json.JSONObject;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.Proxy;
import java.net.URL;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

@UnstableApi
public final class MainActivity extends Activity {
    private final Handler handler = new Handler(Looper.getMainLooper());
    private final ExecutorService coreWorker = Executors.newSingleThreadExecutor();
    private FrameLayout root; private StartupView startup; private WebView web; private AppUpdater updater; private NativePlayerController nativePlayer;
    private boolean ready, confirming, bound, connecting, checking, pageNeedsRefresh;
    private volatile boolean destroyed, visible;
    private volatile int generation;
    private volatile CoreService coreService;
    private CoreEndpoint loadedEndpoint;
    private String savedPageState = "null";
    private int healthFailures;
    private final CoreRestartPolicy pageRecoveries = new CoreRestartPolicy();
    private final Runnable healthWatch = () -> checkConnection();
    private final ServiceConnection serviceConnection = new ServiceConnection() {
        @Override public void onServiceConnected(ComponentName name, IBinder binder) {
            if (destroyed) return;
            coreService = ((CoreService.LocalBinder) binder).service();
            if (visible && !ready && !connecting) connect(null, false);
            else scheduleHealthCheck(0);
        }
        @Override public void onServiceDisconnected(ComponentName name) {
            coreService = null;
            if (visible && !connecting) connect(null, false);
        }
        @Override public void onBindingDied(ComponentName name) {
            releaseBinding();
            if (!destroyed) bindCore();
        }
    };
    @Override public void onCreate(Bundle state) { super.onCreate(state); immersive(); getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON); root = new FrameLayout(this); nativePlayer = new NativePlayerController(this, root, new NativePlayerController.Listener() { @Override public void onPlaybackEvent(String event, String detail) { dispatchPlaybackEvent(event, detail); } }); startup = new StartupView(this, new Runnable() { public void run() { restart(); } }); root.addView(startup); setContentView(root); if (state != null) savedPageState = state.getString("page-state", "null"); bindCore(); }
    private void immersive() { getWindow().getDecorView().setSystemUiVisibility(5894); }
    private void bindCore() {
        if (destroyed || bound) return;
        bound = bindService(new Intent(this, CoreService.class), serviceConnection, Context.BIND_AUTO_CREATE);
        if (!bound) startup.setStatus(getString(R.string.connection_failed), false);
    }

    private void releaseBinding() {
        coreService = null;
        if (bound) { bound = false; unbindService(serviceConnection); }
    }

    private void restart() { connect(null, true); }

    private void capturePageState(final WebView page, final Runnable after) {
        if (page == null) { if (after != null) after.run(); return; }
        page.evaluateJavascript("window.KafeiTVSaveState?window.KafeiTVSaveState():null", value -> {
            if (!destroyed && page == web && value != null && value.length() < 8192) {
                try { savedPageState = new JSONObject(value).toString(); }
                catch (Exception ignored) { }
            }
            if (after != null) after.run();
        });
    }

    private void connect(final String failedInstance, final boolean manual) {
        if (destroyed || !visible || isFinishing() || (connecting && !manual)) return;
        if (manual) pageRecoveries.reset();
        else if (loadedEndpoint != null && pageRecoveries.nextDelay(android.os.SystemClock.elapsedRealtime()) < 0) {
            ready = false; connecting = false; checking = false;
            handler.removeCallbacks(healthWatch);
            startup.setVisibility(View.VISIBLE); startup.bringToFront();
            startup.setStatus(getString(R.string.connection_failed), false);
            return;
        }
        final int token = ++generation;
        connecting = true; checking = false; ready = false; pageNeedsRefresh = false;
        healthFailures = 0;
        handler.removeCallbacks(healthWatch);
        startup.setVisibility(View.VISIBLE); startup.bringToFront();
        startup.setStatus(loadedEndpoint == null ? getString(R.string.startup_status, getString(R.string.app_name)) : getString(R.string.connection_recovering), true);
        final boolean[] started = { false };
        Runnable begin = () -> {
            if (started[0] || destroyed || !visible || generation != token) return;
            started[0] = true;
            if (nativePlayer != null) nativePlayer.pause();
            bindCore();
            CoreService service = coreService;
            if (service != null) {
                if (manual || failedInstance != null) service.recover(failedInstance, manual);
                else service.ensureRunning();
            }
            waitForCore(token);
        };
        // A stalled renderer must not prevent recovery of the local service.
        if (web != null) handler.postDelayed(begin, 150);
        capturePageState(web, begin);
    }

    private void waitForCore(final int token) {
        final long waitBudget = loadedEndpoint == null ? 15000 : 6000;
        coreWorker.execute(() -> {
            long deadline = android.os.SystemClock.elapsedRealtime() + waitBudget;
            while (!destroyed && visible && token == generation && android.os.SystemClock.elapsedRealtime() < deadline) {
                CoreService service = coreService;
                CoreEndpoint endpoint = service == null ? null : service.endpoint();
                if (endpoint != null && check(endpoint)) {
                    handler.post(() -> {
                        if (destroyed || !visible || token != generation) return;
                        if (coreService == service && service.endpoint() == endpoint) load(endpoint);
                        else waitForCore(token);
                    });
                    return;
                }
                try { Thread.sleep(200); }
                catch (InterruptedException stopped) { Thread.currentThread().interrupt(); return; }
            }
            handler.post(() -> {
                if (!destroyed && visible && token == generation) {
                    connecting = false;
                    startup.setStatus(getString(R.string.connection_failed), false);
                }
            });
        });
    }

    private boolean check(CoreEndpoint endpoint) {
        HttpURLConnection connection = null;
        try {
            connection = (HttpURLConnection) new URL(endpoint.url + "health").openConnection(Proxy.NO_PROXY);
            connection.setConnectTimeout(600); connection.setReadTimeout(600); connection.setUseCaches(false);
            connection.setInstanceFollowRedirects(false);
            if (connection.getResponseCode() != 200) return false;
            try (InputStream input = connection.getInputStream(); ByteArrayOutputStream body = new ByteArrayOutputStream()) {
                byte[] buffer = new byte[1024]; int count;
                while ((count = input.read(buffer)) != -1) {
                    if (body.size() + count > 8192) return false;
                    body.write(buffer, 0, count);
                }
                JSONObject health = new JSONObject(body.toString("UTF-8"));
                return health.optBoolean("ready") && endpoint.instance.equals(health.optString("instanceId"));
            }
        } catch (Exception unavailable) { return false; }
        finally { if (connection != null) connection.disconnect(); }
    }

    private void scheduleHealthCheck(long delay) {
        handler.removeCallbacks(healthWatch);
        if (!destroyed && visible && ready && !connecting) handler.postDelayed(healthWatch, delay);
    }

    private void checkConnection() {
        if (destroyed || !visible || !ready || connecting || checking) return;
        checking = true;
        final int token = generation;
        final CoreService service = coreService;
        final CoreEndpoint endpoint = service == null ? null : service.endpoint();
        coreWorker.execute(() -> {
            final boolean healthy = endpoint != null && check(endpoint);
            handler.post(() -> {
                if (destroyed || !visible || token != generation) return;
                checking = false;
                boolean current = service != null && coreService == service && service.endpoint() == endpoint;
                if (healthy && current && loadedEndpoint != null && loadedEndpoint.instance.equals(endpoint.instance)) {
                    healthFailures = 0;
                    if (pageNeedsRefresh && web != null) {
                        pageNeedsRefresh = false;
                        // The core is healthy: rebuild only the failed WebView,
                        // retaining the service and its metadata cache.
                        connect(null, false);
                        return;
                    }
                    scheduleHealthCheck(3000);
                } else if (healthy && current) connect(null, false);
                else if (pageNeedsRefresh || endpoint == null || ++healthFailures >= 2) connect(current && endpoint != null ? endpoint.instance : null, false);
                else scheduleHealthCheck(300);
            });
        });
    }

    @Override protected void onStart() {
        super.onStart(); visible = true;
        pageRecoveries.reset();
        if (coreService != null && !ready && !connecting) connect(null, false);
        else scheduleHealthCheck(0);
    }

    @Override protected void onStop() {
        visible = false; generation++; checking = false; connecting = false;
        handler.removeCallbacks(healthWatch);
        super.onStop();
    }

    @Override protected void onSaveInstanceState(Bundle state) {
        state.putString("page-state", savedPageState);
        super.onSaveInstanceState(state);
    }
    @SuppressLint("SetJavaScriptEnabled")
    private void load(final CoreEndpoint endpoint) {
        if (web != null) { root.removeView(web); web.destroy(); }
        if (nativePlayer != null) nativePlayer.close();
        loadedEndpoint = endpoint;
        final int loadToken = generation;
        web = new WebView(this);
        final WebView page = web;
        web.setBackgroundColor(Color.TRANSPARENT);
        web.setFocusable(true);
        web.setFocusableInTouchMode(true);
        web.getSettings().setJavaScriptEnabled(true);
        web.getSettings().setDomStorageEnabled(true);
        web.getSettings().setMediaPlaybackRequiresUserGesture(false);
        web.addJavascriptInterface(new AppBridge(), "KafeiTVApp");
        web.addJavascriptInterface(nativePlayer.bridge(), "KafeiTVPlayer");
        if (updater == null) updater = new AppUpdater(this);
        web.addJavascriptInterface(updater.new Bridge(), "KafeiUpdate");
        web.setWebViewClient(new WebViewClient() {
            @Override public boolean shouldOverrideUrlLoading(WebView view, String url) {
                return !url.startsWith(endpoint.url);
            }
            @Override public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
                if (page == web && loadToken == generation && request.isForMainFrame()) {
                    connecting = false; ready = false;
                    startup.setVisibility(View.VISIBLE);
                    startup.setStatus(getString(R.string.startup_page_error), false);
                }
            }
            @Override public void onPageFinished(WebView view, String url) {
                if (page != web || destroyed || loadToken != generation) return;
                ready = true; connecting = false;
                startup.pauseAnimation(); startup.setVisibility(View.GONE);
                if (!"null".equals(savedPageState)) {
                    String restored = savedPageState; savedPageState = "null";
                    view.evaluateJavascript("window.KafeiTVRestoreState&&window.KafeiTVRestoreState(" + restored + ")", null);
                }
                view.requestFocus(); immersive(); scheduleHealthCheck(3000);
            }
        });
        // The WebView owns focus and controls, above the native video surface.
        root.addView(web, 1, new FrameLayout.LayoutParams(-1, -1));
        web.loadUrl(endpoint.url);
    }
    private void dispatchPlaybackEvent(String event, String detail) { if (web == null || destroyed) return; final String name = JSONObject.quote(event == null ? "" : event); final String message = JSONObject.quote(detail == null ? "" : detail); web.evaluateJavascript("window.KafeiNativePlaybackEvent&&window.KafeiNativePlaybackEvent(" + name + "," + message + ");", null); }
    private final class AppBridge {
        @JavascriptInterface public void diagnostics(String value) { }
        @JavascriptInterface public void openUrl(String value) {
            if (value == null || !(value.startsWith("https://") || value.startsWith("http://"))) return;
            try { startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(value))); } catch (Exception ignored) { }
        }
        @JavascriptInterface public void recoverCore() { handler.post(() -> { pageNeedsRefresh = true; if (!connecting) { if (ready) checkConnection(); else connect(null, false); } }); }
        @JavascriptInterface public void restartCore() { handler.post(new Runnable() { public void run() { restart(); } }); }
    }
    @Override public boolean dispatchKeyEvent(KeyEvent event) { if (ready && web != null && event.getAction() == KeyEvent.ACTION_DOWN) { int code = event.getKeyCode(); if (code == KeyEvent.KEYCODE_DPAD_UP || code == KeyEvent.KEYCODE_DPAD_DOWN || code == KeyEvent.KEYCODE_DPAD_LEFT || code == KeyEvent.KEYCODE_DPAD_RIGHT || code == KeyEvent.KEYCODE_DPAD_CENTER || code == KeyEvent.KEYCODE_ENTER) { web.evaluateJavascript("window.MingmingTVKey&&window.MingmingTVKey(" + code + ");", null); return true; } } return super.dispatchKeyEvent(event); }
    @Override public void onBackPressed() { if (!ready || web == null) { confirmExit(); return; } web.evaluateJavascript("window.MingmingTVBack?window.MingmingTVBack():false", new ValueCallback<String>() { public void onReceiveValue(String value) { if (!"true".equals(value)) confirmExit(); } }); }
    private void confirmExit() { if (confirming || destroyed) return; confirming = true; new AlertDialog.Builder(this).setTitle("退出球赛直播？").setNegativeButton("取消", (dialog, which) -> confirming = false).setPositiveButton("退出", (dialog, which) -> { confirming = false; finish(); }).setOnCancelListener(dialog -> confirming = false).show(); }
    @Override protected void onResume() { super.onResume(); immersive(); if (!ready && startup != null) startup.resumeAnimation(); if (updater != null) updater.resume(); if (web != null) { web.onResume(); web.evaluateJavascript("window.KafeiTVResume&&window.KafeiTVResume()", null); } scheduleHealthCheck(0); }
    @Override protected void onPause() { capturePageState(web, null); if (!ready && startup != null) startup.pauseAnimation(); if (nativePlayer != null) nativePlayer.pause(); if (web != null) { web.evaluateJavascript("window.MingmingTVBackground&&window.MingmingTVBackground()", null); web.onPause(); } super.onPause(); }
    @Override protected void onDestroy() { destroyed = true; generation++; handler.removeCallbacksAndMessages(null); coreWorker.shutdownNow(); if (nativePlayer != null) { nativePlayer.destroy(); nativePlayer = null; } if (web != null) { web.destroy(); web = null; } if (updater != null) { updater.destroy(); updater = null; } releaseBinding(); super.onDestroy(); }
}
