package server

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"log"
	"net"
	"net/http"
	"net/http/httptrace"
	"sync"
	"sync/atomic"
	"time"
)

const maxUpstreamBody = 4 << 20

// Each source owns its connection pool. If a request stalls, one independent
// connection may race it; a successful replacement becomes the reusable pool.
// This also covers a response body stalling after its headers have arrived.
type recoveringTransport struct {
	mu         sync.Mutex
	current    http.RoundTripper
	fresh      func() http.RoundTripper
	delay      time.Duration
	generation uint64
}

func newUpstreamClient() *http.Client {
	return &http.Client{Timeout: 6 * time.Second, Transport: &recoveringTransport{
		current: newUpstreamTransport(), fresh: func() http.RoundTripper { return newUpstreamTransport() },
		delay: 800 * time.Millisecond,
	}}
}

func newUpstreamTransport() *http.Transport {
	transport := http.DefaultTransport.(*http.Transport).Clone()
	transport.DialContext = (&net.Dialer{Timeout: 2 * time.Second, KeepAlive: 30 * time.Second}).DialContext
	transport.TLSHandshakeTimeout = 3 * time.Second
	transport.ResponseHeaderTimeout = 4 * time.Second
	transport.IdleConnTimeout = 30 * time.Second
	transport.MaxIdleConnsPerHost = 4

	return transport
}

type upstreamAttempt struct {
	response  *http.Response
	err       error
	transport http.RoundTripper
	recovery  bool
}

func (t *recoveringTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	if req.Method != http.MethodGet {
		return nil, errors.New("upstream recovery only supports GET")
	}
	t.mu.Lock()
	primary := t.current
	generation := t.generation
	t.mu.Unlock()
	ctx, cancel := context.WithCancel(req.Context())
	defer cancel()
	results := make(chan upstreamAttempt, 2)
	start := func(transport http.RoundTripper, recovery bool) {
		attemptCtx := ctx
		go func() {
			started := time.Now()
			var phase atomic.Int32
			attemptTrace := &httptrace.ClientTrace{
				ConnectStart:         func(_, _ string) { phase.Store(1) },
				TLSHandshakeStart:    func() { phase.Store(2) },
				WroteRequest:         func(httptrace.WroteRequestInfo) { phase.Store(3) },
				GotFirstResponseByte: func() { phase.Store(4) },
			}
			attemptCtx = httptrace.WithClientTrace(attemptCtx, attemptTrace)
			response, err := transport.RoundTrip(req.Clone(attemptCtx))
			if err == nil {
				body, readErr := io.ReadAll(io.LimitReader(response.Body, maxUpstreamBody+1))
				_ = response.Body.Close()
				if readErr == nil && len(body) > maxUpstreamBody {
					readErr = errors.New("upstream response too large")
				}
				if readErr == nil && response.StatusCode >= 200 && response.StatusCode < 300 && !json.Valid(body) {
					readErr = errors.New("invalid upstream JSON")
				}
				if readErr != nil {
					response, err = nil, readErr
				} else {
					response.Body = io.NopCloser(bytes.NewReader(body))
				}
			}
			if err != nil && !errors.Is(err, context.Canceled) {
				// Only log the host and stage, never query strings, response
				// bodies, cookies or resolved media URLs.
				stage := []string{"dns", "connect", "tls", "headers", "body"}[phase.Load()]
				log.Printf("upstream failure host=%s recovery=%v stage=%s elapsed_ms=%d", req.URL.Hostname(), recovery, stage, time.Since(started).Milliseconds())
			}
			results <- upstreamAttempt{response: response, err: err, transport: transport, recovery: recovery}
		}()
	}
	start(primary, false)
	timer := time.NewTimer(t.delay)
	defer timer.Stop()
	var replacement http.RoundTripper
	defer func() {
		if replacement != nil {
			closeIdle(replacement)
		}
	}()
	beginRecovery := func() {
		replacement = t.fresh()
		start(replacement, true)
	}
	pending := 1
	var last upstreamAttempt
	for {
		select {
		case result := <-results:
			pending--
			if result.err == nil && result.response.StatusCode < 500 {
				if result.recovery {
					t.mu.Lock()
					if t.generation == generation {
						t.current = result.transport
						t.generation++
						replacement = nil
					}
					t.mu.Unlock()
					closeIdle(primary)
				}
				return result.response, nil
			}
			last = result
			if replacement == nil && req.Context().Err() == nil {
				timer.Stop()
				beginRecovery()
				pending++
			}
			if pending == 0 {
				closeIdle(primary)
				return last.response, last.err
			}
		case <-timer.C:
			if replacement == nil && req.Context().Err() == nil {
				beginRecovery()
				pending++
			}
		case <-ctx.Done():
			closeIdle(primary)
			return nil, ctx.Err()
		}
	}
}

func closeIdle(transport http.RoundTripper) {
	if closer, ok := transport.(interface{ CloseIdleConnections() }); ok {
		closer.CloseIdleConnections()
	}
}

func (t *recoveringTransport) CloseIdleConnections() {
	t.mu.Lock()
	current := t.current
	t.mu.Unlock()
	closeIdle(current)
}
