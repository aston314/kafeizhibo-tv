package cc.kafeizhibo.tv;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.security.MessageDigest;

final class UpdateFiles {
    interface Monitor {
        void check() throws IOException;
        void progress(long bytes);
    }

    static void copyChecked(InputStream input, File partial, long size, String sha256, Monitor monitor) throws Exception {
        boolean complete = false;
        try (FileOutputStream output = new FileOutputStream(partial)) {
            MessageDigest digest = MessageDigest.getInstance("SHA-256");
            byte[] buffer = new byte[32768];
            int count;
            long total = 0;
            while ((count = input.read(buffer)) != -1) {
                monitor.check();
                total += count;
                if (total > size || total > UpdatePolicy.MAX_APK_BYTES) throw new IOException("安装包超过预期大小");
                output.write(buffer, 0, count);
                digest.update(buffer, 0, count);
                monitor.progress(total);
            }
            monitor.check();
            output.getFD().sync();
            if (total != size || !UpdatePolicy.hex(digest.digest()).equals(sha256))
                throw new IOException("安装包大小或 SHA-256 校验失败");
            complete = true;
        } finally {
            if (!complete) partial.delete();
        }
    }

    private UpdateFiles() { }
}
