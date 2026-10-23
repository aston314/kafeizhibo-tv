package server

import "fmt"

func fixtureLive(category string) []map[string]interface{} {
	items := []map[string]interface{}{
		{"archor_id": 22, "name": "直播22", "status": "live", "room_id": "1022", "category": 1, "title": "哈萨甲 埃基巴斯图兹 vs 拖雷斯", "league_name": "哈萨甲", "home_team": "埃基巴斯图兹", "away_team": "拖雷斯", "home_score": 2, "away_score": 2, "heat": 287, "signal_count": 2, "screenshot": "/static/screenshots/22-v76.jpg"},
		{"archor_id": 11, "name": "直播11", "status": "upcoming", "room_id": "1011", "category": 2, "title": "CBA 福建 vs 宁波", "league_name": "CBA", "home_team": "福建", "away_team": "宁波", "home_score": 0, "away_score": 0, "heat": 122, "signal_count": 1, "screenshot": "/static/img/default_cover.jpg"},
		{"archor_id": 206, "name": "原声2", "status": "live", "room_id": "1202", "category": 2, "title": "英超 曼城 vs 利物浦", "league_name": "英超", "home_team": "曼城", "away_team": "利物浦", "home_score": 1, "away_score": 0, "heat": 198, "signal_count": 1, "screenshot": "/static/img/default_cover.jpg"},
	}
	if category == "all" || category == "" || category == "hot" {
		return items
	}
	filtered := make([]map[string]interface{}, 0)
	for _, item := range items {
		if fmt.Sprint(item["category"]) == category {
			filtered = append(filtered, item)
		}
	}
	return filtered
}

func fixtureMatches() []map[string]interface{} {
	return []map[string]interface{}{{"match_id": 42014, "type": "1", "league_name": "哈萨甲", "home_team": "埃基巴斯图兹", "away_team": "拖雷斯", "home_score": 2, "away_score": 2, "status": "live", "start_time": "2026-10-22 17:00", "has_live": true}, {"match_id": 41529, "type": "2", "league_name": "CBA", "home_team": "福建", "away_team": "宁波", "home_score": 0, "away_score": 0, "status": "upcoming", "start_time": "2026-10-22 19:35", "has_live": true}}
}

func fixtureSchedule(category string, page, size int) []map[string]interface{} {
	_ = page
	_ = size
	items := fixtureMatches()
	if category == "1" {
		return items[:1]
	}
	if category == "2" {
		return items[1:]
	}
	return items
}
func fixtureRecordings(category string, page, size int) []map[string]interface{} {
	_ = page
	_ = size
	items := []map[string]interface{}{{"match_id": 41572, "type": "2", "league_name": "澳女篮", "home_team": "南区飞人女篮", "away_team": "塔斯马尼亚珍宝女篮", "home_score": 91, "away_score": 75, "status": "finished", "start_time": "2026-10-22 16:00", "recording_count": 1}, {"match_id": 41487, "type": "1", "league_name": "印班超", "home_team": "泰尼高FF", "away_team": "皇家班加罗尔", "home_score": 1, "away_score": 6, "status": "finished", "start_time": "2026-10-22 16:00", "recording_count": 1}}
	if category == "1" {
		return items[:1]
	}
	if category == "2" {
		return items[1:]
	}
	return items
}
