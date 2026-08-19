package notesapi

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

func decodeNote(t *testing.T, rec *httptest.ResponseRecorder) Note {
	t.Helper()
	var n Note
	if err := json.Unmarshal(rec.Body.Bytes(), &n); err != nil {
		t.Fatalf("decoding note from %q: %v", rec.Body.String(), err)
	}
	return n
}

func decodeNotes(t *testing.T, rec *httptest.ResponseRecorder) []Note {
	t.Helper()
	var ns []Note
	if err := json.Unmarshal(rec.Body.Bytes(), &ns); err != nil {
		t.Fatalf("decoding notes from %q: %v", rec.Body.String(), err)
	}
	return ns
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

func TestCreateNote(t *testing.T) {
	s := NewServer()

	rec := doRequest(t, s, http.MethodPost, "/notes", map[string]any{
		"title": "Buy milk", "body": "2%", "priority": 2,
	})
	if rec.Code != http.StatusCreated {
		t.Fatalf("status = %d, want 201; body=%s", rec.Code, rec.Body.String())
	}
	n := decodeNote(t, rec)
	if n.ID != "1" || n.Title != "Buy milk" || n.Body != "2%" || n.Priority != 2 || n.Done {
		t.Fatalf("unexpected note: %+v", n)
	}

	// Second note gets id "2".
	rec = doRequest(t, s, http.MethodPost, "/notes", map[string]any{"title": "Second"})
	n2 := decodeNote(t, rec)
	if n2.ID != "2" {
		t.Fatalf("second note id = %q, want %q", n2.ID, "2")
	}
	if n2.Priority != 3 {
		t.Fatalf("default priority = %d, want 3", n2.Priority)
	}
	if n2.Body != "" {
		t.Fatalf("default body = %q, want \"\"", n2.Body)
	}
}

func TestCreateNoteValidation(t *testing.T) {
	s := NewServer()

	// Missing title.
	rec := doRequest(t, s, http.MethodPost, "/notes", map[string]any{"body": "x"})
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("missing title: status = %d, want 400", rec.Code)
	}
	decodeError(t, rec)

	// Empty title.
	rec = doRequest(t, s, http.MethodPost, "/notes", map[string]any{"title": ""})
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("empty title: status = %d, want 400", rec.Code)
	}

	// Priority out of range.
	rec = doRequest(t, s, http.MethodPost, "/notes", map[string]any{"title": "x", "priority": 6})
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("priority 6: status = %d, want 400", rec.Code)
	}
	rec = doRequest(t, s, http.MethodPost, "/notes", map[string]any{"title": "x", "priority": 0})
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("priority 0: status = %d, want 400", rec.Code)
	}

	// Invalid JSON.
	req := httptest.NewRequest(http.MethodPost, "/notes", bytes.NewReader([]byte("{not json")))
	req.Header.Set("Content-Type", "application/json")
	rec = httptest.NewRecorder()
	s.ServeHTTP(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("invalid json: status = %d, want 400", rec.Code)
	}
}

