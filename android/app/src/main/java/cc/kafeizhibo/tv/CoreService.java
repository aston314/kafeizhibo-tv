package cc.kafeizhibo.tv;

import android.app.Service;
import android.content.Intent;
import android.os.Binder;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.os.SystemClock;
import android.util.Log;
import java.io.File;

public final class CoreService extends Service {
    private final Handler handler = new Handler(Looper.getMainLooper());
    private final CoreRestartPolicy retries = new CoreRestartPolicy();
    private final IBinder binder = new LocalBinder();
    private CoreProcessSupervisor supervisor;
    private boolean destroyed;
    private final Runnable retry = () -> {
        if (!destroyed && supervisor != null) supervisor.ensureRunning();
    };

    final class LocalBinder extends Binder {
        CoreService service() { return CoreService.this; }
    }

    @Override public void onCreate() {
        super.onCreate();
        supervisor = new CoreProcessSupervisor(instance -> {
            File binary = new File(getApplicationInfo().nativeLibraryDir, "libkafeitv.so");
            return new ProcessBuilder(binary.getAbsolutePath(), "-port", "0", "-instance-id", instance)
                    .redirectErrorStream(true).start();
        }, new CoreProcessSupervisor.Listener() {
            @Override public void stopped() { handler.post(() -> scheduleRecovery()); }
            @Override public void log(String line) { Log.i("KafeiTV", line); }
        });
    }

    @Override public IBinder onBind(Intent intent) {
        ensureRunning();
        return binder;
    }

    CoreEndpoint endpoint() { return supervisor == null ? null : supervisor.endpoint(); }

    void ensureRunning() {
        if (!destroyed && supervisor != null) supervisor.ensureRunning();
    }

    void recover(String expectedInstance, boolean manual) {
        if (destroyed || supervisor == null) return;
        if (manual) retries.reset();
        else if (retries.nextDelay(SystemClock.elapsedRealtime()) < 0) return;
        handler.removeCallbacks(retry);
        supervisor.restart(expectedInstance);
    }

    private void scheduleRecovery() {
        if (destroyed) return;
        handler.removeCallbacks(retry);
        long delay = retries.nextDelay(SystemClock.elapsedRealtime());
        if (delay >= 0) handler.postDelayed(retry, delay);
    }

    @Override public void onDestroy() {
        destroyed = true;
        handler.removeCallbacksAndMessages(null);
        if (supervisor != null) supervisor.close();
        super.onDestroy();
    }
}
