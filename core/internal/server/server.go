package server

import (
	"encoding/json"
	"errors"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"

	product "cc.kafeizhibo.tv"
	"cc.kafeizhibo.tv/ui"
)

type Server struct {
	cfg               product.Config
	version, instance string
	fixture           bool
	updateProxies     []string
	client            *http.Client
	doubaoClient      *http.Client
	feedTimeout       time.Duration
	roomTimeout       time.Duration
	playbackTimeout   time.Duration
	mu                sync.RWMutex
	metadata          map[string]cachedResponse
	metadataFlights   map[string]*metadataFlight
}

type cachedResponse struct {
	body       []byte
	expires    time.Time
	staleUntil time.Time
}

func New(cfg product.Config, version, instance string, fixture bool) *Server {
	return &Server{cfg: cfg, version: version, instance: instance, fixture: fixture, updateProxies: []string{"https://ghfast.top/", "https://ghproxy.net/", "https://gh-proxy.com/"}, client: newUpstreamClient(), doubaoClient: newUpstreamClient(), feedTimeout: 6 * time.Second, roomTimeout: 6 * time.Second, playbackTimeout: 6 * time.Second, metadata: make(map[string]cachedResponse)}
}

func (s *Server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	if r.URL.Path == "/health" {
		s.health(w)
		return
	}
	if r.URL.Path == "/" || r.URL.Path == "/index.html" {
		serveIndex(w, r)
		return
	}
	if strings.HasPrefix(r.URL.Path, "/ui/") {
		serveUI(w, r)
		return
	}
	if strings.HasPrefix(r.URL.Path, "/api/") {
		if strings.HasPrefix(r.URL.Path, "/api/v2/") {
			s.apiV2(w, r)
			return
		}
		s.api(w, r)
		return
	}
	http.NotFound(w, r)
}

func serveIndex(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	_, _ = w.Write(ui.IndexHTML)
}
func serveUI(w http.ResponseWriter, r *http.Request) {
	name := strings.TrimPrefix(r.URL.Path, "/ui/")
	asset, ok := ui.Asset(name)
	if !ok {
		http.NotFound(w, r)
		return
	}
	w.Header().Set("Content-Type", asset.ContentType)
	_, _ = w.Write(asset.Data)
}

func (s *Server) health(w http.ResponseWriter) {
	writeJSON(w, http.StatusOK, map[string]interface{}{"ready": true, "version": s.version, "versionCode": s.cfg.VersionCode, "instanceId": s.instance, "capabilities": map[string]bool{"fixture": s.fixture, "member": false, "playback": true}})
}

func (s *Server) api(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	if s.fixture {
		writeJSON(w, http.StatusOK, fixtureResponse(r.URL.Path, r.URL.Query()))
		return
	}
	// Use the same bounded transport and cache rules as the v2 adapters.
	cacheable := !strings.Contains(r.URL.Path, "/room/") && !strings.Contains(r.URL.Path, "/match/")
	body, stale, err := s.fetchSource(r.Context(), "kafei", r.URL.Path, r.URL.Query(), cacheable)
	if err != nil {
		writeUpstreamError(w, "kafei", err)
		return
	}
	if stale {
		w.Header().Set("X-KafeiTV-Cache", "stale")
	}
	writeRawJSON(w, body)
}

func upstreamURL(base, requestPath string, query url.Values) (string, error) {
	root, err := url.Parse(strings.TrimRight(base, "/") + "/")
	if err != nil || root.Scheme == "" || root.Host == "" {
		return "", errors.New("bad base")
	}
	root.Path = strings.TrimRight(root.Path, "/") + "/" + strings.TrimLeft(strings.TrimPrefix(requestPath, "/"), "/")
	root.RawQuery = query.Encode()
	return root.String(), nil
}

func (s *Server) cached(key string) ([]byte, bool) {
	s.mu.RLock()
	entry, ok := s.metadata[key]
	s.mu.RUnlock()
	if !ok || time.Now().After(entry.expires) {
		return nil, false
	}
	return entry.body, true
}
func (s *Server) stale(key string) ([]byte, bool) {
	s.mu.RLock()
	entry, ok := s.metadata[key]
	s.mu.RUnlock()
	if !ok || time.Now().After(entry.staleUntil) {
		return nil, false
	}
	return entry.body, true
}
func (s *Server) store(key string, body []byte, ttl time.Duration) {
	s.mu.Lock()
	now := time.Now()
	for cacheKey, entry := range s.metadata {
		if now.After(entry.staleUntil) {
			delete(s.metadata, cacheKey)
		}
	}
	if len(s.metadata) >= 128 {
		for cacheKey := range s.metadata {
			delete(s.metadata, cacheKey)
			break
		}
	}
	expires := now.Add(ttl)
	s.metadata[key] = cachedResponse{body: append([]byte(nil), body...), expires: expires, staleUntil: expires.Add(5 * time.Minute)}
	s.mu.Unlock()
}
func writeRawJSON(w http.ResponseWriter, body []byte) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	_, _ = w.Write(body)
}
func writeJSON(w http.ResponseWriter, status int, value interface{}) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}
func intQuery(q url.Values, key string, fallback int) int {
	n, err := strconv.Atoi(q.Get(key))
	if err != nil || n < 1 {
		return fallback
	}
	return n
}

func fixtureResponse(path string, query url.Values) interface{} {
	if path == "/api/v1/archor" {
		return map[string]interface{}{"code": 200, "message": "success", "data": fixtureLive(query.Get("type"))}
	}
	if path == "/api/v1/hot-matches" {
		return map[string]interface{}{"code": 200, "message": "success", "data": fixtureMatches()}
	}
	if path == "/api/v1/schedule" {
		items := fixtureSchedule(query.Get("type"), 1, 1000)
		page, size := intQuery(query, "page", 1), intQuery(query, "size", 20)
		return map[string]interface{}{"code": 200, "message": "success", "data": pageItems(items, page, size), "total": len(items)}
	}
	if path == "/api/v1/recordings" {
		items := fixtureRecordings(query.Get("type"), 1, 1000)
		page, size := intQuery(query, "page", 1), intQuery(query, "size", 20)
		return map[string]interface{}{"code": 200, "message": "success", "data": pageItems(items, page, size), "total": len(items)}
	}
	if strings.HasPrefix(path, "/api/v1/room/") {
		return map[string]interface{}{"code": 200, "message": "success", "data": map[string]interface{}{"room_id": strings.TrimPrefix(path, "/api/v1/room/"), "name": "直播22", "signals": []map[string]string{{"name": "普通解说", "url": "https://test.invalid/live/demo.m3u8"}, {"name": "原声", "url": "https://test.invalid/live/demo-original.m3u8"}}}}
	}
	if strings.HasPrefix(path, "/api/v1/match/") {
		return map[string]interface{}{"code": 200, "message": "success", "data": []interface{}{}}
	}
	return map[string]interface{}{"code": 404, "message": "not found", "data": []interface{}{}}
}

func pageItems(items []map[string]interface{}, page, size int) []map[string]interface{} {
	if page < 1 {
		page = 1
	}
	if size < 1 {
		size = 20
	}
	start := (page - 1) * size
	if start >= len(items) {
		return []map[string]interface{}{}
	}
	end := start + size
	if end > len(items) {
		end = len(items)
	}
	return items[start:end]
}
