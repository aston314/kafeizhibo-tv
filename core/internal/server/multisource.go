package server

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"path"
	"strconv"
	"strings"
	"sync"
	"time"
)

type feedItem struct {
	ID             string      `json:"id,omitempty"`
	Source         string      `json:"source"`
	SourceLabel    string      `json:"source_label"`
	Kind           string      `json:"kind"`
	RoomID         string      `json:"room_id,omitempty"`
	MatchID        string      `json:"match_id,omitempty"`
	ReplayID       string      `json:"replay_id,omitempty"`
	PlayID         string      `json:"play_id,omitempty"`
	Title          string      `json:"title"`
	LeagueName     string      `json:"league_name,omitempty"`
	HomeTeam       string      `json:"home_team,omitempty"`
	AwayTeam       string      `json:"away_team,omitempty"`
	HomeScore      interface{} `json:"home_score,omitempty"`
	AwayScore      interface{} `json:"away_score,omitempty"`
	Status         string      `json:"status"`
	StartTime      string      `json:"start_time,omitempty"`
	Cover          string      `json:"cover,omitempty"`
	Heat           interface{} `json:"heat,omitempty"`
	SignalCount    int         `json:"signal_count,omitempty"`
	RecordingCount int         `json:"recording_count,omitempty"`
}

type sourceState struct {
	Status  string `json:"status"`
	Message string `json:"message,omitempty"`
	Count   int    `json:"count"`
	Stale   bool   `json:"stale,omitempty"`
}

type feedResult struct {
	Source     string
	Items      []feedItem
	Total      *int
	HasMore    bool
	NextCursor string
	State      sourceState
}

type feedResponse struct {
	Success bool                   `json:"success"`
	Code    int                    `json:"code"`
	Message string                 `json:"message,omitempty"`
	Data    feedResponseData       `json:"data"`
	Sources map[string]sourceState `json:"sources"`
}

type feedResponseData struct {
	Items      []feedItem `json:"items"`
	Total      *int       `json:"total,omitempty"`
	Page       int        `json:"page"`
	PageSize   int        `json:"pageSize"`
	HasMore    bool       `json:"hasMore"`
	NextCursor string     `json:"nextCursor,omitempty"`
}

func (s *Server) apiV2(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	switch {
	case r.URL.Path == "/api/v2/feed":
		s.aggregateFeed(w, r)
	case strings.HasPrefix(r.URL.Path, "/api/v2/room/"):
		s.unifiedRoom(w, r)
	case strings.HasPrefix(r.URL.Path, "/api/v2/play/"):
		s.resolvePlayback(w, r)
	default:
		http.NotFound(w, r)
	}
}

func (s *Server) aggregateFeed(w http.ResponseWriter, r *http.Request) {
	view := r.URL.Query().Get("view")
	if view != "live" && view != "schedule" && view != "replay" {
		view = "home"
	}
	filter := r.URL.Query().Get("source")
	if filter != "kafei" && filter != "doubao" {
		filter = "all"
	}
	category := r.URL.Query().Get("category")
	if category == "" {
		category = "all"
	}
	page := intQuery(r.URL.Query(), "page", 1)
	size := intQuery(r.URL.Query(), "size", 12)
	if size > 30 {
		size = 30
	}

	sources := []string{"kafei", "doubao"}
	if filter != "all" {
		sources = []string{filter}
	}
	results := make(chan feedResult, len(sources))
	var wait sync.WaitGroup
	for _, source := range sources {
		wait.Add(1)
		go func(name string) {
			defer wait.Done()
			results <- s.fetchFeed(r, name, view, category, page, size)
		}(source)
	}
	wait.Wait()
	close(results)

	response := feedResponse{Success: true, Code: 0, Data: feedResponseData{Items: []feedItem{}, Page: page, PageSize: size}, Sources: make(map[string]sourceState)}
	failed := 0
	bySource := make(map[string]feedResult, len(sources))
	for result := range results {
		name := result.StateName()
		bySource[name] = result
		response.Sources[name] = result.State
		if result.State.Status == "error" {
			failed++
			continue
		}
		if result.Total != nil {
			if response.Data.Total == nil {
				zero := 0
				response.Data.Total = &zero
			}
			*response.Data.Total += *result.Total
		}
		response.Data.HasMore = response.Data.HasMore || result.HasMore
		if response.Data.NextCursor == "" {
			response.Data.NextCursor = result.NextCursor
		}
	}
	// Interleave sources so a healthy source is visible even when another one
	// returns a large page. The page size remains the size of the unified feed.
	for index := 0; len(response.Data.Items) < size; index++ {
		added := false
		for _, source := range sources {
			result, ok := bySource[source]
			if !ok || index >= len(result.Items) {
				continue
			}
			response.Data.Items = append(response.Data.Items, result.Items[index])
			added = true
			if len(response.Data.Items) >= size {
				break
			}
		}
		if !added {
			break
		}
	}
	if len(response.Data.Items) == 0 && failed == len(sources) {
		response.Success = false
		response.Code = http.StatusBadGateway
		response.Message = "所有直播来源暂时不可用"
		writeJSON(w, http.StatusBadGateway, response)
		return
	}
	writeJSON(w, http.StatusOK, response)
}

