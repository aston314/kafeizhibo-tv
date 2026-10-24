package cc.kafeizhibo.tv;

import java.io.BufferedReader;
import java.io.IOException;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.util.UUID;

/** Owns exactly one child; stale readers cannot publish or clear its endpoint. */
final class CoreProcessSupervisor {
    interface Launcher { Process launch(String instance) throws IOException; }
    interface Listener {
        void stopped();
        void log(String line);
    }

    private final Launcher launcher;
    private final Listener listener;
    private Process process;
    private CoreEndpoint endpoint;
    private long generation;
    private boolean closed;

    CoreProcessSupervisor(Launcher launcher, Listener listener) {
        this.launcher = launcher;
        this.listener = listener;
    }

    synchronized CoreEndpoint endpoint() { return endpoint; }

    synchronized boolean ensureRunning() {
        if (closed) return false;
        if (running(process)) return true;
        endpoint = null;
        final String instance = UUID.randomUUID().toString();
        final long token = ++generation;
        final Process child;
        try {
            child = launcher.launch(instance);
            process = child;
        } catch (IOException error) {
            process = null;
            listener.log("core launch failed: " + error.getClass().getSimpleName());
            listener.stopped();
            return false;
        }
        Thread reader = new Thread(() -> read(child, instance, token), "tv-core-output");
        reader.setDaemon(true);
        reader.start();
        return true;
    }

    synchronized void restart(String expectedInstance) {
        if (closed) return;
        if (expectedInstance != null && (endpoint == null || !expectedInstance.equals(endpoint.instance))) {
            ensureRunning();
            return;
        }
        detach();
        ensureRunning();
    }

    synchronized void close() {
        closed = true;
        detach();
    }

    private void detach() {
        Process child = process;
        process = null;
        endpoint = null;
        generation++;
        if (child != null) child.destroy();
    }

    private static boolean running(Process child) {
        if (child == null) return false;
        try { child.exitValue(); return false; }
        catch (IllegalThreadStateException alive) { return true; }
    }

    private void read(Process child, String instance, long token) {
        try (BufferedReader reader = new BufferedReader(new InputStreamReader(child.getInputStream(), StandardCharsets.UTF_8))) {
            String line;
            while ((line = reader.readLine()) != null) {
                synchronized (this) {
                    if (closed || process != child || generation != token) continue;
                    CoreEndpoint ready = CoreEndpoint.parse(line, instance);
                    if (ready != null) endpoint = ready;
                    else listener.log(line);
                }
            }
        } catch (IOException error) {
            // Losing the output/readiness pipe makes this child unusable.
        } finally {
            synchronized (this) {
                if (!closed && process == child && generation == token) {
                    process = null;
                    endpoint = null;
                    child.destroy();
                    listener.stopped();
                }
            }
        }
    }
}
