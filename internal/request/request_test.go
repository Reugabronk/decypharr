package request

import (
	"net/http"
	"testing"
	"time"
)

// TestWithResponseHeaderTimeout guards the slow-endpoint case: adding an
// uncached torrent makes the provider go find the swarm before it answers, and
// the 30s transport default turns that into a failure plus retried duplicate
// submissions.
func TestWithResponseHeaderTimeout(t *testing.T) {
	c := New(WithResponseHeaderTimeout(2 * time.Minute))
	tr, ok := c.httpClient.Transport.(*http.Transport)
	if !ok {
		t.Fatalf("transport = %T, want *http.Transport", c.httpClient.Transport)
	}
	if tr.ResponseHeaderTimeout != 2*time.Minute {
		t.Fatalf("ResponseHeaderTimeout = %v, want 2m", tr.ResponseHeaderTimeout)
	}
}

// TestDefaultResponseHeaderTimeout keeps the option from changing clients that
// don't ask for it.
func TestDefaultResponseHeaderTimeout(t *testing.T) {
	c := New()
	tr, ok := c.httpClient.Transport.(*http.Transport)
	if !ok {
		t.Fatalf("transport = %T, want *http.Transport", c.httpClient.Transport)
	}
	if tr.ResponseHeaderTimeout != 30*time.Second {
		t.Fatalf("ResponseHeaderTimeout = %v, want the 30s default", tr.ResponseHeaderTimeout)
	}
}
