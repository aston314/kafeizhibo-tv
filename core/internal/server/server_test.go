package server

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"

	product "cc.kafeizhibo.tv"
)

func TestFixtureRoutesAndHealth(t *testing.T) {
	s := New(product.Load(), "test", "fixture-test", true)
	for _, tc := range []struct{ path, want string }{
		{"/health", `"ready":true`},
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

func contains(value, part string) bool {
	for i := 0; i+len(part) <= len(value); i++ {
		if value[i:i+len(part)] == part {
			return true
		}
	}
	return false
}
