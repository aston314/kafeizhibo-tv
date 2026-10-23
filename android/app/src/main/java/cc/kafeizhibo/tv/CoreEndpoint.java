package cc.kafeizhibo.tv;

final class CoreEndpoint {
    final String url;
    final String instance;
    private CoreEndpoint(int port, String instance) { this.url = "http://127.0.0.1:" + port + "/"; this.instance = instance; }
    static CoreEndpoint parse(String line, String expected) {
        if (line == null || !line.startsWith("KAFEI_TV_READY ")) return null;
        String[] parts = line.substring("KAFEI_TV_READY ".length()).trim().split(" ");
        if (parts.length != 2 || !expected.equals(parts[1])) return null;
        try { int port = Integer.parseInt(parts[0]); return port > 0 && port < 65536 ? new CoreEndpoint(port, expected) : null; } catch (Exception ignored) { return null; }
    }
}