func TestListNotesEmptyAndSorted(t *testing.T) {
	s := NewServer()

	rec := doRequest(t, s, http.MethodGet, "/notes", nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	if got := rec.Body.String(); got != "[]" && got != "[]\n" {
		t.Fatalf("empty list body = %q, want []", got)
	}

	// Create notes with priorities 3, 1, 1, 5.
	for _, p := range []int{3, 1, 1, 5} {
		doRequest(t, s, http.MethodPost, "/notes", map[string]any{"title": "n", "priority": p})
	}

	rec = doRequest(t, s, http.MethodGet, "/notes", nil)
	notes := decodeNotes(t, rec)
	if len(notes) != 4 {
		t.Fatalf("got %d notes, want 4", len(notes))
	}
	// Expected order by (priority, id): (1,"2"), (1,"3"), (3,"1"), (5,"4")
	wantIDs := []string{"2", "3", "1", "4"}
	for i, n := range notes {
		if n.ID != wantIDs[i] {
			t.Fatalf("notes[%d].ID = %q, want %q (full: %+v)", i, n.ID, wantIDs[i], notes)
		}
	}
}

func TestGetNote(t *testing.T) {
	s := NewServer()
	doRequest(t, s, http.MethodPost, "/notes", map[string]any{"title": "Only"})

	rec := doRequest(t, s, http.MethodGet, "/notes/1", nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	n := decodeNote(t, rec)
	if n.Title != "Only" {
		t.Fatalf("title = %q, want %q", n.Title, "Only")
	}

	rec = doRequest(t, s, http.MethodGet, "/notes/999", nil)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("status = %d, want 404", rec.Code)
	}
	decodeError(t, rec)
}

func TestPatchNote(t *testing.T) {
	s := NewServer()
	doRequest(t, s, http.MethodPost, "/notes", map[string]any{"title": "Original", "body": "b", "priority": 3})

	rec := doRequest(t, s, http.MethodPatch, "/notes/1", map[string]any{"done": true})
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body=%s", rec.Code, rec.Body.String())
	}
	n := decodeNote(t, rec)
	if !n.Done || n.Title != "Original" || n.Body != "b" || n.Priority != 3 {
		t.Fatalf("unexpected note after patch: %+v", n)
	}

	rec = doRequest(t, s, http.MethodPatch, "/notes/1", map[string]any{"title": "Updated", "priority": 1})
	n = decodeNote(t, rec)
	if n.Title != "Updated" || n.Priority != 1 || !n.Done {
		t.Fatalf("unexpected note after second patch: %+v", n)
	}

	// Not found.
	rec = doRequest(t, s, http.MethodPatch, "/notes/999", map[string]any{"done": true})
	if rec.Code != http.StatusNotFound {
		t.Fatalf("status = %d, want 404", rec.Code)
	}
	decodeError(t, rec)

	// Invalid priority.
	rec = doRequest(t, s, http.MethodPatch, "/notes/1", map[string]any{"priority": 99})
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", rec.Code)
	}

	// Empty title.
	rec = doRequest(t, s, http.MethodPatch, "/notes/1", map[string]any{"title": ""})
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", rec.Code)
	}
}

func TestDeleteNote(t *testing.T) {
	s := NewServer()
	doRequest(t, s, http.MethodPost, "/notes", map[string]any{"title": "Gone"})

	rec := doRequest(t, s, http.MethodDelete, "/notes/1", nil)
	if rec.Code != http.StatusNoContent {
		t.Fatalf("status = %d, want 204", rec.Code)
	}

	rec = doRequest(t, s, http.MethodGet, "/notes/1", nil)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("get after delete: status = %d, want 404", rec.Code)
	}

	rec = doRequest(t, s, http.MethodDelete, "/notes/1", nil)
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

	rec = doRequest(t, s, http.MethodPut, "/notes/1", nil)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("PUT /notes/1: status = %d, want 404", rec.Code)
	}
}

func TestConcurrentAccess(t *testing.T) {
	s := NewServer()

	var wg sync.WaitGroup
	for i := 0; i < 20; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			doRequest(t, s, http.MethodPost, "/notes", map[string]any{"title": "concurrent"})
		}(i)
	}
	wg.Wait()

	rec := doRequest(t, s, http.MethodGet, "/notes", nil)
	notes := decodeNotes(t, rec)
	if len(notes) != 20 {
		t.Fatalf("got %d notes, want 20", len(notes))
	}

	seen := map[string]bool{}
	for _, n := range notes {
		if seen[n.ID] {
			t.Fatalf("duplicate id %q", n.ID)
		}
		seen[n.ID] = true
	}

	// Concurrent reads and writes against existing notes.
	wg = sync.WaitGroup{}
	for i := 0; i < 20; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			doRequest(t, s, http.MethodGet, "/notes", nil)
			doRequest(t, s, http.MethodPatch, "/notes/1", map[string]any{"done": true})
		}(i)
	}
	wg.Wait()
}
