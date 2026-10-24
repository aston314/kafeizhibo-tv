package cc.kafeizhibo.tv;

import android.app.Activity;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.content.pm.Signature;
import android.net.Uri;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.provider.Settings;
import android.webkit.JavascriptInterface;
import androidx.core.content.FileProvider;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.InputStream;
import java.io.IOException;
import java.net.HttpURLConnection;
import java.net.URL;
import java.security.MessageDigest;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicInteger;
import org.json.JSONObject;

final class AppUpdater {
    private final Activity activity;
    private final Handler main = new Handler(Looper.getMainLooper());
    private final ExecutorService worker = Executors.newSingleThreadExecutor();
    private final AtomicInteger generation = new AtomicInteger();
    private final SharedPreferences preferences;
    private final File directory;
    private final File partial;
    private final File apk;
    private volatile HttpURLConnection connection;
    private volatile String snapshot = "{}";
    private volatile String state = "idle";
    private volatile String message = "可手动检查更新";
    private volatile long downloaded;
    private volatile Manifest latest;
    private volatile boolean destroyed;
    private volatile boolean checking;
    private volatile boolean downloading;
    private boolean waitingPermission;
    private String[] proxyOrder;
    private String[] proxies;

    AppUpdater(Activity activity) {
        this.activity = activity;
        preferences = activity.getSharedPreferences("SportsLiveTvUpdates", Activity.MODE_PRIVATE);
        proxyOrder = parseProxyOrder(preferences.getString("proxy_order", "a,b,c"));
        proxies = UpdatePolicy.proxiesForOrder(proxyOrder);
        directory = new File(activity.getCacheDir(), "app-updates");
        partial = new File(directory, "update.part");
        apk = new File(directory, "update.apk");
        publish();
    }

    final class Bridge {
        @JavascriptInterface public String getStatus() { return snapshot; }
        @JavascriptInterface public void check() { main.post(() -> checkNow()); }
        @JavascriptInterface public void download() { main.post(() -> beginDownload()); }
        @JavascriptInterface public void cancel() { main.post(() -> cancelDownload()); }
        @JavascriptInterface public void install() { main.post(() -> installReady()); }
    }

    private static final class Manifest {
        final int code;
        final int minSdk;
        final long bytes;
        final String name;
        final String sha256;
        final String url;
        final String notes;

        Manifest(JSONObject json, String installedPackage) throws Exception {
            if (json.getInt("schema") != 1) throw new IOException("不支持的更新清单格式");
            code = json.getInt("version_code");
            minSdk = json.getInt("min_sdk");
            bytes = json.getLong("size");
            name = json.getString("version_name");
            sha256 = json.getString("sha256").toLowerCase(java.util.Locale.ROOT);
            url = json.getString("download_url");
            notes = json.optString("release_notes", "");
            UpdatePolicy.validateManifest(json.getString("package_name"), code, name, minSdk, bytes,
                    sha256, url, installedPackage, BuildConfig.VERSION_CODE, BuildConfig.VERSION_NAME);
            if (notes.length() > 16000) throw new IOException("版本说明过长");
        }
    }

    void check() { main.post(() -> checkNow()); }

    private void checkNow() {
        if (destroyed || checking || downloading) return;
        if (BuildConfig.DEBUG) {
            state = "unsupported";
            message = "调试版本不能覆盖安装正式版更新";
            publish();
            return;
        }
        checking = true;
        state = "checking";
        message = "正在检查更新服务…";
        publish();
        int epoch = generation.incrementAndGet();
        String[] selected = proxies.clone();
        worker.execute(() -> checkSources(epoch, selected));
    }

