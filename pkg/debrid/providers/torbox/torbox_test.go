package torbox

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"slices"
	"strings"
	"sync"
	"sync/atomic"
	"testing"

	"github.com/rs/zerolog"
	"github.com/sirrobot01/decypharr/internal/config"
	"github.com/sirrobot01/decypharr/internal/request"
	"github.com/sirrobot01/decypharr/pkg/debrid/account"
	"github.com/sirrobot01/decypharr/pkg/debrid/types"
)

func TestGetTorrentsBypassesTorboxCache(t *testing.T) {
	config.SetConfigPath(t.TempDir())

	var (
		mu      sync.Mutex
		offsets []string
	)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if got := r.URL.Query().Get("bypass_cache"); got != "true" {
			t.Errorf("bypass_cache = %q, want true", got)
		}

		offset := r.URL.Query().Get("offset")
		mu.Lock()
		offsets = append(offsets, offset)
		mu.Unlock()

		w.Header().Set("Content-Type", "application/json")
		if offset == "0" {
			_, _ = fmt.Fprint(w, `{"success":true,"data":[{"id":17,"name":"Release.mkv","size":100,"progress":1,"download_state":"completed","download_finished":true,"created_at":"2026-01-02T03:04:05Z","hash":"ABC","files":[{"id":1,"name":"Release.mkv","absolute_path":"Release.mkv","size":100}]}]}`)
			return
		}
		_, _ = fmt.Fprint(w, `{"success":true,"data":[]}`)
	}))
	t.Cleanup(server.Close)

	tb := testTorbox(server.URL)
	torrents, err := tb.GetTorrents()
	if err != nil {
		t.Fatalf("GetTorrents() error = %v", err)
	}
	if len(torrents) != 1 || torrents[0].Id != "17" {
		t.Fatalf("GetTorrents() = %#v, want torrent 17", torrents)
	}

	mu.Lock()
	defer mu.Unlock()
	if !slices.Equal(offsets, []string{"0", "1"}) {
		t.Fatalf("offsets = %v, want [0 1]", offsets)
	}
}

func TestGetTorrentsReturnsPaginationErrors(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Query().Get("offset") == "0" {
			w.Header().Set("Content-Type", "application/json")
			_, _ = fmt.Fprint(w, `{"success":true,"data":[{"id":17,"name":"Release.mkv","created_at":"2026-01-02T03:04:05Z"}]}`)
			return
		}
		http.Error(w, "temporary failure", http.StatusInternalServerError)
	}))
	t.Cleanup(server.Close)

	tb := testTorbox(server.URL)
	torrents, err := tb.GetTorrents()
	if err == nil {
		t.Fatal("GetTorrents() error = nil, want pagination error")
	}
	if torrents != nil {
		t.Fatalf("GetTorrents() torrents = %#v, want nil after pagination error", torrents)
	}
	if got := err.Error(); !strings.Contains(got, "get TorBox torrents at offset 1:") {
		t.Fatalf("GetTorrents() error = %q, want offset context", got)
	}
}

// TestFetchDownloadLinkResolvesCDNURL guards the fix for the 429 storms that
// come from handing the streaming layer TorBox's requestdl endpoint: that
// endpoint counts against the 300 req/min API cap and the streaming layer
// requests a URL per range read, so the link must carry the resolved CDN URL
// instead.
func TestFetchDownloadLinkResolvesCDNURL(t *testing.T) {
	config.SetConfigPath(t.TempDir())

	var calls atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		if got := r.URL.Query().Get("redirect"); got != "" {
			t.Errorf("redirect = %q, want it unset so the API returns the URL in the body", got)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = fmt.Fprint(w, `{"success":true,"data":"https://cdn.torbox.app/dl/abc/Release.mkv"}`)
	}))
	t.Cleanup(server.Close)

	tb := testTorbox(server.URL)
	dl, err := tb.fetchDownloadLink(&account.Account{Token: "tok"}, "17", &types.File{Id: "1", Name: "Release.mkv", Size: 100})
	if err != nil {
		t.Fatalf("fetchDownloadLink() error = %v", err)
	}
	if want := "https://cdn.torbox.app/dl/abc/Release.mkv"; dl.DownloadLink != want {
		t.Fatalf("DownloadLink = %q, want the resolved CDN URL %q", dl.DownloadLink, want)
	}
	if got := calls.Load(); got != 1 {
		t.Fatalf("requestdl calls = %d, want 1", got)
	}
}

// TestFetchDownloadLinkFallsBackToRedirectURL keeps a transient API failure
// from breaking playback outright: the rate-limited redirect URL is worse than
// a CDN URL but better than no link at all.
func TestFetchDownloadLinkFallsBackToRedirectURL(t *testing.T) {
	config.SetConfigPath(t.TempDir())

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "temporary failure", http.StatusInternalServerError)
	}))
	t.Cleanup(server.Close)

	tb := testTorbox(server.URL)
	dl, err := tb.fetchDownloadLink(&account.Account{Token: "tok"}, "17", &types.File{Id: "1", Name: "Release.mkv", Size: 100})
	if err != nil {
		t.Fatalf("fetchDownloadLink() error = %v", err)
	}
	if !strings.Contains(dl.DownloadLink, "/api/torrents/requestdl?") || !strings.Contains(dl.DownloadLink, "redirect=true") {
		t.Fatalf("DownloadLink = %q, want the requestdl redirect URL", dl.DownloadLink)
	}
}

func testTorbox(host string) *Torbox {
	return &Torbox{
		Host:   host,
		client: request.New(request.WithMaxRetries(0)),
		logger: zerolog.Nop(),
		config: config.Debrid{Name: "torbox"},
	}
}
