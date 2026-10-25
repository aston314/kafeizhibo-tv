package server

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"net/url"
	"sync/atomic"
	"testing"
	"time"

	product "cc.kafeizhibo.tv"
)

func TestSwitchingSourceKeepsBoundedMetadataFetchAndReusesResult(t *testing.T) {
	var calls atomic.Int32
	started, release, canceled := make(chan struct{}, 2), make(chan struct{}), make(chan struct{}, 2)
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		started <- struct{}{}
		select {
		case <-release:
			_, _ = w.Write([]byte(`{"items":[1]}`))
		case <-r.Context().Done():
			canceled <- struct{}{}
		}
	}))
	defer upstream.Close()
	cfg := product.Load()
	cfg.DoubaoUpstream = upstream.URL
	s := New(cfg, "test", "metadata-handoff", false)
	defer s.doubaoClient.CloseIdleConnections()
	ctx, cancel := context.WithCancel(context.Background())
	first := make(chan error, 1)
	go func() {
		_, _, err := s.fetchSource(ctx, "doubao", "/list", url.Values{"category": {"1"}}, true)
		first <- err
	}()
	<-started
	key := "doubao|" + upstream.URL + "/list?category=1"
	s.mu.RLock()
	original := s.metadataFlights[key]
	s.mu.RUnlock()
	if original == nil || s.startMetadata(key, "doubao", "/list", url.Values{"category": {"1"}}) != original {
		t.Fatal("concurrent navigation did not join the existing metadata fetch")
	}
	cancel()
	select {
	case err := <-first:
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("old navigation error=%v", err)
		}
	case <-time.After(time.Second):
		t.Fatal("switching away did not cancel its wait")
	}
	// Switching back joins the existing fetch. Its successful response should
	// also be cached even though the first navigation has already gone away.
	second := make(chan []byte, 1)
	go func() {
		body, _, _ := s.fetchSource(context.Background(), "doubao", "/list", url.Values{"category": {"1"}}, true)
		second <- body
	}()
	close(release)
	select {
	case body := <-second:
		if string(body) != `{"items":[1]}` {
			t.Fatalf("body=%s", body)
		}
	case <-time.After(time.Second):
		t.Fatal("new navigation never received metadata")
	}
	if calls.Load() != 1 {
		t.Fatalf("same metadata fetched %d times", calls.Load())
	}
	select {
	case <-canceled:
		t.Fatal("old navigation canceled the shared fetch")
	default:
	}
	body, stale, err := s.fetchSource(context.Background(), "doubao", "/list", url.Values{"category": {"1"}}, true)
	if err != nil || stale || string(body) != `{"items":[1]}` || calls.Load() != 1 {
		t.Fatalf("cache body=%s stale=%v error=%v calls=%d", body, stale, err, calls.Load())
	}
}

func TestMetadataHandoffDoesNotMergeSourcesOrFilters(t *testing.T) {
	var calls atomic.Int32
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { calls.Add(1); _, _ = w.Write([]byte(`{"ok":true}`)) }))
	defer upstream.Close()
	cfg := product.Load()
	cfg.Upstream, cfg.DoubaoUpstream = upstream.URL, upstream.URL
	s := New(cfg, "test", "metadata-keys", false)
	defer s.client.CloseIdleConnections()
	defer s.doubaoClient.CloseIdleConnections()
	for _, source := range []string{"doubao", "kafei"} {
		for _, category := range []string{"1", "2"} {
			for i := 0; i < 2; i++ {
				if _, _, err := s.fetchSource(context.Background(), source, "/list", url.Values{"category": {category}}, true); err != nil {
					t.Fatal(err)
				}
			}
		}
	}
	if calls.Load() != 4 {
		t.Fatalf("source/filter cache collision: calls=%d", calls.Load())
	}
}

func TestAbandonedMetadataFetchStillHasDeadlineAndIsRemoved(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { <-r.Context().Done() }))
	defer upstream.Close()
	cfg := product.Load()
	cfg.DoubaoUpstream = upstream.URL
	s := New(cfg, "test", "metadata-deadline", false)
	s.feedTimeout = 40 * time.Millisecond
	defer s.doubaoClient.CloseIdleConnections()
	key := "doubao|" + upstream.URL + "/list"
	flight := s.startMetadata(key, "doubao", "/list", url.Values{})
	select {
	case <-flight.done:
		if !errors.Is(flight.err, context.DeadlineExceeded) {
			t.Fatalf("error=%v", flight.err)
		}
	case <-time.After(time.Second):
		t.Fatal("abandoned metadata fetch was not bounded")
	}
	s.mu.RLock()
	remaining := len(s.metadataFlights)
	s.mu.RUnlock()
	if remaining != 0 {
		t.Fatalf("expired fetch remains in flight: %d", remaining)
	}
}

func TestPlaybackRequestsRemainOwnedByTheirNavigation(t *testing.T) {
	started, canceled := make(chan struct{}), make(chan struct{})
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { close(started); <-r.Context().Done(); close(canceled) }))
	defer upstream.Close()
	cfg := product.Load()
	cfg.DoubaoUpstream = upstream.URL
	s := New(cfg, "test", "playback-cancel", false)
	defer s.doubaoClient.CloseIdleConnections()
	ctx, cancel := context.WithCancel(context.Background())
	result := make(chan error, 1)
	go func() { _, _, err := s.fetchSource(ctx, "doubao", "/play", url.Values{}, false); result <- err }()
	<-started
	cancel()
	select {
	case err := <-result:
		if !errors.Is(err, context.Canceled) {
			t.Fatal(err)
		}
	case <-time.After(time.Second):
		t.Fatal("playback wait not canceled")
	}
	select {
	case <-canceled:
	case <-time.After(time.Second):
		t.Fatal("playback fetch continued after cancellation")
	}
}

func TestMetadataFlightLimitDoesNotBlockAnotherSource(t *testing.T) {
	release := make(chan struct{})
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/slow" {
			select {
			case <-release:
			case <-r.Context().Done():
				return
			}
		}
		_, _ = w.Write([]byte(`{"ok":true}`))
	}))
	defer upstream.Close()
	defer close(release)
	cfg := product.Load()
	cfg.Upstream, cfg.DoubaoUpstream = upstream.URL, upstream.URL
	s := New(cfg, "test", "metadata-capacity", false)
	defer s.client.CloseIdleConnections()
	defer s.doubaoClient.CloseIdleConnections()
	for i := 0; i < 8; i++ {
		query := url.Values{"page": {string(rune('1' + i))}}
		key := "doubao|" + upstream.URL + "/slow?" + query.Encode()
		s.startMetadata(key, "doubao", "/slow", query)
	}
	_, _, err := s.fetchSource(context.Background(), "doubao", "/slow", url.Values{"page": {"9"}}, true)
	if err == nil {
		t.Fatal("unbounded background metadata requests")
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	body, _, err := s.fetchSource(ctx, "kafei", "/fast", url.Values{}, true)
	if err != nil || string(body) != `{"ok":true}` {
		t.Fatalf("another source was blocked: body=%s error=%v", body, err)
	}
}
