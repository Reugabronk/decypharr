package sabnzbd

import "testing"

// TestBuildCategoriesDeduplicates guards the Arr's category dropdown: an Arr
// registered under the same name as a configured category used to be listed
// twice, and the second entry pointed at the same directory.
func TestBuildCategoriesDeduplicates(t *testing.T) {
	got := buildCategories([]string{"series", "movies"}, []string{"series", "", "books"}, "/downloads")

	var names []string
	for _, c := range got {
		names = append(names, c.Name)
	}
	want := []string{"series", "movies", "books"}
	if len(names) != len(want) {
		t.Fatalf("categories = %v, want %v", names, want)
	}
	for i := range want {
		if names[i] != want[i] {
			t.Fatalf("categories = %v, want %v", names, want)
		}
	}
	for i, c := range got {
		if c.Order != i+1 {
			t.Fatalf("category %q order = %d, want %d", c.Name, c.Order, i+1)
		}
	}
	if got[0].Dir != "/downloads/series" {
		t.Fatalf("dir = %q, want /downloads/series", got[0].Dir)
	}
}
