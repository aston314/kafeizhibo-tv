package cc.kafeizhibo.tv;

import static org.junit.Assert.assertArrayEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

import org.junit.Test;

public final class UpdatePolicyTest {
    @Test public void triesConfiguredProxyOrderBeforeDirectUrl() {
        String[] proxies = UpdatePolicy.proxiesForOrder(new String[]{"c", "a", "b"});
        assertArrayEquals(new String[]{
                "https://gh-proxy.com/",
                "https://ghfast.top/",
                "https://ghproxy.net/"
        }, proxies);
        assertArrayEquals(new String[]{
                "https://gh-proxy.com/https://github.com/example/app/update.json",
                "https://ghfast.top/https://github.com/example/app/update.json",
                "https://ghproxy.net/https://github.com/example/app/update.json",
                "https://github.com/example/app/update.json"
        }, UpdatePolicy.sources("https://github.com/example/app/update.json", proxies));
    }

    @Test public void rejectsIncompleteOrDuplicateProxyOrder() {
        for (String[] invalid : new String[][]{{"a", "a", "c"}, {"a", "b"}, {"a", "b", "d"}}) {
            try {
                UpdatePolicy.normalizeProxyOrder(invalid);
                fail("expected invalid proxy order");
            } catch (IllegalArgumentException expected) {
                assertTrue(expected.getMessage().contains("更新线路"));
            }
        }
    }

    @Test public void validatesUpdateManifestIdentityAndReleasePath() {
        String sha256 = String.format(java.util.Locale.ROOT, "%064d", 0).replace('0', 'a');
        UpdatePolicy.validateManifest("cc.kafeizhibo.tv", 10, "0.1.9", 23, 1024, sha256,
                "https://github.com/aston314/kafeizhibo-tv/releases/download/v0.1.9/sports-live-tv-0.1.9.apk",
                "cc.kafeizhibo.tv", 9, "0.1.8");
        assertInvalidManifest("https://example.com/evil.apk", sha256);
        assertInvalidManifest("http://github.com/aston314/kafeizhibo-tv/releases/download/v0.1.9/sports-live-tv-0.1.9.apk", sha256);
    }

    @Test public void requiresExactPackageVersionAndSignerSet() {
        assertTrue(UpdatePolicy.matchingArchive("cc.kafeizhibo.tv", 9, "cc.kafeizhibo.tv", 10,
                "0.1.9", 10, "0.1.9", new String[]{"a", "b"}, new String[]{"b", "a"}));
        assertFalse(UpdatePolicy.matchingArchive("cc.kafeizhibo.tv", 9, "cc.other.tv", 10,
                "0.1.9", 10, "0.1.9", new String[]{"a"}, new String[]{"a"}));
        assertFalse(UpdatePolicy.matchingArchive("cc.kafeizhibo.tv", 9, "cc.kafeizhibo.tv", 10,
                "0.1.9", 10, "0.1.9", new String[]{"a"}, new String[]{"b"}));
    }

    private void assertInvalidManifest(String download, String sha256) {
        try {
            UpdatePolicy.validateManifest("cc.kafeizhibo.tv", 10, "0.1.9", 23, 1024, sha256,
                    download, "cc.kafeizhibo.tv", 9, "0.1.8");
            fail("expected invalid download URL");
        } catch (IllegalArgumentException expected) {
            assertTrue(expected.getMessage().contains("地址"));
        }
    }
}
