package bookmarksapi

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
)

func doRequest(t *testing.T, h http.Handler, method, path string, body any) *httptest.ResponseRecorder {
	t.Helper()
	var r *bytes.Reader
	if body != nil {
		b, err := json.Marshal(body)
		if err != nil {
			t.Fatalf("marshal body: %v", err)
		}
		r = bytes.NewReader(b)
	} else {
		r = bytes.NewReader(nil)
	}
	req := httptest.NewRequest(method, path, r)
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec
}

func decodeBookmark(t *testing.T, rec *httptest.ResponseRecorder) Bookmark {
	t.Helper()
	var b Bookmark
	if err := json.Unmarshal(rec.Body.Bytes(), &b); err != nil {
		t.Fatalf("decoding bookmark from %q: %v", rec.Body.String(), err)
	}
	return b
}

func decodeBookmarks(t *testing.T, rec *httptest.ResponseRecorder) []Bookmark {
	t.Helper()
	var bs []Bookmark
	if err := json.Unmarshal(rec.Body.Bytes(), &bs); err != nil {
		t.Fatalf("decoding bookmarks from %q: %v", rec.Body.String(), err)
	}
	return bs
}

func decodeError(t *testing.T, rec *httptest.ResponseRecorder) map[string]string {
	t.Helper()
	var m map[string]string
	if err := json.Unmarshal(rec.Body.Bytes(), &m); err != nil {
		t.Fatalf("decoding error from %q: %v", rec.Body.String(), err)
	}
	if _, ok := m["error"]; !ok {
		t.Fatalf("response %q has no \"error\" field", rec.Body.String())
	}
	return m
}

func TestCreateBookmark(t *testing.T) {
	s := NewServer()

	rec := doRequest(t, s, http.MethodPost, "/bookmarks", map[string]any{
		"url": "https://example.com", "title": "Example", "tags": []string{"a", "b"},
	})
	if rec.Code != http.StatusCreated {
		t.Fatalf("status = %d, want 201; body=%s", rec.Code, rec.Body.String())
	}
	b := decodeBookmark(t, rec)
	if b.ID != "1" || b.URL != "https://example.com" || b.Title != "Example" || b.Visits != 0 {
		t.Fatalf("unexpected bookmark: %+v", b)
	}
	if len(b.Tags) != 2 || b.Tags[0] != "a" || b.Tags[1] != "b" {
		t.Fatalf("unexpected tags: %+v", b.Tags)
	}

	// Second bookmark gets id "2", with defaults.
	rec = doRequest(t, s, http.MethodPost, "/bookmarks", map[string]any{"url": "https://second.example"})
	b2 := decodeBookmark(t, rec)
	if b2.ID != "2" {
		t.Fatalf("second bookmark id = %q, want %q", b2.ID, "2")
	}
	if b2.Title != "" {
		t.Fatalf("default title = %q, want \"\"", b2.Title)
	}
	if len(b2.Tags) != 0 {
		t.Fatalf("default tags = %+v, want []", b2.Tags)
	}
}

func TestCreateBookmarkValidation(t *testing.T) {
	s := NewServer()

	// Missing url.
	rec := doRequest(t, s, http.MethodPost, "/bookmarks", map[string]any{"title": "x"})
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("missing url: status = %d, want 400", rec.Code)
	}
	decodeError(t, rec)

	// Empty url.
	rec = doRequest(t, s, http.MethodPost, "/bookmarks", map[string]any{"url": ""})
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("empty url: status = %d, want 400", rec.Code)
	}

	// tags not an array of strings.
	rec = doRequest(t, s, http.MethodPost, "/bookmarks", map[string]any{"url": "https://x", "tags": "not-a-list"})
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("invalid tags: status = %d, want 400", rec.Code)
	}
	rec = doRequest(t, s, http.MethodPost, "/bookmarks", map[string]any{"url": "https://x", "tags": []any{"ok", 5}})
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("invalid tags element: status = %d, want 400", rec.Code)
	}

	// Invalid JSON.
	req := httptest.NewRequest(http.MethodPost, "/bookmarks", bytes.NewReader([]byte("{not json")))
	req.Header.Set("Content-Type", "application/json")
	rec = httptest.NewRecorder()
	s.ServeHTTP(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("invalid json: status = %d, want 400", rec.Code)
	}
}

