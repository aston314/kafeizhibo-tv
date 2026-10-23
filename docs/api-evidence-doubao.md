# 豆包直播接口证据

最后核验：2026-10-23，站点 `https://www.doubaozhibo.com`，使用 Chrome DevTools 浏览器会话，未登录账号。页面会自动创建游客 cookie；不带正常浏览器 User-Agent/Referer 的 Python 请求返回 Cloudflare `403`，补齐这些请求头后，curl 可以直接取得列表 JSON。播放链路仍应按短期 URL 和上游风控处理。

## 直播列表

`GET /api/v1/home/rooms?category={all|important|football|basketball}&page=1&pageSize=30&q=&homeFallback=true`

响应结构：

```json
{
  "success": true,
  "code": 0,
  "data": {
    "items": [
      {
        "id": 434,
        "title": "CBA 辽宁 vs 四川",
        "anchor": "高清直播1",
        "sport": "basketball",
        "cover": "/uploads/signals/434.jpg?...",
        "matchId": 90,
        "league": "CBA",
        "status": 1,
        "popularity": 51,
        "scheduleSort": 1,
        "url": "/play/90-1-2"
      }
    ],
    "total": 10,
    "page": 1,
    "pageSize": 30,
    "mode": "live",
    "replays": null
  }
}
```

`status` 在当前样本中 `1` 表示正在直播。列表中的同一比赛会按直播源拆成多条 room，例如 `matchId=90` 的“高清直播1”和“高清直播2”。`matchId` 是稳定的赛事归属键，`id` 是直播房间/信号键。

## 赛程与状态

`GET /api/v1/home/schedules?date=YYYY-MM-DD&days=5&category={all|important|football|basketball}&continuous=true&pageSize=30&q=`

可继续携带返回的 `data.nextCursor`：

`GET /api/v1/home/schedules?...&cursor={nextCursor}`

响应的 `data` 包含 `items`、`total`、`page`、`pageSize`、`hasMore`、`nextCursor`。每一项是：

```text
item.match.id / league / matchTime / sport / home / away
item.match.homeScore / awayScore / status / scoreStale / playUrl
item.rooms[]: id / title / anchor / matchId / status / url / cover
```

已观察到的比赛状态：`0=未开始`、`1=进行中`、`2=已完赛`、`3=延期`、`4=取消`。这组映射同时出现在站点前端打包脚本中。`scoreStale=true` 表示比分可能不是最新值，不能用它判断直播是否结束；结束判断应优先使用 `match.status` 和信号详情中的 `live/playable/state`。

## 直播详情与播放源

`GET /api/v1/public/signals/{playId}`

示例 `playId=90-1-2` 返回：

```text
data.id / playId / title / name / cover
data.playable=true
data.live=true
data.state="正在直播"
data.schedule.id / league / matchTime / home / away / homeScore / awayScore / status
data.signals[]: id / name / playId / url
```

播放源需要再请求：

`GET /api/v1/public/signals/{playId}/play`

示例返回：

```json
{"success":true,"code":0,"data":{"playable":true,"url":"https://www.rtmpcdn.com/live/...m3u8","kind":"hls"}}
```

浏览器实际播放时，`rtmpcdn.com` 的 m3u8 会 `302` 到带短期 `auth_key`、`token` 的 CDN 地址。播放 URL 必须按“每次打开或切换线路重新获取”处理，不能放进长期缓存；列表和详情元数据也不应把这个 URL 当作稳定字段。

已验证未登录浏览器会话可以播放：HTML video 最终 `readyState=4`，视频尺寸 `1280x720`。游客 cookie 会由站点自动创建，登录接口不是播放前置条件。

## 回放

列表：

`GET /api/v1/playbacks?category={all|important|football|basketball}&q=&page=1&pageSize=20`

响应 `data.items`、`total`、`page`、`pageSize`。每条回放包含 `scheduleId`、`title`、`views`、`cover`、`schedule` 和 `lines[]`。

详情：

`GET /api/v1/playbacks/{scheduleId}-{lineNo}`

返回选中线路和完整 `playback`，其中 `schedule.status=2` 表示已完赛。`lines[]` 的每条线路有 `lineNo`、`title`、`routeId`、`proxyUrl`。

回放播放地址是站内代理路径，例如 `/vodplay/87-1.m3u8`。浏览器验证该地址返回 HLS 播放列表，随后正常加载 1920x1080 视频。播放页还会发送一次 `POST /api/v1/playbacks/{scheduleId}/visits`，这属于观看计数，可不纳入首版电视端功能。

## 实时更新与附属接口

- `POST /api/v1/hubs/live/negotiate?negotiateVersion=1`：SignalR 协商。
- SignalR 事件代码中观察到 `RoomAvailabilityChanged`、`RoomChanged`，以及赛程变化相关的更新处理。
- `POST /api/v1/audience/match/{matchId}/view`：进入比赛的观看计数。
- 聊天接口包括 `/api/v1/chat/bootstrap`、`/api/v1/chat/policy` 和 `/api/v1/chat/rooms/{roomId}/history`，会员、聊天、私信不在当前产品范围。

首版适配器使用 HTTP 列表/详情轮询即可，不依赖 SignalR。播放期间可按现有播放器策略定时重新请求 `/public/signals/{playId}`，根据 `live`、`playable`、`state` 和 `schedule.status` 更新“直播中/已结束/暂无线路”。

## 与咖啡直播统一模型的映射

| 统一字段 | 豆包直播 | 处理方式 |
| --- | --- | --- |
| source | 固定 `doubao` | 卡片来源标识和来源筛选 |
| matchId | `match.id` 或 room `matchId` | 赛事去重候选键 |
| roomId | `room.id` 或 `signals.id` | 线路/房间唯一键 |
| title | `title` | 保留 `VS` |
| league | `league` | 赛事分类 |
| home/away | `match.home/away` | 统一队伍展示 |
| status | `match.status` / `data.live` / `data.state` | 统一为 upcoming/live/finished/deferred/cancelled |
| cover | `cover` | 拼接 `https://www.doubaozhibo.com` |
| signals | `data.signals[]` | 每条线路点击时再请求 `/play` |
| playback | `/public/signals/{playId}/play` 的 `data.url` | 不缓存，交给统一播放器 |

## 接入判断

技术上可以接入现有应用，且豆包直播的赛事键、状态码、多线路和 HLS 播放链路比普通网页抓取更清晰。建议先做“统一展示 + 来源筛选”，保留每个来源的卡片标识和详情适配器；首版不要按队名强行合并两站赛事，等对照同一天的比赛、联赛、开赛时间和队名规范后，再决定是否对同一赛事聚合多个来源。

Go 代理应使用浏览器级请求头（至少 `Referer`、`Accept` 和正常 User-Agent），并针对 403、429、5xx 做有限重试与错误态。当前列表接口在补齐请求头后可由无 cookie 的 curl 访问；播放详情和 CDN 重定向仍需在 Android WebView/Go 代理中各做一次实机验证，不能只依据浏览器会话推断长期稳定性。
