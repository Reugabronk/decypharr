package link

import (
	"context"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"

	"github.com/puzpuzpuz/xsync/v4"
	"github.com/rs/zerolog"
	debrid "github.com/sirrobot01/decypharr/pkg/debrid/common"
	"github.com/sirrobot01/decypharr/pkg/debrid/types"
	"github.com/sirrobot01/decypharr/pkg/storage"
)

// fakeClient implements debrid.Client, delegating everything but
// GetDownloadLink/DeleteLink to the embedded nil interface (unused by this test).
type fakeClient struct {
	debrid.Client
	link types.DownloadLink
}

func (c *fakeClient) GetDownloadLink(string, *types.File) (types.DownloadLink, error) {
	return c.link, nil
}

func (c *fakeClient) DeleteLink(types.DownloadLink) error { return nil }

func newTestEntry(filename, downloadLink string) (*storage.Entry, types.DownloadLink) {
	entry := &storage.Entry{
		InfoHash:       "hash1",
		ActiveProvider: "torbox",
		Files: map[string]*storage.File{
			filename: {Name: filename, Size: 100},
		},
		Providers: map[string]*storage.ProviderEntry{
			"torbox": {
				Provider: "torbox",
				Files: map[string]*storage.ProviderFile{
					filename: {Id: "1", Link: "torbox://1/1"},
				},
			},
		},
	}
	dl := types.DownloadLink{
		Debrid:       "torbox",
		Filename:     filename,
		DownloadLink: downloadLink,
	}
	return entry, dl
}

// TestGetLink_TransientGatewayErrorNotCachedPermanently guards against a
// transient CDN/gateway error (e.g. HTTP 502 from an edge node, seen right
// after a debrid provider marks a batch of torrents "downloaded" before their
// links are fully live) being memoized in s.validated forever. The provider
// sends no X-Error header for this, so validateLink falls back to the raw
// HTTP status; ErrorCodeToLinkError used to classify any status other than
// exactly 503 as CategoryPermanent via its default case, which then got
// cached in s.validated and never re-checked — every later read for that file
// (including an Arr's ffprobe) failed instantly until Decypharr was
// restarted, which is the only thing that clears the in-memory cache.
func TestGetLink_TransientGatewayErrorNotCachedPermanently(t *testing.T) {
	var hits atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits.Add(1)
		w.WriteHeader(http.StatusBadGateway) // 502, no X-Error header
	}))
	defer srv.Close()

	entry, dl := newTestEntry("movie.mkv", srv.URL)
	fc := &fakeClient{link: dl}

	clients := xsync.NewMap[string, debrid.Client]()
	clients.Store("torbox", fc)

	svc := New(clients, nil, nil, nil, srv.Client(), 3, zerolog.Nop())

	if _, err := svc.GetLink(context.Background(), entry, "movie.mkv"); err != nil {
		linkErr := GetLinkError(err)
		if linkErr != nil && linkErr.IsPermanent() {
			t.Fatalf("a transient 502 must not be classified permanent, got %v", err)
		}
	}

	// A second call must hit the server again instead of short-circuiting on
	// a permanently cached failure from the first call.
	if _, err := svc.GetLink(context.Background(), entry, "movie.mkv"); err != nil {
		linkErr := GetLinkError(err)
		if linkErr != nil && linkErr.IsPermanent() {
			t.Fatalf("a transient 502 must not be classified permanent, got %v", err)
		}
	}

	if got := hits.Load(); got != 2 {
		t.Fatalf("expected the validation endpoint to be hit on both calls (no permanent caching of a transient 502), got %d hits", got)
	}
}