func TestListBookmarksEmptyAndSorted(t *testing.T) {
	s := NewServer()

	rec := doRequest(t, s, http.MethodGet, "/bookmarks", nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	if got := rec.Body.String(); got != "[]" && got != "[]\n" {
		t.Fatalf("empty list body = %q, want []", got)
	}

	// Create 4 bookmarks, ids "1".."4".
	for i := 0; i < 4; i++ {
		doRequest(t, s, http.MethodPost, "/bookmarks", map[string]any{"url": "https://x"})
	}

	// Give id "2" and "3" two visits, "4" one visit, "1" zero visits.
	doRequest(t, s, http.MethodPost, "/bookmarks/2/visit", nil)
	doRequest(t, s, http.MethodPost, "/bookmarks/2/visit", nil)
	doRequest(t, s, http.MethodPost, "/bookmarks/3/visit", nil)
	doRequest(t, s, http.MethodPost, "/bookmarks/3/visit", nil)
	doRequest(t, s, http.MethodPost, "/bookmarks/4/visit", nil)

	rec = doRequest(t, s, http.MethodGet, "/bookmarks", nil)
	bs := decodeBookmarks(t, rec)
	if len(bs) != 4 {
		t.Fatalf("got %d bookmarks, want 4", len(bs))
	}
	// Expected order by (visits desc, id asc): (2,"2"), (2,"3"), (1,"4"), (0,"1")
	wantIDs := []string{"2", "3", "4", "1"}
	for i, b := range bs {
		if b.ID != wantIDs[i] {
			t.Fatalf("bookmarks[%d].ID = %q, want %q (full: %+v)", i, b.ID, wantIDs[i], bs)
		}
	}
}

func TestGetBookmark(t *testing.T) {
	s := NewServer()
	doRequest(t, s, http.MethodPost, "/bookmarks", map[string]any{"url": "https://only"})

	rec := doRequest(t, s, http.MethodGet, "/bookmarks/1", nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	b := decodeBookmark(t, rec)
	if b.URL != "https://only" {
		t.Fatalf("url = %q, want %q", b.URL, "https://only")
	}

	rec = doRequest(t, s, http.MethodGet, "/bookmarks/999", nil)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("status = %d, want 404", rec.Code)
	}
	decodeError(t, rec)
}

func TestVisitBookmark(t *testing.T) {
	s := NewServer()
	doRequest(t, s, http.MethodPost, "/bookmarks", map[string]any{"url": "https://x"})

	rec := doRequest(t, s, http.MethodPost, "/bookmarks/1/visit", nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body=%s", rec.Code, rec.Body.String())
	}
	b := decodeBookmark(t, rec)
	if b.Visits != 1 {
		t.Fatalf("visits = %d, want 1", b.Visits)
	}

	rec = doRequest(t, s, http.MethodPost, "/bookmarks/1/visit", nil)
	b = decodeBookmark(t, rec)
	if b.Visits != 2 {
		t.Fatalf("visits = %d, want 2", b.Visits)
	}

	// Not found.
	rec = doRequest(t, s, http.MethodPost, "/bookmarks/999/visit", nil)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("status = %d, want 404", rec.Code)
	}
	decodeError(t, rec)
}

