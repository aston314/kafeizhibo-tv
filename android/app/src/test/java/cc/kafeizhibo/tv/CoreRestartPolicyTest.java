package cc.kafeizhibo.tv;

import static org.junit.Assert.*;
import org.junit.Test;

public class CoreRestartPolicyTest {
    @Test public void repeatedCrashesBackOffAndStopWithinOneMinute() {
        CoreRestartPolicy policy = new CoreRestartPolicy();
        assertEquals(300, policy.nextDelay(1000));
        assertEquals(600, policy.nextDelay(1500));
        assertEquals(1200, policy.nextDelay(2500));
        assertEquals(-1, policy.nextDelay(5000));
        assertEquals(-1, policy.nextDelay(60999));
        assertEquals(300, policy.nextDelay(61000));
    }

    @Test public void manualRetryCanResetExhaustedBudget() {
        CoreRestartPolicy policy = new CoreRestartPolicy();
        policy.nextDelay(0); policy.nextDelay(1); policy.nextDelay(2);
        assertEquals(-1, policy.nextDelay(3));
        policy.reset();
        assertEquals(300, policy.nextDelay(4));
    }
}
