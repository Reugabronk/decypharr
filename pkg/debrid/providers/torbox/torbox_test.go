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
	"time"

	"github.com/rs/zerolog"
	"github.com/sirrobot01/decypharr/internal/config"
	"github.com/sirrobot01/decypharr/internal/request"
	"github.com/sirrobot01/decypharr/internal/utils"
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
	// TorBox retires the signed CDN URL long before auto_expire_links_after, so
	// the cached link has to carry the shorter deadline or playback breaks on a
	// URL the account cache still considers good.
	if until := time.Until(dl.ExpiresAt); until <= 0 || until > cdnLinkTTL {
		t.Fatalf("ExpiresAt in %v, want a positive TTL of at most %v", until, cdnLinkTTL)
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
		Host:                  host,
		client:                request.New(request.WithMaxRetries(0)),
		logger:                zerolog.Nop(),
		config:                config.Debrid{Name: "torbox"},
		autoExpiresLinksAfter: 48 * time.Hour,
	}
}

// TestSubmitMagnetSurfacesAPIError keeps the opaque "Status: 400" out of the
// Arr logs: the usual cause is an uncached release rejected because
// add_only_if_cached is set, and TorBox says so in the response body.
func TestSubmitMagnetSurfacesAPIError(t *testing.T) {
	config.SetConfigPath(t.TempDir())

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusBadRequest)
		_, _ = fmt.Fprint(w, `{"success":false,"error":"DOWNLOAD_SERVER_ERROR","detail":"Torrent is not cached."}`)
	}))
	t.Cleanup(server.Close)

	tb := testTorbox(server.URL)
	_, err := tb.SubmitMagnet(&types.Torrent{Magnet: &utils.Magnet{Link: "magnet:?xt=urn:btih:abc"}})
	if err == nil {
		t.Fatal("SubmitMagnet() error = nil, want the API error")
	}
	got := err.Error()
	for _, want := range []string{"400", "DOWNLOAD_SERVER_ERROR", "Torrent is not cached."} {
		if !strings.Contains(got, want) {
			t.Fatalf("SubmitMagnet() error = %q, want it to mention %q", got, want)
		}
	}
}

// TestCheckStatusReportsTorboxState keeps a failed torrent from being reported
// as a bare "has error": the provider's own state is what tells the user what
// actually went wrong.
func TestCheckStatusReportsTorboxState(t *testing.T) {
	config.SetConfigPath(t.TempDir())

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = fmt.Fprint(w, `{"success":true,"data":{"id":17,"name":"Release.mkv","size":100,"progress":0,"download_state":"missingFiles","seeds":0,"created_at":"2026-01-02T03:04:05Z","hash":"ABC","files":[]}}`)
	}))
	t.Cleanup(server.Close)

	tb := testTorbox(server.URL)
	_, err := tb.CheckStatus(&types.Torrent{Id: "17", Name: "Release.mkv"})
	if err == nil {
		t.Fatal("CheckStatus() error = nil, want the error state")
	}
	for _, want := range []string{"missingFiles", "seeders: 0"} {
		if !strings.Contains(err.Error(), want) {
			t.Fatalf("CheckStatus() error = %q, want it to mention %q", err.Error(), want)
		}
	}
}

// TestGetTorboxStatusStalled covers the state a nearly-complete torrent sits
// in while it waits for a seeder: stalled is a wait, not a failure, and
// calling it an error retired grabs that were at 99%.
func TestGetTorboxStatusStalled(t *testing.T) {
	tb := &Torbox{}
	tests := []struct {
		state string
		want  types.TorrentStatus
	}{
		{"stalled (no seeds)", types.TorrentStatusDownloading},
		{"stalledDL", types.TorrentStatusDownloading},
		{"stalledUP", types.TorrentStatusDownloaded},
		{"downloading", types.TorrentStatusDownloading},
		{"cached", types.TorrentStatusDownloaded},
		{"some_unknown_state", types.TorrentStatusError},
	}
	for _, tt := range tests {
		t.Run(tt.state, func(t *testing.T) {
			if got := tb.getTorboxStatus(tt.state, false); got != tt.want {
				t.Fatalf("getTorboxStatus(%q) = %v, want %v", tt.state, got, tt.want)
			}
		})
	}
}
