package cc.kafeizhibo.tv;

import static org.junit.Assert.*;
import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.io.PipedInputStream;
import java.io.PipedOutputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.function.BooleanSupplier;
import org.junit.Test;

public class CoreProcessSupervisorTest {
    private static final class FakeProcess extends Process {
        final String instance;
        final PipedInputStream output = new PipedInputStream();
        final PipedOutputStream writer = new PipedOutputStream(output);
        final CountDownLatch exited = new CountDownLatch(1);
        volatile boolean alive = true, destroyed;
        volatile Thread readerThread;

        FakeProcess(String instance) throws IOException { this.instance = instance; }
        void ready(int port) throws IOException { line("KAFEI_TV_READY " + port + " " + instance); }
        void line(String value) throws IOException { writer.write((value + "\n").getBytes(StandardCharsets.UTF_8)); writer.flush(); }
        void markExited() { alive = false; exited.countDown(); }
        void finishOutput() throws IOException { writer.close(); }
        @Override public OutputStream getOutputStream() { return new ByteArrayOutputStream(); }
        @Override public InputStream getInputStream() { readerThread = Thread.currentThread(); return output; }
        @Override public InputStream getErrorStream() { return new ByteArrayInputStream(new byte[0]); }
        @Override public int waitFor() throws InterruptedException { exited.await(); return 0; }
        @Override public int exitValue() { if (alive) throw new IllegalThreadStateException(); return 0; }
        @Override public void destroy() { destroyed = true; markExited(); try { writer.close(); } catch (IOException ignored) {} }
        void joinReader() throws Exception { await(() -> readerThread != null); readerThread.join(2000); assertFalse("reader must stop", readerThread.isAlive()); }
    }

    private static final class Harness implements AutoCloseable {
        final List<FakeProcess> children = new ArrayList<>();
        final AtomicInteger stops = new AtomicInteger();
        final CoreProcessSupervisor supervisor = new CoreProcessSupervisor(instance -> {
            FakeProcess child = new FakeProcess(instance); children.add(child); return child;
        }, new CoreProcessSupervisor.Listener() {
            @Override public void stopped() { stops.incrementAndGet(); }
            @Override public void log(String line) { }
        });
        @Override public void close() { supervisor.close(); for (FakeProcess child : children) child.destroy(); }
    }

    private static void await(BooleanSupplier condition) throws InterruptedException {
        long deadline = System.nanoTime() + 2_000_000_000L;
        while (!condition.getAsBoolean() && System.nanoTime() < deadline) Thread.sleep(2);
        assertTrue("condition was not reached", condition.getAsBoolean());
    }

    @Test public void concurrentStartsShareOneChild() throws Exception {
        try (Harness h = new Harness()) {
            ExecutorService workers = Executors.newFixedThreadPool(8);
            try {
                CountDownLatch start = new CountDownLatch(1);
                List<Future<Boolean>> results = new ArrayList<>();
                for (int i = 0; i < 8; i++) results.add(workers.submit(() -> { start.await(); return h.supervisor.ensureRunning(); }));
                start.countDown();
                for (Future<Boolean> result : results) assertTrue(result.get());
                assertEquals(1, h.children.size());
            } finally { workers.shutdownNow(); }
        }
    }

    @Test public void exitClearsEndpointAndAllowsRecovery() throws Exception {
        try (Harness h = new Harness()) {
            h.supervisor.ensureRunning(); FakeProcess first = h.children.get(0);
            first.ready(12345); await(() -> h.supervisor.endpoint() != null);
            first.destroy(); first.joinReader();
            assertNull(h.supervisor.endpoint()); assertEquals(1, h.stops.get());
            assertTrue(h.supervisor.ensureRunning());
            FakeProcess second = h.children.get(1); second.ready(23456);
            await(() -> h.supervisor.endpoint() != null);
            assertEquals(second.instance, h.supervisor.endpoint().instance);
            assertEquals("http://127.0.0.1:23456/", h.supervisor.endpoint().url);
        }
    }

    @Test public void oldReadyAndOldReaderExitCannotOverwriteReplacement() throws Exception {
        try (Harness h = new Harness()) {
            h.supervisor.ensureRunning(); FakeProcess old = h.children.get(0);
            old.ready(11111); await(() -> h.supervisor.endpoint() != null);
            old.markExited(); // Its output reader intentionally finishes later.
            h.supervisor.ensureRunning(); FakeProcess current = h.children.get(1);
            current.ready(22222); await(() -> h.supervisor.endpoint() != null);
            old.ready(33333); old.finishOutput(); old.joinReader();
            assertEquals(current.instance, h.supervisor.endpoint().instance);
            assertEquals("http://127.0.0.1:22222/", h.supervisor.endpoint().url);
            assertEquals(0, h.stops.get());
        }
    }

    @Test public void staleHealthFailureDoesNotRestartNewInstance() throws Exception {
        try (Harness h = new Harness()) {
            h.supervisor.ensureRunning(); FakeProcess old = h.children.get(0);
            old.ready(11111); await(() -> h.supervisor.endpoint() != null);
            h.supervisor.restart(old.instance); FakeProcess current = h.children.get(1);
            current.ready(22222); await(() -> h.supervisor.endpoint() != null);
            h.supervisor.restart(old.instance);
            assertFalse(current.destroyed); assertEquals(2, h.children.size());
            assertEquals(current.instance, h.supervisor.endpoint().instance);
        }
    }

    @Test public void closeStopsChildAndPreventsRestart() throws Exception {
        try (Harness h = new Harness()) {
            h.supervisor.ensureRunning(); FakeProcess child = h.children.get(0);
            child.ready(12345); await(() -> h.supervisor.endpoint() != null);
            h.supervisor.close(); child.joinReader();
            assertTrue(child.destroyed); assertNull(h.supervisor.endpoint());
            assertFalse(h.supervisor.ensureRunning());
            h.supervisor.restart(null);
            assertEquals(1, h.children.size()); assertEquals(0, h.stops.get());
        }
    }

    @Test public void launchFailureIsReportedAndCanBeRetried() throws Exception {
        AtomicInteger attempts = new AtomicInteger(), stops = new AtomicInteger();
        FakeProcess child = new FakeProcess("unused");
        CoreProcessSupervisor supervisor = new CoreProcessSupervisor(instance -> {
            if (attempts.incrementAndGet() == 1) throw new IOException("cannot launch");
            return child;
        }, new CoreProcessSupervisor.Listener() {
            @Override public void stopped() { stops.incrementAndGet(); }
            @Override public void log(String line) { }
        });
        try {
            assertFalse(supervisor.ensureRunning()); assertEquals(1, stops.get());
            assertTrue(supervisor.ensureRunning()); assertEquals(2, attempts.get());
        } finally { supervisor.close(); }
    }
}