// StateName preserves the source name without duplicating it in the public state.
func (r feedResult) StateName() string {
	return r.Source
}

func (s *Server) fetchFeed(r *http.Request, source, view, category string, page, size int) feedResult {
	result := feedResult{Source: source, State: sourceState{Status: "error", Message: source + ": 上游暂时不可用"}}
	var requestPath string
	query := url.Values{}
	cacheable := true
	switch source {
	case "kafei":
		switch view {
		case "home", "live":
			requestPath = "/api/v1/archor"
			query.Set("type", kafeiCategory(category))
		case "schedule":
			requestPath = "/api/v1/schedule"
			query.Set("type", kafeiCategory(category))
			query.Set("page", strconv.Itoa(page))
			query.Set("size", strconv.Itoa(size))
			query.Set("platform", "pc")
		case "replay":
			requestPath = "/api/v1/recordings"
			query.Set("type", kafeiCategory(category))
			query.Set("page", strconv.Itoa(page))
			query.Set("size", strconv.Itoa(size))
		}
	case "doubao":
		switch view {
		case "home", "live":
			requestPath = "/api/v1/home/rooms"
			query.Set("category", doubaoCategory(category))
			query.Set("page", strconv.Itoa(page))
			query.Set("pageSize", strconv.Itoa(size))
			query.Set("q", "")
			query.Set("homeFallback", "true")
		case "schedule":
			requestPath = "/api/v1/home/schedules"
			query.Set("date", time.Now().Format("2006-01-02"))
			query.Set("days", "5")
			query.Set("category", doubaoCategory(category))
			query.Set("continuous", "true")
			query.Set("pageSize", strconv.Itoa(size))
			query.Set("q", "")
			if cursor := r.URL.Query().Get("cursor"); cursor != "" {
				query.Set("cursor", cursor)
			}
		case "replay":
			requestPath = "/api/v1/playbacks"
			query.Set("category", doubaoCategory(category))
			query.Set("q", "")
			query.Set("page", strconv.Itoa(page))
			query.Set("pageSize", strconv.Itoa(size))
		}
	default:
		result.State = sourceState{Status: "error", Message: source + ": 未知来源"}
		return result
	}
	if requestPath == "" {
		result.State = sourceState{Status: "error", Message: source + ": 未知页面"}
		return result
	}
	if s.fixture {
		result.Items = fixtureFeedItems(source, view, category)
		result.Total = intPtr(len(result.Items))
		result.HasMore = false
		result.State = sourceState{Status: "ok", Count: len(result.Items), Message: source + ": fixture"}
		return result
	}
	body, stale, err := s.fetchSource(r.Context(), source, requestPath, query, cacheable)
	if err != nil {
		result.State = sourceState{Status: "error", Message: source + ": " + err.Error()}
		return result
	}
	var envelope map[string]interface{}
	if err := json.Unmarshal(body, &envelope); err != nil {
		result.State = sourceState{Status: "error", Message: source + ": 响应格式无效"}
		return result
	}
	if source == "doubao" && envelope["success"] == false {
		result.State = sourceState{Status: "error", Message: source + ": 接口返回失败"}
		return result
	}
	result.Items, result.Total, result.HasMore, result.NextCursor = normalizeFeed(source, view, envelope)
	if source == "kafei" && (view == "home" || view == "live") {
		total := len(result.Items)
		result.Total = intPtr(total)
		start := (page - 1) * size
		if start >= total {
			result.Items = []feedItem{}
		} else {
			end := start + size
			if end > total {
				end = total
			}
			result.Items = result.Items[start:end]
		}
		result.HasMore = start+len(result.Items) < total
	}
	if source == "doubao" && (view == "home" || view == "live") && result.Total != nil {
		result.HasMore = *result.Total > page*size
	}
	result.State = sourceState{Status: "ok", Count: len(result.Items), Stale: stale}
	if stale {
		result.State.Status = "stale"
		result.State.Message = source + ": 使用最近可用数据"
	}
	return result
}

