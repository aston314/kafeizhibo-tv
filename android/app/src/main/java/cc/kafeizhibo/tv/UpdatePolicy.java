package cc.kafeizhibo.tv;

import java.net.URI;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Set;

final class UpdatePolicy {
    static final String MANIFEST_URL = "https://github.com/aston314/kafeizhibo-tv/releases/latest/download/update.json";
    private static final String[] PROXY_IDS = {"a", "b", "c"};
    private static final String[] PROXY_URLS = {"https://ghfast.top/", "https://ghproxy.net/", "https://gh-proxy.com/"};
    static final long MAX_APK_BYTES = 100L * 1024 * 1024;

    static String[] defaultProxyOrder() { return PROXY_IDS.clone(); }

    static String[] normalizeProxyOrder(String[] value) {
        if (value == null || value.length != PROXY_IDS.length)
            throw new IllegalArgumentException("更新线路顺序不完整");
        List<String> result = new ArrayList<>();
        Set<String> seen = new HashSet<>();
        for (String id : value) {
            if (id == null || !Arrays.asList(PROXY_IDS).contains(id) || !seen.add(id))
                throw new IllegalArgumentException("更新线路顺序无效");
            result.add(id);
        }
        return result.toArray(new String[0]);
    }

    static String[] proxiesForOrder(String[] value) {
        String[] order = normalizeProxyOrder(value);
        String[] result = new String[order.length];
        for (int index = 0; index < order.length; index++) {
            for (int candidate = 0; candidate < PROXY_IDS.length; candidate++) {
                if (PROXY_IDS[candidate].equals(order[index])) result[index] = PROXY_URLS[candidate];
            }
        }
        return result;
    }

    static String[] sources(String origin, String[] proxies) {
        List<String> result = new ArrayList<>();
        Set<String> seen = new HashSet<>();
        if (proxies != null) {
            for (String value : proxies) {
                String source = value + origin;
                if (seen.add(source)) result.add(source);
            }
        }
        if (seen.add(origin)) result.add(origin);
        return result.toArray(new String[0]);
    }

    static void validateManifest(String packageName, int code, String name, int minSdk, long bytes,
                                 String sha256, String download, String installedPackage, int installedCode,
                                 String installedName) {
        if (code < installedCode || code == installedCode && !installedName.equals(name))
            throw new IllegalArgumentException("更新信息尚未刷新或版本不一致，请稍后重试");
        if (!installedPackage.equals(packageName) || code <= 0 || name == null
                || !name.matches("[0-9]+\\.[0-9]+\\.[0-9]+(?:[-+][A-Za-z0-9.-]+)?")
                || minSdk < 23 || bytes <= 0 || bytes > MAX_APK_BYTES
                || sha256 == null || !sha256.matches("[a-fA-F0-9]{64}"))
            throw new IllegalArgumentException("版本信息不完整或与当前应用不匹配");
        URI uri = URI.create(download);
        String expectedPath = "/aston314/kafeizhibo-tv/releases/download/v" + name + "/sports-live-tv-" + name + ".apk";
        if (!"https".equals(uri.getScheme()) || !"github.com".equals(uri.getHost())
                || uri.getRawUserInfo() != null || uri.getPort() != -1
                || uri.getRawQuery() != null || uri.getRawFragment() != null
                || !expectedPath.equals(uri.getRawPath()))
            throw new IllegalArgumentException("安装包地址不是球赛直播的正式发行文件");
    }

    static boolean matchingArchive(String installedPackage, int installedCode, String archivePackage,
                                   int archiveCode, String archiveName, int expectedCode, String expectedName,
                                   String[] installedSigners, String[] archiveSigners) {
        if (!installedPackage.equals(archivePackage) || archiveCode <= installedCode
                || archiveCode != expectedCode || !expectedName.equals(archiveName)
                || installedSigners == null || archiveSigners == null
                || installedSigners.length == 0 || installedSigners.length != archiveSigners.length) return false;
        String[] left = installedSigners.clone(), right = archiveSigners.clone();
        Arrays.sort(left);
        Arrays.sort(right);
        return Arrays.equals(left, right);
    }

    static String hex(byte[] bytes) {
        StringBuilder result = new StringBuilder(bytes.length * 2);
        for (byte value : bytes) result.append(String.format(Locale.ROOT, "%02x", value & 255));
        return result.toString();
    }

    private UpdatePolicy() { }
}
