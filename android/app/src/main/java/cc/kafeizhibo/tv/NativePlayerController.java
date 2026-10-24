package cc.kafeizhibo.tv;

import android.content.Context;
import android.graphics.Color;
import android.os.Handler;
import android.os.Looper;
import android.view.LayoutInflater;
import android.view.View;
import android.webkit.JavascriptInterface;
import android.widget.FrameLayout;

import androidx.media3.common.MediaItem;
import androidx.media3.common.PlaybackException;
import androidx.media3.common.Player;
import androidx.media3.datasource.DefaultHttpDataSource;
import androidx.media3.exoplayer.ExoPlayer;
import androidx.media3.exoplayer.hls.HlsMediaSource;
import androidx.media3.ui.AspectRatioFrameLayout;
import androidx.media3.ui.PlayerView;

/** Native HLS playback surface used by the Android shell. The WebView remains the control layer. */
final class NativePlayerController {
    interface Listener { void onPlaybackEvent(String event, String detail); }

    private final Handler main = new Handler(Looper.getMainLooper());
    private final PlayerView playerView;
    private final Listener listener;
    private ExoPlayer player;

    NativePlayerController(Context context, FrameLayout root, Listener listener) {
        this.listener = listener;
        playerView = (PlayerView) LayoutInflater.from(context)
                .inflate(R.layout.native_player, root, false);
        playerView.setUseController(false);
        playerView.setFocusable(false);
        playerView.setFocusableInTouchMode(false);
        playerView.setBackgroundColor(Color.TRANSPARENT);
        playerView.setResizeMode(AspectRatioFrameLayout.RESIZE_MODE_FIT);
        playerView.setShutterBackgroundColor(Color.TRANSPARENT);
        playerView.setKeepContentOnPlayerReset(true);
        playerView.setVisibility(View.GONE);
        root.addView(playerView, 0, new FrameLayout.LayoutParams(-1, -1));
    }

    Object bridge() { return new Bridge(); }

    void pause() {
        main.post(new Runnable() { @Override public void run() {
            if (player != null) player.pause();
        }});
    }

    void destroy() {
        main.post(new Runnable() { @Override public void run() { release(); }});
    }

    private void open(final String url) {
        if (url == null || url.length() == 0) {
            emit("error", "empty playback URL");
            return;
        }
        release();
        playerView.setVisibility(View.VISIBLE);
        DefaultHttpDataSource.Factory dataSource = new DefaultHttpDataSource.Factory()
                .setUserAgent("Mozilla/5.0 (Linux; Android 6.0; TV) AppleWebKit/537.36 Chrome/120 Safari/537.36")
                .setAllowCrossProtocolRedirects(true);
        final ExoPlayer nextPlayer = new ExoPlayer.Builder(playerView.getContext()).build();
        player = nextPlayer;
        playerView.setPlayer(nextPlayer);
        HlsMediaSource mediaSource = new HlsMediaSource.Factory(dataSource)
                .createMediaSource(MediaItem.fromUri(url));
        nextPlayer.addListener(new Player.Listener() {
            @Override public void onPlaybackStateChanged(int state) {
                if (player != nextPlayer) return;
                if (state == Player.STATE_BUFFERING) emit("buffering", "");
                else if (state == Player.STATE_ENDED) emit("ended", "");
            }

            @Override public void onIsPlayingChanged(boolean isPlaying) {
                if (player != nextPlayer) return;
                if (isPlaying) emit("playing", "");
                else if (nextPlayer.getPlaybackState() == Player.STATE_READY) emit("paused", "");
            }

            @Override public void onPlayerError(PlaybackException error) {
                if (player != nextPlayer) return;
                playerView.setVisibility(View.GONE);
                emit("error", error == null ? "native playback error" : error.getMessage());
            }
        });
        emit("buffering", "");
        nextPlayer.setMediaSource(mediaSource);
        nextPlayer.prepare();
        nextPlayer.play();
    }

    private void toggle() {
        if (player == null) return;
        if (player.isPlaying()) player.pause();
        else player.play();
    }

    void close() { main.post(new Runnable() { @Override public void run() { release(); }}); }

    private void release() {
        if (player != null) {
            playerView.setPlayer(null);
            player.release();
            player = null;
        }
        playerView.setVisibility(View.GONE);
    }

    private void emit(String event, String detail) {
        if (listener != null) listener.onPlaybackEvent(event, detail == null ? "" : detail);
    }

    final class Bridge {
        @JavascriptInterface public void open(final String url, String title) {
            main.post(new Runnable() { @Override public void run() { NativePlayerController.this.open(url); }});
        }
        @JavascriptInterface public void toggle() {
            main.post(new Runnable() { @Override public void run() { NativePlayerController.this.toggle(); }});
        }
        @JavascriptInterface public void pause() {
            main.post(new Runnable() { @Override public void run() { NativePlayerController.this.pause(); }});
        }
        @JavascriptInterface public void close() {
            main.post(new Runnable() { @Override public void run() { NativePlayerController.this.close(); }});
        }
    }
}