func (s *Server) fetchSource(ctx context.Context, source, requestPath string, query url.Values, cacheable bool) ([]byte, bool, error) {
	base, client, err := s.sourceClient(source)
	if err != nil {
		return nil, false, err
	}
	fullPath, err := upstreamURL(base, requestPath, query)
	if err != nil {
		return nil, false, err
	}
	key := source + "|" + fullPath
	if cacheable {
		if body, ok := s.cached(key); ok {
			return body, false, nil
		}
	}
	var lastErr error
	for attempt := 0; attempt < 2; attempt++ {
		req, requestErr := http.NewRequestWithContext(ctx, http.MethodGet, fullPath, nil)
		if requestErr != nil {
			lastErr = requestErr
			break
		}
		req.Header.Set("Accept", "application/json")
		req.Header.Set("User-Agent", "Mozilla/5.0 (Linux; Android 10; TV) AppleWebKit/537.36 Chrome/120 Safari/537.36")
		if source == "doubao" {
			req.Header.Set("Referer", strings.TrimRight(base, "/")+"/")
		}
		resp, requestErr := client.Do(req)
		if requestErr == nil {
			body, readErr := io.ReadAll(io.LimitReader(resp.Body, 4<<20))
			_ = resp.Body.Close()
			if readErr == nil && resp.StatusCode >= 200 && resp.StatusCode <= 299 {
				if cacheable {
					s.store(key, body, 20*time.Second)
				}
				return body, false, nil
			}
			if readErr != nil {
				lastErr = readErr
			} else {
				lastErr = fmt.Errorf("upstream status %d", resp.StatusCode)
			}
		} else {
			lastErr = requestErr
		}
		if attempt == 0 {
			timer := time.NewTimer(250 * time.Millisecond)
			select {
			case <-ctx.Done():
				timer.Stop()
				return nil, false, ctx.Err()
			case <-timer.C:
			}
		}
	}
	if cacheable {
		if body, ok := s.stale(key); ok {
			return body, true, nil
		}
	}
	return nil, false, lastErr
}

func (s *Server) sourceClient(source string) (string, *http.Client, error) {
	switch source {
	case "kafei":
		return s.cfg.Upstream, s.client, nil
	case "doubao":
		return s.cfg.DoubaoUpstream, s.doubaoClient, nil
	default:
		return "", nil, errors.New("unknown source")
	}
}

func normalizeFeed(source, view string, envelope map[string]interface{}) ([]feedItem, *int, bool, string) {
	data := asMap(envelope["data"])
	if source == "doubao" {
		if view == "home" || view == "live" {
			items := normalizeDoubaoRooms(data)
			total := asInt(data["total"])
			return items, intPtr(total), total > len(items), ""
		}
		if view == "schedule" {
			items := normalizeDoubaoSchedules(data)
			return items, intPtr(asInt(data["total"])), asBool(data["hasMore"]), asString(data["nextCursor"])
		}
		items := normalizeDoubaoReplays(data)
		return items, intPtr(asInt(data["total"])), false, ""
	}
	items := normalizeKafeiItems(view, rowsFromEnvelope(envelope))
	total := asInt(envelope["total"])
	if total == 0 {
		total = asInt(data["total"])
	}
	hasMore := false
	if view == "schedule" || view == "replay" {
		hasMore = len(items) >= 12
	}
	return items, intPtr(total), hasMore, ""
}