    private void checkSources(int epoch, String[] selected) {
        String origin = UpdatePolicy.MANIFEST_URL + "?check=" + System.currentTimeMillis();
        String error = "暂时无法连接更新服务";
        Manifest found = null;
        String[] sources = UpdatePolicy.sources(origin, selected);
        for (int index = 0; index < sources.length; index++) {
            if (!valid(epoch)) return;
            final int attempt = index;
            post(() -> {
                if (valid(epoch)) {
                    message = attempt == 0 ? "正在连接更新服务…" : "正在切换备用更新服务…";
                    publish();
                }
            });
            try {
                found = new Manifest(new JSONObject(readManifest(sources[index], epoch)), activity.getPackageName());
                break;
            } catch (Exception failure) {
                if (!valid(epoch)) return;
                error = friendly(failure);
            }
        }
        final Manifest result = found;
        final String failure = error;
        post(() -> {
            if (!valid(epoch)) return;
            checking = false;
            if (result == null) {
                state = "error";
                message = "检查失败，请稍后重试：" + failure;
            } else {
                latest = result;
                if (result.minSdk > Build.VERSION.SDK_INT) {
                    state = "incompatible";
                    message = "新版本需要 Android " + result.minSdk + " 或更高版本";
                } else if (result.code > BuildConfig.VERSION_CODE) {
                    state = "available";
                    message = "发现新版本 " + result.name;
                } else {
                    state = "current";
                    message = "当前已是最新版本（" + result.name + "）";
                }
            }
            publish();
        });
    }

    private String readManifest(String source, int epoch) throws Exception {
        HttpURLConnection request = open(source, epoch);
        try (InputStream input = request.getInputStream(); ByteArrayOutputStream output = new ByteArrayOutputStream()) {
            byte[] buffer = new byte[4096];
            int count;
            while ((count = input.read(buffer)) != -1) {
                ensureValid(epoch);
                if (output.size() + count > 65536) throw new IOException("更新清单超过大小限制");
                output.write(buffer, 0, count);
            }
            return output.toString("UTF-8");
        } finally {
            request.disconnect();
            if (connection == request) connection = null;
        }
    }

    private HttpURLConnection open(String source, int epoch) throws Exception {
        URL url = new URL(source);
        for (int redirect = 0; redirect < 6; redirect++) {
            ensureValid(epoch);
            if (!"https".equalsIgnoreCase(url.getProtocol()) || url.getUserInfo() != null)
                throw new IOException("更新连接必须使用 HTTPS");
            HttpURLConnection request = (HttpURLConnection) url.openConnection();
            connection = request;
            request.setConnectTimeout(6000);
            request.setReadTimeout(10000);
            request.setInstanceFollowRedirects(false);
            request.setUseCaches(false);
            request.setRequestProperty("Cache-Control", "no-cache");
            request.setRequestProperty("Accept-Encoding", "identity");
            request.setRequestProperty("User-Agent", "SportsLiveTV/" + BuildConfig.VERSION_NAME);
            int code;
            try {
                code = request.getResponseCode();
            } catch (Exception failure) {
                request.disconnect();
                if (connection == request) connection = null;
                throw failure;
            }
            ensureValid(epoch);
            if (code >= 300 && code <= 399) {
                String location = request.getHeaderField("Location");
                request.disconnect();
                if (connection == request) connection = null;
                if (location == null) throw new IOException("更新重定向缺少目标地址");
                url = new URL(url, location);
                continue;
            }
            if (code != HttpURLConnection.HTTP_OK) {
                request.disconnect();
                if (connection == request) connection = null;
                throw new IOException("更新服务返回 HTTP " + code);
            }
            return request;
        }
        throw new IOException("更新连接重定向次数过多");
    }

    private void beginDownload() {
        Manifest target = latest;
        if (destroyed || downloading || target == null || target.code <= BuildConfig.VERSION_CODE) return;
        downloading = true;
        downloaded = 0;
        state = "downloading";
        message = "正在连接下载服务…";
        publish();
        int epoch = generation.incrementAndGet();
        String[] selected = proxies.clone();
        worker.execute(() -> downloadSources(target, selected, epoch));
    }

