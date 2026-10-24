package cc.kafeizhibo.tv;

/** Bounded automatic recovery, without a tight restart loop after a crash. */
final class CoreRestartPolicy {
    private long windowStart = -1;
    private int attempts;

    long nextDelay(long now) {
        if (windowStart < 0 || now - windowStart >= 60000) {
            windowStart = now;
            attempts = 0;
        }
        if (attempts >= 3) return -1;
        return 300L << attempts++;
    }

    void reset() { windowStart = -1; attempts = 0; }
}