func normalizeKafeiItems(view string, rows []interface{}) []feedItem {
	items := make([]feedItem, 0, len(rows))
	for _, raw := range rows {
		m := asMap(raw)
		if m == nil {
			continue
		}
		kind := "live"
		if view == "schedule" {
			kind = "match"
		} else if view == "replay" {
			kind = "replay"
		}
		room := firstString(m, "room_id", "roomId", "archor_id")
		match := firstString(m, "match_id", "matchId", "id")
		home := firstString(m, "home_team", "homeTeam")
		away := firstString(m, "away_team", "awayTeam")
		league := firstString(m, "league_name", "league")
		title := firstString(m, "title")
		if title == "" {
			title = strings.TrimSpace(home + " VS " + away)
		}
		id := room
		if id == "" {
			id = match
		}
		items = append(items, feedItem{
			ID: id, Source: "kafei", SourceLabel: "咖啡直播", Kind: kind,
			RoomID: room, MatchID: match, Title: title, LeagueName: league,
			HomeTeam: home, AwayTeam: away, HomeScore: value(m, "home_score", "homeScore"), AwayScore: value(m, "away_score", "awayScore"),
			Status: normalizeKafeiStatus(firstString(m, "status")), StartTime: firstString(m, "start_time", "startTime", "match_time"),
			Cover: absoluteURL("https://kafeizhibo.cc", firstString(m, "screenshot", "cover_image", "cover")), Heat: value(m, "heat", "popularity"),
			SignalCount: asInt(value(m, "signal_count", "signalCount")), RecordingCount: asInt(value(m, "recording_count", "recordingCount")),
		})
	}
	return items
}

func normalizeDoubaoRooms(data map[string]interface{}) []feedItem {
	groups := make(map[string]*feedItem)
	order := []string{}
	for _, raw := range asSlice(data["items"]) {
		m := asMap(raw)
		if m == nil {
			continue
		}
		matchID := firstString(m, "matchId", "match_id", "id")
		item, ok := groups[matchID]
		if !ok {
			title := firstString(m, "title")
			item = &feedItem{ID: matchID, Source: "doubao", SourceLabel: "豆包直播", Kind: "live", MatchID: matchID, Title: title, LeagueName: firstString(m, "league"), HomeTeam: teamFromTitle(title, true), AwayTeam: teamFromTitle(title, false), Status: normalizeDoubaoStatus(m["status"]), Cover: absoluteURL("https://www.doubaozhibo.com", firstString(m, "cover"))}
			groups[matchID] = item
			order = append(order, matchID)
		}
		item.SignalCount++
		if item.RoomID == "" {
			item.RoomID = playIDFromURL(firstString(m, "url"))
			item.PlayID = item.RoomID
		}
		if item.Heat == nil {
			item.Heat = value(m, "popularity")
		}
	}
	items := make([]feedItem, 0, len(order))
	for _, id := range order {
		items = append(items, *groups[id])
	}
	return items
}

func normalizeDoubaoSchedules(data map[string]interface{}) []feedItem {
	items := []feedItem{}
	for _, raw := range asSlice(data["items"]) {
		item := asMap(raw)
		match := asMap(item["match"])
		if match == nil {
			continue
		}
		rooms := asSlice(item["rooms"])
		var first map[string]interface{}
		if len(rooms) > 0 {
			first = asMap(rooms[0])
		}
		matchID := firstString(match, "id")
		roomID := playIDFromURL(firstString(first, "url"))
		home, away := firstString(match, "home", "teamA"), firstString(match, "away", "teamB")
		items = append(items, feedItem{ID: matchID, Source: "doubao", SourceLabel: "豆包直播", Kind: "match", RoomID: roomID, MatchID: matchID, Title: firstString(first, "title") + titleFallback(firstString(match, "league"), home, away), LeagueName: firstString(match, "league"), HomeTeam: home, AwayTeam: away, HomeScore: value(match, "homeScore", "scoreA"), AwayScore: value(match, "awayScore", "scoreB"), Status: normalizeDoubaoStatus(match["status"]), StartTime: firstString(match, "matchTime"), Cover: absoluteURL("https://www.doubaozhibo.com", firstString(first, "cover")), SignalCount: len(rooms)})
		items[len(items)-1].Title = firstString(first, "title")
		if items[len(items)-1].Title == "" {
			items[len(items)-1].Title = strings.TrimSpace(firstString(match, "league") + " " + home + " VS " + away)
		}
	}
	return items
}

