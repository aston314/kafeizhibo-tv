package server

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	product "cc.kafeizhibo.tv"
)

func TestNormalizeFeedPreservesTeamLogos(t *testing.T) {
	kafei := normalizeKafeiItems("schedule", []interface{}{map[string]interface{}{
		"home_team": "主队",
		"away_team": "客队",
		"match_info": map[string]interface{}{
			"home_team_logo": "/teams/home.png",
			"away_team_logo": "https://cdn.example/away.png",
		},
	}})
	if len(kafei) != 1 || kafei[0].HomeTeamLogo != "https://kafeizhibo.cc/teams/home.png" || kafei[0].AwayTeamLogo != "https://cdn.example/away.png" {
		t.Fatalf("kafei logos were not preserved: %+v", kafei)
	}

	doubao := normalizeDoubaoSchedules(map[string]interface{}{"items": []interface{}{map[string]interface{}{
		"match": map[string]interface{}{
			"id": 42, "home": "主队", "away": "客队",
			"homeLogo": "/teams/home.png", "awayLogo": "https://cdn.example/away.png",
		},
	}}})
	if len(doubao) != 1 || doubao[0].HomeTeamLogo != "https://www.doubaozhibo.com/teams/home.png" || doubao[0].AwayTeamLogo != "https://cdn.example/away.png" {
		t.Fatalf("doubao logos were not preserved: %+v", doubao)
	}
}

func TestDoubaoLiveFeedEnrichesRoomsFromSchedules(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/v1/home/rooms":
			_, _ = w.Write([]byte(`{"success":true,"code":0,"data":{"items":[{"id":468,"title":"沙特联 临时主队 vs 临时客队","matchId":95,"league":"沙特联","status":1,"url":"/play/95-1-2"}],"total":1}}`))
		case "/api/v1/home/schedules":
			_, _ = w.Write([]byte(`{"success":true,"code":0,"data":{"items":[{"match":{"id":95,"league":"沙特联","home":"吉达联合","away":"迪里耶","homeLogo":"/teams/home.png","awayLogo":"/teams/away.png","homeScore":0,"awayScore":1,"status":1,"matchTime":"2026-10-23T15:30:00Z"},"rooms":[]}]}}`))
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	defer upstream.Close()

	cfg := product.Load()
	cfg.DoubaoUpstream = upstream.URL
	s := New(cfg, "test", "doubao-enrichment", false)
	res := httptest.NewRecorder()
	s.ServeHTTP(res, httptest.NewRequest(http.MethodGet, "/api/v2/feed?view=live&source=doubao&category=all&page=1&size=12", nil))
	if res.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", res.Code, res.Body.String())
	}
	var payload struct {
		Data struct {
			Items []feedItem `json:"items"`
		} `json:"data"`
	}
	if err := json.Unmarshal(res.Body.Bytes(), &payload); err != nil {
		t.Fatal(err)
	}
	if len(payload.Data.Items) != 1 {
		t.Fatalf("items=%+v", payload.Data.Items)
	}
	item := payload.Data.Items[0]
	if item.HomeTeam != "吉达联合" || item.AwayTeam != "迪里耶" || item.HomeScore != float64(0) || item.AwayScore != float64(1) {
		t.Fatalf("team metadata was not merged: %+v", item)
	}
	if item.HomeTeamLogo != "https://www.doubaozhibo.com/teams/home.png" || item.AwayTeamLogo != "https://www.doubaozhibo.com/teams/away.png" {
		t.Fatalf("team logos were not merged: %+v", item)
	}
}

func TestFixtureRoutesAndHealth(t *testing.T) {
	cfg := product.Load()
	s := New(cfg, "test", "fixture-test", true)
	for _, tc := range []struct{ path, want string }{
		{"/health", `"ready":true`},
		{"/api/v2/update", fmt.Sprintf(`"version_code":%d`, cfg.VersionCode)},
		{"/api/v1/archor?type=2", `"category":2`},
		{"/api/v1/room/1022", `"signals"`},
	} {
		req := httptest.NewRequest("GET", tc.path, nil)
		res := httptest.NewRecorder()
		s.ServeHTTP(res, req)
		if res.Code != 200 {
			t.Fatalf("%s: status %d", tc.path, res.Code)
		}
		if body := res.Body.String(); !contains(body, tc.want) {
			t.Fatalf("%s: response missing %s: %s", tc.path, tc.want, body)
		}
	}
}

