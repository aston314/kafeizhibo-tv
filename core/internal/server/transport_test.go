package server

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	product "cc.kafeizhibo.tv"
)

func TestRecoveryReplacesStalledConnectionAndCancelsLoser(t *testing.T) {
	for _, partialBody := range []bool{false, true} {
		t.Run(fmt.Sprintf("partial_body_%v", partialBody), func(t *testing.T) {
			var connections atomic.Int32
			var requests atomic.Int32
			canceled := make(chan struct{}, 1)
			type connectionKey struct{}
			upstream := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				requests.Add(1)
				if r.Context().Value(connectionKey{}).(int32) == 1 {
					if partialBody {
						_, _ = w.Write([]byte(`{"incomplete":`))
						w.(http.Flusher).Flush()
					}
					<-r.Context().Done()
					canceled <- struct{}{}
					return
				}
				_, _ = w.Write([]byte(`{"healthy":true}`))
			}))
			upstream.Config.ConnContext = func(ctx context.Context, _ net.Conn) context.Context {
				return context.WithValue(ctx, connectionKey{}, connections.Add(1))
			}
			upstream.Start()
			defer upstream.Close()
			var recoveries atomic.Int32
			transport := &recoveringTransport{current: newUpstreamTransport(), delay: 30 * time.Millisecond,
				fresh: func() http.RoundTripper { recoveries.Add(1); return newUpstreamTransport() },
			}
			defer transport.CloseIdleConnections()
			client := &http.Client{Transport: transport, Timeout: time.Second}
			start := time.Now()
			response, err := client.Get(upstream.URL)
			if err != nil {
				t.Fatal(err)
			}
			body, _ := io.ReadAll(response.Body)
			response.Body.Close()
			if string(body) != `{"healthy":true}` || time.Since(start) > 800*time.Millisecond {
				t.Fatalf("failed to recover promptly: body=%s elapsed=%s", body, time.Since(start))
			}

			select {
			case <-canceled:
			case <-time.After(time.Second):
				t.Fatal("losing request was not canceled")
			}
			response, err = client.Get(upstream.URL)
			if err != nil {
				t.Fatal(err)
			}
			response.Body.Close()
			if recoveries.Load() != 1 || connections.Load() != 2 || requests.Load() != 3 {
				t.Fatalf("healthy replacement was not reused: recoveries=%d connections=%d requests=%d", recoveries.Load(), connections.Load(), requests.Load())
			}
		})
	}
}

func TestRecoveryDoesNotRetryPermanentRejection(t *testing.T) {
	var calls atomic.Int32
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		http.Error(w, "forbidden", http.StatusForbidden)
	}))
	defer upstream.Close()
	client := newUpstreamClient()
	defer client.CloseIdleConnections()
	response, err := client.Get(upstream.URL)
	if err != nil {
		t.Fatal(err)
	}
	response.Body.Close()
	if response.StatusCode != http.StatusForbidden || calls.Load() != 1 {
		t.Fatalf("status=%d calls=%d", response.StatusCode, calls.Load())
	}
}

func TestInvalidJSONIsNotCachedAndRecoveryIsBounded(t *testing.T) {
	var calls atomic.Int32
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		_, _ = w.Write([]byte("<html>gateway failure</html>"))
	}))
	defer upstream.Close()
	cfg := product.Load()
	cfg.DoubaoUpstream = upstream.URL
	s := New(cfg, "test", "invalid-json", false)
	defer s.doubaoClient.CloseIdleConnections()
	_, _, err := s.fetchSource(context.Background(), "doubao", "/api/v1/home/rooms", url.Values{}, true)
	if err == nil || calls.Load() != 2 {
		t.Fatalf("error=%v calls=%d", err, calls.Load())
	}
	if _, ok := s.stale("doubao|" + upstream.URL + "/api/v1/home/rooms"); ok {
		t.Fatal("HTML was cached as usable metadata")
	}
}

func TestStaleMetadataReturnsImmediatelyAndRefreshesOnlyOnce(t *testing.T) {
	var calls atomic.Int32
	started := make(chan struct{}, 4)
	release := make(chan struct{})
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		started <- struct{}{}
		select {
		case <-release:
			_, _ = w.Write([]byte(`{"new":true}`))
		case <-r.Context().Done():
		}
	}))
	defer upstream.Close()
	cfg := product.Load()
	cfg.DoubaoUpstream = upstream.URL
	s := New(cfg, "test", "background-refresh", false)
	defer s.doubaoClient.CloseIdleConnections()
	key := "doubao|" + upstream.URL + "/metadata"
	s.store(key, []byte(`{"old":true}`), -time.Second)
	start := time.Now()
	for i := 0; i < 10; i++ {
		body, stale, err := s.fetchSource(context.Background(), "doubao", "/metadata", url.Values{}, true)
		if err != nil || !stale || string(body) != `{"old":true}` {
			t.Fatalf("body=%s stale=%v error=%v", body, stale, err)
		}
	}
	if time.Since(start) > 200*time.Millisecond {
		t.Fatal("navigation waited for metadata refresh")
	}
	select {
	case <-started:
	case <-time.After(time.Second):
		t.Fatal("refresh did not start")
	}
	close(release)
	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		if body, ok := s.cached(key); ok && string(body) == `{"new":true}` {
			if calls.Load() != 1 {
				t.Fatalf("duplicate background refreshes: %d", calls.Load())
			}
			return
		}
		time.Sleep(time.Millisecond)
	}
	t.Fatal("successful refresh did not replace stale metadata")
}

func TestSingleSourceTimeoutReturnsUsefulError(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { <-r.Context().Done() }))
	defer upstream.Close()
	cfg := product.Load()
	cfg.DoubaoUpstream = upstream.URL
	s := New(cfg, "test", "timeout-message", false)
	s.feedTimeout = 40 * time.Millisecond
	defer s.doubaoClient.CloseIdleConnections()
	response := httptest.NewRecorder()
	s.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/api/v2/feed?view=replay&source=doubao", nil))
	var data map[string]interface{}
	if err := json.Unmarshal(response.Body.Bytes(), &data); err != nil {
		t.Fatal(err)
	}
	if response.Code != http.StatusGatewayTimeout || !strings.Contains(fmt.Sprint(data["message"]), "豆包直播连接超时") {
		t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
	}
}

func TestLiveCardsDoNotWaitForSlowOptionalMetadata(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/api/v1/home/schedules" {
			<-r.Context().Done()
			return
		}
		_, _ = w.Write([]byte(`{"success":true,"data":{"items":[{"id":9,"title":"甲 vs 乙","matchId":9,"status":1,"url":"/play/9-1-1"}],"total":1}}`))
	}))
	defer upstream.Close()
	cfg := product.Load()
	cfg.DoubaoUpstream = upstream.URL
	s := New(cfg, "test", "optional-metadata", false)
	defer s.doubaoClient.CloseIdleConnections()
	response := httptest.NewRecorder()
	start := time.Now()
	s.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/api/v2/feed?view=live&source=doubao", nil))
	if response.Code != http.StatusOK || !strings.Contains(response.Body.String(), `"match_id":"9"`) || time.Since(start) > time.Second {
		t.Fatalf("status=%d duration=%s body=%s", response.Code, time.Since(start), response.Body.String())
	}
}