func normalizeDoubaoReplays(data map[string]interface{}) []feedItem {
	items := []feedItem{}
	for _, raw := range asSlice(data["items"]) {
		m := asMap(raw)
		schedule := asMap(m["schedule"])
		if m == nil {
			continue
		}
		id := firstString(m, "scheduleId")
		lines := asSlice(m["lines"])
		replayID := ""
		if len(lines) > 0 {
			replayID = firstString(asMap(lines[0]), "routeId")
		}
		if replayID == "" && id != "" {
			replayID = id + "-1"
		}
		home, away := firstString(schedule, "teamA"), firstString(schedule, "teamB")
		items = append(items, feedItem{ID: id, Source: "doubao", SourceLabel: "豆包直播", Kind: "replay", RoomID: replayID, ReplayID: replayID, MatchID: id, Title: firstString(m, "title"), LeagueName: firstString(schedule, "league"), HomeTeam: home, AwayTeam: away, HomeScore: value(schedule, "scoreA"), AwayScore: value(schedule, "scoreB"), Status: "finished", StartTime: firstString(schedule, "matchTime"), Cover: absoluteURL("https://www.doubaozhibo.com", firstString(m, "cover")), RecordingCount: len(lines), Heat: value(m, "views")})
	}
	return items
}

func (s *Server) unifiedRoom(w http.ResponseWriter, r *http.Request) {
	parts := strings.Split(strings.TrimPrefix(r.URL.Path, "/api/v2/room/"), "/")
	if len(parts) != 2 || (parts[0] != "kafei" && parts[0] != "doubao") {
		http.NotFound(w, r)
		return
	}
	source, id := parts[0], parts[1]
	if s.fixture {
		writeJSON(w, http.StatusOK, fixtureRoom(source, id, r.URL.Query().Get("kind")))
		return
	}
	var requestPath string
	if source == "kafei" {
		requestPath = "/api/v1/room/" + url.PathEscape(id)
	} else {
		if r.URL.Query().Get("kind") == "replay" {
			requestPath = "/api/v1/playbacks/" + url.PathEscape(id)
		} else {
			requestPath = "/api/v1/public/signals/" + url.PathEscape(id)
		}
	}
	body, stale, err := s.fetchSource(r.Context(), source, requestPath, url.Values{}, false)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadGateway)
		return
	}
	var envelope map[string]interface{}
	if err := json.Unmarshal(body, &envelope); err != nil {
		http.Error(w, "invalid upstream response", http.StatusBadGateway)
		return
	}
	data := asMap(envelope["data"])
	result := map[string]interface{}{"source": source, "stale": stale, "signals": []interface{}{}}
	if source == "kafei" {
		result["status"] = normalizeKafeiRoomStatus(data)
		result["signals"] = normalizeKafeiSignals(data)
		result["title"] = firstString(data, "name", "title")
	} else {
		if r.URL.Query().Get("kind") == "replay" {
			playback := asMap(data["playback"])
			if playback != nil {
				data = playback
			}
			result["status"] = "finished"
			result["title"] = firstString(data, "title")
			result["league"] = firstString(asMap(data["schedule"]), "league")
			result["signals"] = normalizeDoubaoReplaySignals(data)
		} else {
			result["status"] = normalizeDoubaoRoomStatus(data)
			result["title"] = firstString(data, "title")
			result["league"] = firstString(asMap(data["schedule"]), "league")
			result["signals"] = normalizeDoubaoSignals(data)
		}
	}
	writeJSON(w, http.StatusOK, map[string]interface{}{"success": true, "code": 0, "data": result})
}

