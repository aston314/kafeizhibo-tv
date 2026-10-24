package cc.kafeizhibo.tv;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.app.AlertDialog;
import android.content.Intent;
import android.net.Uri;
import android.graphics.Color;
import android.os.Bundle;
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
import java.net.HttpURLConnection;
import java.net.URL;

@UnstableApi
public final class MainActivity extends Activity {
    private final Handler handler = new Handler(Looper.getMainLooper());
    private FrameLayout root; private StartupView startup; private WebView web; private AppUpdater updater; private NativePlayerController nativePlayer; private boolean ready, destroyed, confirming; private int generation;
    @Override public void onCreate(Bundle state) { super.onCreate(state); immersive(); getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON); root = new FrameLayout(this); nativePlayer = new NativePlayerController(this, root, new NativePlayerController.Listener() { @Override public void onPlaybackEvent(String event, String detail) { dispatchPlaybackEvent(event, detail); } }); startup = new StartupView(this, new Runnable() { public void run() { restart(); } }); root.addView(startup); setContentView(root); startService(new Intent(this, CoreService.class)); waitForCore(); }
    private void immersive() { getWindow().getDecorView().setSystemUiVisibility(5894); }
    private void restart() { if (nativePlayer != null) nativePlayer.close(); if (web != null) { root.removeView(web); web.destroy(); web = null; } ready = false; startup.setVisibility(View.VISIBLE); startup.setStatus(getString(R.string.startup_retry, getString(R.string.app_name)), true); startService(new Intent(this, CoreService.class)); waitForCore(); }
    private void waitForCore() { final int current = ++generation; new Thread(new Runnable() { public void run() { long deadline = System.currentTimeMillis() + 30000; while (!destroyed && current == generation && System.currentTimeMillis() < deadline) { CoreEndpoint value = CoreService.endpoint(); if (value != null && check(value)) { handler.post(new Runnable() { public void run() { if (!destroyed && current == generation) load(value); } }); return; } try { Thread.sleep(200); } catch (InterruptedException ignored) { return; } } handler.post(new Runnable() { public void run() { if (!destroyed && current == generation) startup.setStatus(getString(R.string.startup_error, getString(R.string.app_name)), false); } }); } }, "kafei-core-wait").start(); }
    private boolean check(CoreEndpoint endpoint) { HttpURLConnection connection = null; try { connection = (HttpURLConnection) new URL(endpoint.url + "health").openConnection(); connection.setConnectTimeout(1000); connection.setReadTimeout(1000); return connection.getResponseCode() == 200; } catch (Exception ignored) { return false; } finally { if (connection != null) connection.disconnect(); } }
    @SuppressLint("SetJavaScriptEnabled") private void load(final CoreEndpoint endpoint) { web = new WebView(this); final WebView page = web; web.setBackgroundColor(Color.TRANSPARENT); web.setFocusable(true); web.setFocusableInTouchMode(true); web.getSettings().setJavaScriptEnabled(true); web.getSettings().setDomStorageEnabled(true); web.getSettings().setMediaPlaybackRequiresUserGesture(false); web.addJavascriptInterface(new AppBridge(), "KafeiTVApp"); web.addJavascriptInterface(nativePlayer.bridge(), "KafeiTVPlayer"); if (updater == null) updater = new AppUpdater(this); web.addJavascriptInterface(updater.new Bridge(), "KafeiUpdate"); web.setWebViewClient(new WebViewClient() { public boolean shouldOverrideUrlLoading(WebView view, String url) { return !url.startsWith(endpoint.url); } public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) { if (request.isForMainFrame()) startup.setStatus(getString(R.string.startup_page_error), false); } public void onPageFinished(WebView view, String url) { if (page != web || destroyed) return; ready = true; startup.pauseAnimation(); startup.setVisibility(View.GONE); view.requestFocus(); immersive(); } });
        // Keep the WebView above the native video surface. The page owns the
        // focusable source list and controls; the native view only renders HLS.
        root.addView(web, 1, new FrameLayout.LayoutParams(-1, -1));
        web.loadUrl(endpoint.url); }
    private void dispatchPlaybackEvent(String event, String detail) { if (web == null || destroyed) return; final String name = JSONObject.quote(event == null ? "" : event); final String message = JSONObject.quote(detail == null ? "" : detail); web.evaluateJavascript("window.KafeiNativePlaybackEvent&&window.KafeiNativePlaybackEvent(" + name + "," + message + ");", null); }
    private final class AppBridge {
        @JavascriptInterface public void diagnostics(String value) { }
        @JavascriptInterface public void openUrl(String value) {
            if (value == null || !(value.startsWith("https://") || value.startsWith("http://"))) return;
            try { startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(value))); } catch (Exception ignored) { }
        }
        @JavascriptInterface public void restartCore() { handler.post(new Runnable() { public void run() { restart(); } }); }
    }
    @Override public boolean dispatchKeyEvent(KeyEvent event) { if (ready && web != null && event.getAction() == KeyEvent.ACTION_DOWN) { int code = event.getKeyCode(); if (code == KeyEvent.KEYCODE_DPAD_UP || code == KeyEvent.KEYCODE_DPAD_DOWN || code == KeyEvent.KEYCODE_DPAD_LEFT || code == KeyEvent.KEYCODE_DPAD_RIGHT || code == KeyEvent.KEYCODE_DPAD_CENTER || code == KeyEvent.KEYCODE_ENTER) { web.evaluateJavascript("window.MingmingTVKey&&window.MingmingTVKey(" + code + ");", null); return true; } } return super.dispatchKeyEvent(event); }
    @Override public void onBackPressed() { if (!ready || web == null) { confirmExit(); return; } web.evaluateJavascript("window.MingmingTVBack?window.MingmingTVBack():false", new ValueCallback<String>() { public void onReceiveValue(String value) { if (!"true".equals(value)) confirmExit(); } }); }
    private void confirmExit() { if (confirming || destroyed) return; confirming = true; new AlertDialog.Builder(this).setTitle("退出球赛直播？").setNegativeButton("取消", (dialog, which) -> confirming = false).setPositiveButton("退出", (dialog, which) -> { confirming = false; stopService(new Intent(this, CoreService.class)); finish(); }).setOnCancelListener(dialog -> confirming = false).show(); }
    @Override protected void onResume() { super.onResume(); immersive(); if (!ready && startup != null) startup.resumeAnimation(); if (updater != null) updater.resume(); if (web != null) { web.onResume(); web.evaluateJavascript("window.KafeiTVResume&&window.KafeiTVResume()", null); } }
    @Override protected void onPause() { if (!ready && startup != null) startup.pauseAnimation(); if (nativePlayer != null) nativePlayer.pause(); if (web != null) { web.evaluateJavascript("window.MingmingTVBackground&&window.MingmingTVBackground()", null); web.onPause(); } super.onPause(); }
    @Override protected void onDestroy() { destroyed = true; generation++; handler.removeCallbacksAndMessages(null); if (nativePlayer != null) { nativePlayer.destroy(); nativePlayer = null; } if (web != null) { web.destroy(); web = null; } if (updater != null) { updater.destroy(); updater = null; } stopService(new Intent(this, CoreService.class)); super.onDestroy(); }
}
