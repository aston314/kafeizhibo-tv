# 体育直播 Android TV

这是面向电视遥控器的体育直播客户端：主页、直播分类、赛程、录像回放、直播间线路选择和打赏页面。直播内容同时接入咖啡直播与豆包直播，两个来源独立请求和播放；应用不包含会员和账号功能。

## 浏览器预览

```sh
./scripts/preview.sh fixture
```

脚本会启动本地 Go 核心并打印 `KAFEI_TV_READY`，访问对应 `http://127.0.0.1:<port>/`。使用 `./scripts/preview.sh real` 访问真实站点接口，页面顶部可以按来源筛选，侧栏的“打赏”页面提供微信和支付宝二维码。

## Android 构建

先安装 Android SDK/NDK、JDK 和 Gradle，再运行 `./scripts/build_android_binaries.sh` 生成三个 ABI 的 Go 核心，随后在 `android/` 执行 `gradle assembleDebug`。公开仓库的 GitHub Actions 会自动执行检查并上传 debug APK；当前开发环境没有 JDK/Gradle，因此 APK 不在本机编译。