func (s *Server) resolvePlayback(w http.ResponseWriter, r *http.Request) {
	parts := strings.Split(strings.TrimPrefix(r.URL.Path, "/api/v2/play/"), "/")
	if len(parts) != 3 || (parts[0] != "kafei" && parts[0] != "doubao") || (parts[1] != "live" && parts[1] != "replay") {
		http.NotFound(w, r)
		return
	}
	source, kind, id := parts[0], parts[1], parts[2]
	if s.fixture {
		writeJSON(w, http.StatusOK, map[string]interface{}{"success": true, "data": map[string]interface{}{"url": "https://test.invalid/live/demo.m3u8", "kind": "hls", "status": "live"}})
		return
	}
	if source == "kafei" {
		room, err := s.roomData(source, id)
		if err != nil {
			http.Error(w, err.Error(), http.StatusBadGateway)
			return
		}
		signals := normalizeKafeiSignals(room)
		index, _ := strconv.Atoi(r.URL.Query().Get("signal"))
		if index < 0 || index >= len(signals) {
			index = 0
		}
		if len(signals) == 0 {
			http.Error(w, "no playback signal", http.StatusBadGateway)
			return
		}
		writeJSON(w, http.StatusOK, map[string]interface{}{"success": true, "code": 0, "data": map[string]interface{}{"url": firstString(asMap(signals[index]), "url"), "kind": "hls", "status": normalizeKafeiRoomStatus(room)}})
		return
	}
	requestPath := "/api/v1/public/signals/" + url.PathEscape(id) + "/play"
	if kind == "replay" {
		requestPath = "/api/v1/playbacks/" + url.PathEscape(id)
	}
	body, _, err := s.fetchSource(r.Context(), source, requestPath, url.Values{}, false)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadGateway)
		return
	}
	var envelope map[string]interface{}
	if err := json.Unmarshal(body, &envelope); err != nil {
		http.Error(w, "invalid playback response", http.StatusBadGateway)
		return
	}
	data := asMap(envelope["data"])
	if kind == "replay" {
		proxy := firstString(data, "proxyUrl")
		if proxy == "" {
			http.Error(w, "playback unavailable", http.StatusBadGateway)
			return
		}
		proxy = absoluteURL(s.cfg.DoubaoUpstream, proxy)
		writeJSON(w, http.StatusOK, map[string]interface{}{"success": true, "code": 0, "data": map[string]interface{}{"url": proxy, "kind": "hls", "status": "finished"}})
		return
	}
	writeJSON(w, http.StatusOK, map[string]interface{}{"success": true, "code": 0, "data": map[string]interface{}{"url": firstString(data, "url"), "kind": firstString(data, "kind"), "status": "live"}})
}

func (s *Server) roomData(source, id string) (map[string]interface{}, error) {
	body, _, err := s.fetchSource(context.Background(), source, "/api/v1/room/"+url.PathEscape(id), url.Values{}, false)
	if err != nil {
		return nil, err
	}
	var envelope map[string]interface{}
	if err := json.Unmarshal(body, &envelope); err != nil {
		return nil, err
	}
	return asMap(envelope["data"]), nil
}

func normalizeKafeiSignals(data map[string]interface{}) []interface{} {
	values := asSlice(data["signals"])
	if len(values) == 0 {
		values = asSlice(data["streams"])
	}
	result := []interface{}{}
	for _, raw := range values {
		m := asMap(raw)
		if m != nil {
			result = append(result, map[string]interface{}{"name": firstString(m, "name", "title", "label"), "url": firstString(m, "url", "stream_url", "play_url", "m3u8")})
		}
	}
	if len(result) == 0 {
		if stream := firstString(data, "stream_url"); stream != "" {
			result = append(result, map[string]interface{}{"name": "默认线路", "url": stream})
		}
	}
	return result
}

