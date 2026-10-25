package ui

import (
	_ "embed"
	"strings"
)

//go:embed index.html
var IndexHTML []byte

//go:embed app.css
var css []byte

//go:embed app.js
var js []byte

//go:embed feed-pager.js
var feedPager []byte

//go:embed feed-request.js
var feedRequest []byte

//go:embed assets/support-wechat.png
var supportWechat []byte

//go:embed assets/support-alipay.png
var supportAlipay []byte

type AssetData struct {
	Data        []byte
	ContentType string
}

func Asset(name string) (AssetData, bool) {
	switch strings.TrimPrefix(name, "/") {
	case "app.css":
		return AssetData{css, "text/css; charset=utf-8"}, true
	case "app.js":
		return AssetData{js, "application/javascript; charset=utf-8"}, true
	case "feed-pager.js":
		return AssetData{feedPager, "application/javascript; charset=utf-8"}, true
	case "feed-request.js":
		return AssetData{feedRequest, "application/javascript; charset=utf-8"}, true
	case "support-wechat.png":
		return AssetData{supportWechat, "image/png"}, true
	case "support-alipay.png":
		return AssetData{supportAlipay, "image/png"}, true
	default:
		return AssetData{}, false
	}
}
