package account

import (
	"testing"
	"time"

	"github.com/puzpuzpuz/xsync/v4"
	"github.com/sirrobot01/decypharr/pkg/debrid/types"
)

func newTestAccount() *Account {
	return &Account{
		Debrid: "torbox",
		Token:  "tok",
		links:  xsync.NewMap[string, types.DownloadLink](),
	}
}

// TestGetDownloadLinkRefetchesExpiredLink guards playback against providers
// that hand out short-lived signed URLs: a cached link past its ExpiresAt must
// never be served, or the read fails first and only then triggers a refetch.
func TestGetDownloadLinkRefetchesExpiredLink(t *testing.T) {
	a := newTestAccount()
	a.storeLink(types.DownloadLink{
		Link:         "https://torbox.app/file/1",
		DownloadLink: "https://cdn.torbox.app/stale",
		ExpiresAt:    time.Now().Add(-time.Minute),
	})

	fresh := types.DownloadLink{
		Link:         "https://torbox.app/file/1",
		DownloadLink: "https://cdn.torbox.app/fresh",
		ExpiresAt:    time.Now().Add(time.Hour),
	}
	calls := 0
	fetcher := func(_ *Account, _ string, _ *types.File) (types.DownloadLink, error) {
		calls++
		return fresh, nil
	}

	dl, err := a.GetDownloadLink("17", &types.File{Link: "https://torbox.app/file/1"}, fetcher)
	if err != nil {
		t.Fatalf("GetDownloadLink() error = %v", err)
	}
	if dl.DownloadLink != fresh.DownloadLink {
		t.Fatalf("DownloadLink = %q, want the refetched %q", dl.DownloadLink, fresh.DownloadLink)
	}
	if calls != 1 {
		t.Fatalf("fetcher calls = %d, want 1", calls)
	}

	// The refreshed link must have replaced the stale one in the cache.
	dl, err = a.GetDownloadLink("17", &types.File{Link: "https://torbox.app/file/1"}, fetcher)
	if err != nil {
		t.Fatalf("GetDownloadLink() error = %v", err)
	}
	if dl.DownloadLink != fresh.DownloadLink || calls != 1 {
		t.Fatalf("second call = %q after %d fetches, want the cached fresh link after 1", dl.DownloadLink, calls)
	}
}

// TestGetDownloadLinkKeepsLiveLink keeps the expiry check from turning every
// lookup into an API call.
func TestGetDownloadLinkKeepsLiveLink(t *testing.T) {
	a := newTestAccount()
	cached := types.DownloadLink{
		Link:         "https://torbox.app/file/1",
		DownloadLink: "https://cdn.torbox.app/live",
		ExpiresAt:    time.Now().Add(time.Hour),
	}
	a.storeLink(cached)

	fetcher := func(_ *Account, _ string, _ *types.File) (types.DownloadLink, error) {
		t.Fatal("fetcher called for a link that has not expired")
		return types.DownloadLink{}, nil
	}

	dl, err := a.GetDownloadLink("17", &types.File{Link: "https://torbox.app/file/1"}, fetcher)
	if err != nil {
		t.Fatalf("GetDownloadLink() error = %v", err)
	}
	if dl.DownloadLink != cached.DownloadLink {
		t.Fatalf("DownloadLink = %q, want the cached %q", dl.DownloadLink, cached.DownloadLink)
	}
}