func normalizeDoubaoSignals(data map[string]interface{}) []interface{} {
	result := []interface{}{}
	for _, raw := range asSlice(data["signals"]) {
		m := asMap(raw)
		if m == nil {
			continue
		}
		id := firstString(m, "playId", "url")
		if id == "" {
			continue
		}
		result = append(result, map[string]interface{}{"name": firstString(m, "name", "title"), "resolve": "/api/v2/play/doubao/live/" + url.PathEscape(id)})
	}
	if len(result) == 0 {
		if id := firstString(data, "playId"); id != "" {
			result = append(result, map[string]interface{}{"name": firstString(data, "name", "title"), "resolve": "/api/v2/play/doubao/live/" + url.PathEscape(id)})
		}
	}
	return result
}

func normalizeDoubaoReplaySignals(data map[string]interface{}) []interface{} {
	result := []interface{}{}
	for _, raw := range asSlice(data["lines"]) {
		line := asMap(raw)
		if line == nil {
			continue
		}
		routeID := firstString(line, "routeId")
		if routeID == "" {
			continue
		}
		result = append(result, map[string]interface{}{"name": firstString(line, "title", "name"), "resolve": "/api/v2/play/doubao/replay/" + url.PathEscape(routeID)})
	}
	if len(result) == 0 {
		if proxy := firstString(data, "proxyUrl"); proxy != "" {
			result = append(result, map[string]interface{}{"name": "回放", "url": absoluteURL("https://www.doubaozhibo.com", proxy)})
		}
	}
	return result
}

func fixtureFeedItems(source, view, category string) []feedItem {
	if source == "kafei" {
		rows := fixtureLive(category)
		return normalizeKafeiItems(view, mapsToInterfaces(rows))
	}
	if view == "replay" {
		return []feedItem{{ID: "doubao-87", Source: "doubao", SourceLabel: "豆包直播", Kind: "replay", RoomID: "87-1", ReplayID: "87-1", MatchID: "87", Title: "NBA 雷霆 VS 掘金", LeagueName: "NBA", HomeTeam: "雷霆", AwayTeam: "掘金", Status: "finished", StartTime: "2026-10-23 09:30", RecordingCount: 3}}
	}
	item := feedItem{ID: "doubao-90", Source: "doubao", SourceLabel: "豆包直播", Kind: "live", RoomID: "90-1-2", PlayID: "90-1-2", MatchID: "90", Title: "CBA 辽宁 VS 四川", LeagueName: "CBA", HomeTeam: "辽宁", AwayTeam: "四川", HomeScore: 62, AwayScore: 61, Status: "live", StartTime: "2026-10-23 19:35", SignalCount: 2}
	if category == "all" || category == "hot" || category == "2" {
		return []feedItem{item}
	}
	return []feedItem{}
}

func fixtureRoom(source, id, kind string) map[string]interface{} {
	if source == "doubao" && kind == "replay" {
		return map[string]interface{}{"success": true, "code": 0, "data": map[string]interface{}{"source": source, "status": "finished", "signals": []interface{}{map[string]interface{}{"name": "中文高清回放", "resolve": "/api/v2/play/doubao/replay/87-1"}}}}
	}
	if source == "doubao" {
		return map[string]interface{}{"success": true, "code": 0, "data": map[string]interface{}{"source": source, "status": "live", "title": "CBA 辽宁 VS 四川", "signals": []interface{}{map[string]interface{}{"name": "高清直播1", "resolve": "/api/v2/play/doubao/live/90-1-2"}, map[string]interface{}{"name": "高清直播2", "resolve": "/api/v2/play/doubao/live/90-2-1"}}}}
	}
	return map[string]interface{}{"success": true, "code": 0, "data": map[string]interface{}{"source": source, "status": "live", "signals": []interface{}{map[string]interface{}{"name": "普通解说", "url": "https://test.invalid/live/demo.m3u8"}, map[string]interface{}{"name": "原声", "url": "https://test.invalid/live/demo-original.m3u8"}}}}
}