type roundTripFunc func(*http.Request) (*http.Response, error)

func (f roundTripFunc) RoundTrip(request *http.Request) (*http.Response, error) { return f(request) }

func TestUpdateManifestFallsBackAcrossProxiesThenDirect(t *testing.T) {
	cfg := product.Load()
	cfg.UpdateManifest = "https://github.com/aston314/kafeizhibo-tv/releases/latest/download/update.json"
	s := New(cfg, "test", "update-proxy-test", false)
	s.updateProxies = []string{"https://proxy-one.test/", "https://proxy-two.test/"}
	var calls []string
	s.client = &http.Client{Transport: roundTripFunc(func(request *http.Request) (*http.Response, error) {
		calls = append(calls, request.URL.Host)
		status, body := http.StatusBadGateway, "proxy unavailable"
		if request.URL.Host == "github.com" {
			status, body = http.StatusOK, fmt.Sprintf(`{"package_name":%q,"version_code":10}`, cfg.ApplicationID)
		}
		return &http.Response{StatusCode: status, Header: make(http.Header), Body: io.NopCloser(strings.NewReader(body)), Request: request}, nil
	})}

	res := httptest.NewRecorder()
	s.ServeHTTP(res, httptest.NewRequest(http.MethodGet, "/api/v2/update", nil))
	if res.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", res.Code, res.Body.String())
	}
	if strings.Join(calls, ",") != "proxy-one.test,proxy-two.test,github.com" {
		t.Fatalf("sources were not tried in order: %v", calls)
	}
}

func TestUpdateSourcesKeepsDirectLastAndRemovesDuplicates(t *testing.T) {
	origin := "https://github.com/owner/repo/releases/latest/download/update.json"
	sources := updateSources(origin, []string{"https://proxy.test/", "https://proxy.test", ""})
	want := []string{"https://proxy.test/" + origin, origin}
	if len(sources) != len(want) {
		t.Fatalf("sources=%v", sources)
	}
	for index := range want {
		if sources[index] != want[index] {
			t.Fatalf("source %d=%q want %q", index, sources[index], want[index])
		}
	}
	if _, err := url.Parse(sources[0]); err != nil {
		t.Fatalf("invalid proxy URL: %v", err)
	}
}

func TestMetadataCacheExpiry(t *testing.T) {
	s := New(product.Load(), "test", "cache-test", true)
	s.store("key", []byte(`{"ok":true}`), time.Millisecond)
	if body, ok := s.cached("key"); !ok || string(body) != `{"ok":true}` {
		t.Fatal("fresh cache entry not returned")
	}
	time.Sleep(3 * time.Millisecond)
	if _, ok := s.cached("key"); ok {
		t.Fatal("expired cache entry returned")
	}
}

func TestUpstreamRetriesOnceAfter502(t *testing.T) {
	var calls atomic.Int32
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if calls.Add(1) == 1 {
			w.WriteHeader(http.StatusBadGateway)
			return
		}
		_, _ = w.Write([]byte(`{"ok":true}`))
	}))
	defer upstream.Close()

	cfg := product.Load()
	cfg.Upstream = upstream.URL
	s := New(cfg, "test", "retry-test", false)
	res := httptest.NewRecorder()
	s.ServeHTTP(res, httptest.NewRequest(http.MethodGet, "/api/v1/archor?type=all", nil))

	if res.Code != http.StatusOK || calls.Load() != 2 || res.Body.String() != `{"ok":true}` {
		t.Fatalf("status=%d calls=%d body=%q", res.Code, calls.Load(), res.Body.String())
	}
}

