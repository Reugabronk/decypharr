package request

import (
	"net/http"
	"testing"
	"time"

	"github.com/sirrobot01/decypharr/internal/config"
)

// TestWithResponseHeaderTimeout guards the slow-endpoint case: adding an
// uncached torrent makes the provider go find the swarm before it answers, and
// the 30s transport default turns that into a failure plus retried duplicate
// submissions.
func TestWithResponseHeaderTimeout(t *testing.T) {
	config.SetConfigPath(t.TempDir())

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
	config.SetConfigPath(t.TempDir())

	c := New()
	tr, ok := c.httpClient.Transport.(*http.Transport)
	if !ok {
		t.Fatalf("transport = %T, want *http.Transport", c.httpClient.Transport)
	}
	if tr.ResponseHeaderTimeout != 30*time.Second {
		t.Fatalf("ResponseHeaderTimeout = %v, want the 30s default", tr.ResponseHeaderTimeout)
	}
}

// TestTimeoutClearsResponseHeaderTimeout catches the mistake of raising the
// header timeout alone: the client's overall deadline cuts the request off
// first, so the longer header timeout never takes effect.
func TestTimeoutClearsResponseHeaderTimeout(t *testing.T) {
	config.SetConfigPath(t.TempDir())

	c := New(WithResponseHeaderTimeout(2*time.Minute), WithTimeout(3*time.Minute))
	tr := c.httpClient.Transport.(*http.Transport)
	if c.httpClient.Timeout <= tr.ResponseHeaderTimeout {
		t.Fatalf("client timeout %v does not clear response header timeout %v",
			c.httpClient.Timeout, tr.ResponseHeaderTimeout)
	}
}