func kafeiCategory(category string) string {
	if category == "all" {
		return "all"
	}
	return category
}
func doubaoCategory(category string) string {
	switch category {
	case "1":
		return "football"
	case "2":
		return "basketball"
	case "hot":
		return "important"
	default:
		return "all"
	}
}
func normalizeKafeiStatus(value string) string {
	switch strings.ToLower(value) {
	case "live", "online", "直播中":
		return "live"
	case "finished", "ended", "已结束":
		return "finished"
	case "cancelled", "取消":
		return "cancelled"
	case "deferred", "延期":
		return "deferred"
	default:
		return "upcoming"
	}
}
func normalizeDoubaoStatus(value interface{}) string {
	switch asInt(value) {
	case 1:
		return "live"
	case 2:
		return "finished"
	case 3:
		return "deferred"
	case 4:
		return "cancelled"
	default:
		return "upcoming"
	}
}
func normalizeKafeiRoomStatus(data map[string]interface{}) string {
	status := firstString(data, "status")
	if status == "" {
		status = firstString(asMap(data["archor"]), "status")
	}
	return normalizeKafeiStatus(status)
}
func normalizeDoubaoRoomStatus(data map[string]interface{}) string {
	if asBool(data["live"]) && asBool(data["playable"]) {
		return "live"
	}
	schedule := asMap(data["schedule"])
	if asInt(schedule["status"]) == 2 || strings.Contains(firstString(data, "state"), "结束") {
		return "finished"
	}
	return "upcoming"
}
func titleFallback(league, home, away string) string {
	if home == "" && away == "" {
		return league
	}
	return " " + league + " " + home + " VS " + away
}
func playIDFromURL(value string) string {
	value = strings.Trim(value, "/")
	if value == "" {
		return ""
	}
	base := path.Base(value)
	if strings.HasPrefix(base, "play") {
		return ""
	}
	return base
}
func teamFromTitle(title string, home bool) string {
	parts := strings.Split(title, " vs ")
	if len(parts) < 2 {
		parts = strings.Split(title, " VS ")
	}
	if len(parts) < 2 {
		return ""
	}
	value := strings.TrimSpace(parts[0])
	if strings.Contains(value, " ") {
		value = strings.TrimSpace(strings.SplitN(value, " ", 2)[1])
	}
	if !home {
		return strings.TrimSpace(parts[1])
	}
	return value
}
func absoluteURL(base, value string) string {
	if value == "" || strings.HasPrefix(value, "http://") || strings.HasPrefix(value, "https://") {
		return value
	}
	return strings.TrimRight(base, "/") + "/" + strings.TrimLeft(value, "/")
}
func intPtr(value int) *int { return &value }
func mapsToInterfaces(values []map[string]interface{}) []interface{} {
	result := make([]interface{}, len(values))
	for i, value := range values {
		result[i] = value
	}
	return result
}
func rowsFromEnvelope(envelope map[string]interface{}) []interface{} {
	data := envelope["data"]
	if values, ok := data.([]interface{}); ok {
		return values
	}
	m := asMap(data)
	if m != nil {
		for _, key := range []string{"list", "rows", "items"} {
			if values, ok := m[key].([]interface{}); ok {
				return values
			}
		}
	}
	return nil
}
func asMap(value interface{}) map[string]interface{} {
	m, _ := value.(map[string]interface{})
	return m
}
func asSlice(value interface{}) []interface{} { values, _ := value.([]interface{}); return values }
func asString(value interface{}) string {
	if value == nil {
		return ""
	}
	return fmt.Sprint(value)
}
func asInt(value interface{}) int {
	switch value := value.(type) {
	case int:
		return value
	case int64:
		return int(value)
	case float64:
		return int(value)
	case json.Number:
		n, _ := strconv.Atoi(string(value))
		return n
	case string:
		n, _ := strconv.Atoi(value)
		return n
	default:
		return 0
	}
}
func asBool(value interface{}) bool { b, _ := value.(bool); return b }
func firstString(m map[string]interface{}, keys ...string) string {
	for _, key := range keys {
		if value := asString(m[key]); value != "" && value != "<nil>" {
			return value
		}
	}
	return ""
}
func value(m map[string]interface{}, keys ...string) interface{} {
	for _, key := range keys {
		if value, ok := m[key]; ok && value != nil {
			return value
		}
	}
	return nil
}
