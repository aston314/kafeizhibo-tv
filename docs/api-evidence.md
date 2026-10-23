# 咖啡直播接口证据

最后核验：2026-10-22，站点 `https://kafeizhibo.cc`，未使用会员会话。

| 功能 | 请求 | 关键字段 |
| --- | --- | --- |
| 直播分类 | `GET /api/v1/archor?type=all\|hot\|1\|2\|3\|19` | `room_id`, `match_id`, `category`, `status`, `screenshot`, `heat`, `home_team`, `away_team` |
| 热门赛事 | `GET /api/v1/hot-matches` | `match_id`, `type`, `start_time`, `has_live`, `archors` |
| 赛程 | `GET /api/v1/schedule?type=&page=1&size=30&platform=pc` | `status`, `start_time`, `archors`, `homeTeam`, `awayTeam` |
| 直播间 | `GET /api/v1/room/{room_id}` | `signals`，每条线路可能有独立 HLS URL |
| 录像列表 | `GET /api/v1/recordings?page=1&size=30&type=` | `recording_count`, `cover_image`, `status` |
| 比赛录像 | `GET /api/v1/match/{match_id}/recordings` | 录像详情，按比赛查询 |
| 实时事件 | `/api/v1/ws/live`, `/api/v1/ws/room/{room_id}` | WebSocket，首版只保留 HTTP 轮询/刷新 |

Go 核心对列表元数据做 20 秒轻量缓存；`room` 和 `match` 详情不缓存，确保线路进入页面时重新请求。上游响应失败会映射为本地 `502`，前端显示可重试错误态。会员登录、注册、个人中心、消息、聊天/弹幕和账号同步不在产品范围内。