    private void downloadSources(Manifest target, String[] selected, int epoch) {
        String error = "下载服务暂时不可用";
        try {
            directory.mkdirs();
            apk.delete();
            String[] sources = UpdatePolicy.sources(target.url, selected);
            for (int index = 0; index < sources.length; index++) {
                ensureValid(epoch);
                partial.delete();
                final int attempt = index;
                post(() -> {
                    if (!valid(epoch)) return;
                    downloaded = 0;
                    message = attempt == 0 ? "正在连接下载服务…" : "正在切换备用下载服务…";
                    publish();
                });
                try {
                    HttpURLConnection request = open(sources[index], epoch);
                    try (InputStream input = request.getInputStream()) {
                        long length = request.getContentLength();
                        if (length >= 0 && length != target.bytes) throw new IOException("安装包大小不匹配");
                        UpdateFiles.copyChecked(input, partial, target.bytes, target.sha256, new UpdateFiles.Monitor() {
                            private long lastProgress;
                            @Override public void check() throws IOException { ensureValid(epoch); }
                            @Override public void progress(long bytes) {
                                long now = SystemClock.elapsedRealtime();
                                if (now - lastProgress >= 350 || bytes == target.bytes) {
                                    lastProgress = now;
                                    post(() -> {
                                        if (!valid(epoch) || !downloading) return;
                                        downloaded = bytes;
                                        message = String.format(java.util.Locale.ROOT, "已下载 %.1f / %.1f MB · %d%%", bytes / 1048576.0, target.bytes / 1048576.0, bytes * 100 / target.bytes);
                                        publish();
                                    });
                                }
                            }
                        });
                    } finally {
                        request.disconnect();
                        if (connection == request) connection = null;
                    }
                    ensureValid(epoch);
                    verifyArchive(target, partial);
                    if (!partial.renameTo(apk)) throw new IOException("无法保存已验证的安装包");
                    post(() -> {
                        if (!valid(epoch)) return;
                        downloading = false;
                        downloaded = target.bytes;
                        latest = target;
                        state = "ready";
                        message = "安装包已验证，正在打开系统安装界面…";
                        publish();
                        installReady();
                    });
                    return;
                } catch (Exception failure) {
                    partial.delete();
                    if (!valid(epoch)) return;
                    error = friendly(failure);
                }
            }
            throw new IOException(error);
        } catch (Exception failure) {
            partial.delete();
            apk.delete();
            final String text = friendly(failure);
            post(() -> {
                if (!valid(epoch)) return;
                downloading = false;
                state = "error";
                message = "下载失败，请稍后重试：" + text;
                publish();
            });
        }
    }

