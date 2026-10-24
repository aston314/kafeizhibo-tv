package kafzitv

import "os"

type Config struct {
	ProductID      string `json:"productId"`
	DisplayName    string `json:"displayName"`
	ApplicationID  string `json:"applicationId"`
	VersionName    string `json:"versionName"`
	VersionCode    int    `json:"versionCode"`
	Upstream       string `json:"upstream"`
	DoubaoUpstream string `json:"doubaoUpstream"`
	UpdateManifest string `json:"updateManifest"`
}

func Load() Config {
	return Config{ProductID: "sports-live-tv", DisplayName: "球赛直播", ApplicationID: "cc.kafeizhibo.tv", VersionName: "0.1.8", VersionCode: 9, Upstream: envOr("KAFEI_UPSTREAM", "https://kafeizhibo.cc"), DoubaoUpstream: envOr("DOUBAO_UPSTREAM", "https://www.doubaozhibo.com"), UpdateManifest: envOr("UPDATE_MANIFEST_URL", "https://github.com/aston314/kafeizhibo-tv/releases/latest/download/update.json")}
}

func envOr(key, fallback string) string {
	if value := os.Getenv(key); value != "" {
		return value
	}
	return fallback
}