func TestPatchBookmark(t *testing.T) {
	s := NewServer()
	doRequest(t, s, http.MethodPost, "/bookmarks", map[string]any{"url": "https://x", "title": "Original", "tags": []string{"a"}})

	rec := doRequest(t, s, http.MethodPatch, "/bookmarks/1", map[string]any{"title": "Updated"})
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body=%s", rec.Code, rec.Body.String())
	}
	b := decodeBookmark(t, rec)
	if b.Title != "Updated" || b.URL != "https://x" || len(b.Tags) != 1 || b.Tags[0] != "a" {
		t.Fatalf("unexpected bookmark after patch: %+v", b)
	}

	rec = doRequest(t, s, http.MethodPatch, "/bookmarks/1", map[string]any{"tags": []string{"x", "y"}})
	b = decodeBookmark(t, rec)
	if len(b.Tags) != 2 || b.Tags[0] != "x" || b.Tags[1] != "y" || b.Title != "Updated" {
		t.Fatalf("unexpected bookmark after second patch: %+v", b)
	}

	// Not found.
	rec = doRequest(t, s, http.MethodPatch, "/bookmarks/999", map[string]any{"title": "x"})
	if rec.Code != http.StatusNotFound {
		t.Fatalf("status = %d, want 404", rec.Code)
	}
	decodeError(t, rec)

	// Empty title.
	rec = doRequest(t, s, http.MethodPatch, "/bookmarks/1", map[string]any{"title": ""})
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", rec.Code)
	}

	// Invalid tags.
	rec = doRequest(t, s, http.MethodPatch, "/bookmarks/1", map[string]any{"tags": "nope"})
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", rec.Code)
	}
}

func TestDeleteBookmark(t *testing.T) {
	s := NewServer()
	doRequest(t, s, http.MethodPost, "/bookmarks", map[string]any{"url": "https://gone"})

	rec := doRequest(t, s, http.MethodDelete, "/bookmarks/1", nil)
	if rec.Code != http.StatusNoContent {
		t.Fatalf("status = %d, want 204", rec.Code)
	}

	rec = doRequest(t, s, http.MethodGet, "/bookmarks/1", nil)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("get after delete: status = %d, want 404", rec.Code)
	}

	rec = doRequest(t, s, http.MethodDelete, "/bookmarks/1", nil)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("double delete: status = %d, want 404", rec.Code)
	}
	decodeError(t, rec)
}

func TestUnknownRoutes(t *testing.T) {
	s := NewServer()

	rec := doRequest(t, s, http.MethodGet, "/unknown", nil)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("GET /unknown: status = %d, want 404", rec.Code)
	}
	decodeError(t, rec)

	rec = doRequest(t, s, http.MethodPut, "/bookmarks/1", nil)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("PUT /bookmarks/1: status = %d, want 404", rec.Code)
	}
}

func TestConcurrentVisits(t *testing.T) {
	s := NewServer()
	doRequest(t, s, http.MethodPost, "/bookmarks", map[string]any{"url": "https://hot"})

	const n = 50
	var wg sync.WaitGroup
	for i := 0; i < n; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			doRequest(t, s, http.MethodPost, "/bookmarks/1/visit", nil)
		}()
	}
	wg.Wait()

	rec := doRequest(t, s, http.MethodGet, "/bookmarks/1", nil)
	b := decodeBookmark(t, rec)
	if b.Visits != n {
		t.Fatalf("visits = %d, want %d (lost updates under concurrency)", b.Visits, n)
	}

	// Concurrent reads, visits, and patches.
	wg = sync.WaitGroup{}
	for i := 0; i < n; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			doRequest(t, s, http.MethodGet, "/bookmarks", nil)
			doRequest(t, s, http.MethodPost, "/bookmarks/1/visit", nil)
			doRequest(t, s, http.MethodPatch, "/bookmarks/1", map[string]any{"title": "hot"})
		}()
	}
	wg.Wait()

	rec = doRequest(t, s, http.MethodGet, "/bookmarks/1", nil)
	b = decodeBookmark(t, rec)
	if b.Visits != 2*n {
		t.Fatalf("visits = %d, want %d (lost updates under concurrency)", b.Visits, 2*n)
	}
}