    private void installReady() {
        Manifest target = latest;
        if (destroyed || target == null || !apk.isFile()) return;
        try {
            if (apk.length() != target.bytes || !hash(apk).equals(target.sha256))
                throw new IOException("安装包完整性复核失败");
            verifyArchive(target, apk);
            if (Build.VERSION.SDK_INT >= 26 && !activity.getPackageManager().canRequestPackageInstalls()) {
                waitingPermission = true;
                state = "ready";
                message = "请允许球赛直播安装未知应用，然后返回继续";
                publish();
                activity.startActivity(new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                        Uri.parse("package:" + activity.getPackageName())));
                return;
            }
            Uri uri = FileProvider.getUriForFile(activity, activity.getPackageName() + ".updates", apk);
            Intent install = new Intent(Intent.ACTION_VIEW);
            install.setDataAndType(uri, "application/vnd.android.package-archive");
            install.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
            activity.startActivity(install);
            state = "installing";
            message = "已交给 Android 安装器，请按屏幕提示完成更新";
            publish();
        } catch (Exception failure) {
            state = "error";
            message = "无法安装更新：" + friendly(failure);
            publish();
        }
    }

    void resume() {
        if (!waitingPermission || destroyed) return;
        waitingPermission = false;
        if (Build.VERSION.SDK_INT >= 26 && activity.getPackageManager().canRequestPackageInstalls()) installReady();
        else {
            state = "ready";
            message = "安装权限未开启，可再次点击安装更新";
            publish();
        }
    }

    private String[] parseProxyOrder(String value) {
        try {
            return UpdatePolicy.normalizeProxyOrder(value.split(","));
        } catch (Exception invalid) {
            return UpdatePolicy.defaultProxyOrder();
        }
    }

    private void cancelDownload() {
        if (!downloading) return;
        generation.incrementAndGet();
        HttpURLConnection active = connection;
        if (active != null) active.disconnect();
        downloading = false;
        partial.delete();
        state = latest == null ? "idle" : "available";
        message = "已取消下载";
        publish();
    }

    private void verifyArchive(Manifest target, File file) throws Exception {
        PackageManager manager = activity.getPackageManager();
        int flags = Build.VERSION.SDK_INT >= 28 ? PackageManager.GET_SIGNING_CERTIFICATES : PackageManager.GET_SIGNATURES;
        PackageInfo archive = manager.getPackageArchiveInfo(file.getPath(), flags);
        PackageInfo installed = manager.getPackageInfo(activity.getPackageName(), flags);
        if (archive == null || !UpdatePolicy.matchingArchive(installed.packageName, installed.versionCode,
                archive.packageName, archive.versionCode, archive.versionName, target.code, target.name,
                signerHashes(installed), signerHashes(archive)))
            throw new IOException("APK 的应用、版本或签名不匹配，已停止安装");
        if (Build.VERSION.SDK_INT >= 24 && archive.applicationInfo != null
                && archive.applicationInfo.minSdkVersion > Build.VERSION.SDK_INT)
            throw new IOException("设备 Android 版本不满足安装要求");
    }

    private String[] signerHashes(PackageInfo info) throws Exception {
        Signature[] signatures;
        if (Build.VERSION.SDK_INT >= 28 && info.signingInfo != null) signatures = info.signingInfo.getApkContentsSigners();
        else signatures = info.signatures;
        if (signatures == null) return new String[0];
        String[] result = new String[signatures.length];
        for (int index = 0; index < signatures.length; index++)
            result[index] = UpdatePolicy.hex(MessageDigest.getInstance("SHA-256").digest(signatures[index].toByteArray()));
        return result;
    }

    private String hash(File file) throws Exception {
        MessageDigest digest = MessageDigest.getInstance("SHA-256");
        try (InputStream input = new FileInputStream(file)) {
            byte[] buffer = new byte[32768];
            int count;
            while ((count = input.read(buffer)) != -1) digest.update(buffer, 0, count);
        }
        return UpdatePolicy.hex(digest.digest());
    }

    private void publish() {
        try {
            JSONObject value = new JSONObject();
            value.put("supported", !BuildConfig.DEBUG);
            value.put("current_version", BuildConfig.VERSION_NAME);
            value.put("state", state);
            value.put("message", message);
            value.put("downloaded", downloaded);
            value.put("latest_version", latest == null ? "" : latest.name);
            value.put("latest_code", latest == null ? 0 : latest.code);
            value.put("size", latest == null ? 0 : latest.bytes);
            value.put("release_notes", latest == null ? "" : latest.notes);
            snapshot = value.toString();
        } catch (Exception ignored) { }
    }

    private void post(Runnable action) { main.post(action); }
    private boolean valid(int epoch) { return !destroyed && generation.get() == epoch; }
    private void ensureValid(int epoch) throws IOException {
        if (!valid(epoch)) throw new IOException("更新操作已取消");
    }
    private String friendly(Exception error) {
        if (error instanceof java.net.SocketTimeoutException) return "连接超时";
        if (error instanceof java.net.UnknownHostException) return "无法解析更新服务地址";
        return error.getMessage() == null ? "网络或文件校验失败" : error.getMessage();
    }

    void destroy() {
        destroyed = true;
        generation.incrementAndGet();
        HttpURLConnection active = connection;
        if (active != null) active.disconnect();
        partial.delete();
        worker.shutdownNow();
    }
}