func TestMetadataUsesStaleResponseAfterRepeatedUpstreamFailure(t *testing.T) {
	var calls atomic.Int32
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		w.WriteHeader(http.StatusBadGateway)
	}))
	defer upstream.Close()

	cfg := product.Load()
	cfg.Upstream = upstream.URL
	s := New(cfg, "test", "stale-test", false)
	key := upstream.URL + "/api/v1/archor?type=all"
	s.store(key, []byte(`{"stale":true}`), -time.Second)
	res := httptest.NewRecorder()
	s.ServeHTTP(res, httptest.NewRequest(http.MethodGet, "/api/v1/archor?type=all", nil))

	if res.Code != http.StatusOK || res.Header().Get("X-KafeiTV-Cache") != "stale" || res.Body.String() != `{"stale":true}` || calls.Load() != 2 {
		t.Fatalf("status=%d cache=%q calls=%d body=%q", res.Code, res.Header().Get("X-KafeiTV-Cache"), calls.Load(), res.Body.String())
	}
}

func TestRoomFailureDoesNotUseStalePlaybackURL(t *testing.T) {
	var calls atomic.Int32
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		w.WriteHeader(http.StatusBadGateway)
	}))
	defer upstream.Close()

	cfg := product.Load()
	cfg.Upstream = upstream.URL
	s := New(cfg, "test", "room-stale-test", false)
	s.store(upstream.URL+"/api/v1/room/expired", []byte(`{"stream_url":"https://old.invalid/live.m3u8"}`), -time.Second)
	res := httptest.NewRecorder()
	s.ServeHTTP(res, httptest.NewRequest(http.MethodGet, "/api/v1/room/expired", nil))

	if res.Code != http.StatusBadGateway || res.Header().Get("X-KafeiTV-Cache") != "" || calls.Load() != 2 {
		t.Fatalf("status=%d cache=%q calls=%d body=%q", res.Code, res.Header().Get("X-KafeiTV-Cache"), calls.Load(), res.Body.String())
	}
}

func TestUnifiedFixtureFeedContainsBothSources(t *testing.T) {
	s := New(product.Load(), "test", "multi-fixture", true)
	res := httptest.NewRecorder()
	s.ServeHTTP(res, httptest.NewRequest(http.MethodGet, "/api/v2/feed?view=live&source=all&category=all&page=1&size=12", nil))
	if res.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", res.Code, res.Body.String())
	}
	var payload struct {
		Data struct {
			Items []struct {
				Source string `json:"source"`
			} `json:"items"`
		} `json:"data"`
	}
	if err := json.Unmarshal(res.Body.Bytes(), &payload); err != nil {
		t.Fatal(err)
	}
	seen := map[string]bool{}
	for _, item := range payload.Data.Items {
		seen[item.Source] = true
	}
	if !seen["kafei"] || !seen["doubao"] {
		t.Fatalf("sources=%v body=%s", seen, res.Body.String())
	}
}

func TestUnifiedFeedKeepsDoubaoWhenKafeiFails(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/api/v1/archor" {
			w.WriteHeader(http.StatusBadGateway)
			return
		}
		if r.URL.Path == "/api/v1/home/rooms" {
			_, _ = w.Write([]byte(`{"success":true,"code":0,"data":{"items":[{"id":9,"title":"CBA 甲 vs 乙","anchor":"高清直播1","matchId":9,"league":"CBA","status":1,"url":"/play/9-1-1"}],"total":1,"page":1,"pageSize":12}}`))
			return
		}
		w.WriteHeader(http.StatusNotFound)
	}))
	defer upstream.Close()
	cfg := product.Load()
	cfg.Upstream = upstream.URL
	cfg.DoubaoUpstream = upstream.URL
	s := New(cfg, "test", "multi-isolation", false)
	res := httptest.NewRecorder()
	s.ServeHTTP(res, httptest.NewRequest(http.MethodGet, "/api/v2/feed?view=live&source=all&category=all&page=1&size=12", nil))
	if res.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", res.Code, res.Body.String())
	}
	var payload struct {
		Data struct {
			Items []struct {
				Source string `json:"source"`
			} `json:"items"`
		} `json:"data"`
		Sources map[string]struct {
			Status string `json:"status"`
		} `json:"sources"`
	}
	if err := json.Unmarshal(res.Body.Bytes(), &payload); err != nil {
		t.Fatal(err)
	}
	if len(payload.Data.Items) != 1 || payload.Data.Items[0].Source != "doubao" {
		t.Fatalf("items=%v body=%s", payload.Data.Items, res.Body.String())
	}
	if payload.Sources["kafei"].Status != "error" || payload.Sources["doubao"].Status != "ok" {
		t.Fatalf("sources=%v", payload.Sources)
	}
}

func TestUnifiedFeedReturnsWithoutWaitingForSlowSource(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/v1/archor":
			<-r.Context().Done()
		case "/api/v1/home/rooms":
			_, _ = w.Write([]byte(`{"success":true,"code":0,"data":{"items":[{"id":9,"title":"CBA 甲 vs 乙","matchId":9,"status":1,"url":"/play/9-1-1"}],"total":1}}`))
		case "/api/v1/home/schedules":
			_, _ = w.Write([]byte(`{"success":true,"code":0,"data":{"items":[]}}`))
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	defer upstream.Close()

	cfg := product.Load()
	cfg.Upstream = upstream.URL
	cfg.DoubaoUpstream = upstream.URL
	s := New(cfg, "test", "feed-timeout", false)
	s.feedTimeout = 80 * time.Millisecond
	started := time.Now()
	res := httptest.NewRecorder()
	s.ServeHTTP(res, httptest.NewRequest(http.MethodGet, "/api/v2/feed?view=live&source=all&category=all&page=1&size=12", nil))
	if elapsed := time.Since(started); elapsed > time.Second {
		t.Fatalf("feed waited %s for a slow source", elapsed)
	}
	if res.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", res.Code, res.Body.String())
	}
	var payload struct {
		Data struct {
			Items []feedItem `json:"items"`
		} `json:"data"`
		Sources map[string]sourceState `json:"sources"`
	}
	if err := json.Unmarshal(res.Body.Bytes(), &payload); err != nil {
		t.Fatal(err)
	}
	if len(payload.Data.Items) != 1 || payload.Data.Items[0].Source != "doubao" {
		t.Fatalf("items=%+v body=%s", payload.Data.Items, res.Body.String())
	}
	if payload.Sources["kafei"].Status != "error" || payload.Sources["doubao"].Status != "ok" {
		t.Fatalf("sources=%+v", payload.Sources)
	}
}

func TestRoomAndPlaybackRequestsRespectTimeouts(t *testing.T) {
	for _, tc := range []struct {
		name, path, upstreamPath string
		playback                 bool
	}{
		{name: "room details", path: "/api/v2/room/doubao/95-1-2", upstreamPath: "/api/v1/public/signals/95-1-2"},
		{name: "playback URL", path: "/api/v2/play/doubao/live/95-1-2", upstreamPath: "/api/v1/public/signals/95-1-2/play", playback: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.URL.Path == tc.upstreamPath {
					<-r.Context().Done()
					return
				}
				w.WriteHeader(http.StatusNotFound)
			}))
			defer upstream.Close()

			cfg := product.Load()
			cfg.DoubaoUpstream = upstream.URL
			s := New(cfg, "test", "request-timeout", false)
			if tc.playback {
				s.playbackTimeout = 80 * time.Millisecond
			} else {
				s.roomTimeout = 80 * time.Millisecond
			}
			started := time.Now()
			res := httptest.NewRecorder()
			s.ServeHTTP(res, httptest.NewRequest(http.MethodGet, tc.path, nil))
			if elapsed := time.Since(started); elapsed > time.Second {
				t.Fatalf("request waited %s for a slow upstream", elapsed)
			}
			if res.Code != http.StatusBadGateway {
				t.Fatalf("status=%d body=%s", res.Code, res.Body.String())
			}
		})
	}
}

func contains(value, part string) bool {
	for i := 0; i+len(part) <= len(value); i++ {
		if value[i:i+len(part)] == part {
			return true
		}
	}
	return false
}
