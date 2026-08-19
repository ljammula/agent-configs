package notesapi

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"reflect"
	"sort"
	"strings"
	"sync"
	"testing"
)

func doReq(t *testing.T, s http.Handler, method, path, body string) *httptest.ResponseRecorder {
	t.Helper()
	var reader io.Reader
	if body != "" {
		reader = strings.NewReader(body)
	}
	req := httptest.NewRequest(method, path, reader)
	rec := httptest.NewRecorder()
	s.ServeHTTP(rec, req)
	return rec
}

func TestSmoke(t *testing.T) {
	s := NewServer()

	// Empty list returns [] not null.
	rec := doReq(t, s, "GET", "/notes", "")
	if rec.Code != 200 || !bytes.Equal(bytes.TrimSpace(rec.Body.Bytes()), []byte("[]")) {
		t.Fatalf("empty list: got %d %q", rec.Code, rec.Body.String())
	}

	// Create with defaults.
	rec = doReq(t, s, "POST", "/notes", `{"title":"a"}`)
	if rec.Code != 201 {
		t.Fatalf("create: got %d %q", rec.Code, rec.Body.String())
	}
	var n1 Note
	if err := json.Unmarshal(rec.Body.Bytes(), &n1); err != nil {
		t.Fatal(err)
	}
	want1 := Note{ID: "1", Title: "a", Body: "", Priority: 3, Done: false}
	if n1 != want1 {
		t.Fatalf("n1 = %+v, want %+v", n1, want1)
	}

	// Create with priority 1.
	rec = doReq(t, s, "POST", "/notes", `{"title":"b","body":"bb","priority":1}`)
	if rec.Code != 201 {
		t.Fatalf("create2: got %d %q", rec.Code, rec.Body.String())
	}

	// Create with priority 5.
	rec = doReq(t, s, "POST", "/notes", `{"title":"c","priority":5}`)
	if rec.Code != 201 {
		t.Fatalf("create3: got %d %q", rec.Code, rec.Body.String())
	}

	// Invalid inputs.
	for _, body := range []string{`{`, `{"title":""}`, `{"title":"x","priority":0}`, `{"title":"x","priority":6}`, `{"title":"x","priority":2.5}`, `{"title":5}`} {
		rec = doReq(t, s, "POST", "/notes", body)
		if rec.Code != 400 {
			t.Fatalf("POST %q: got %d, want 400", body, rec.Code)
		}
		var errResp map[string]string
		if err := json.Unmarshal(rec.Body.Bytes(), &errResp); err != nil || errResp["error"] == "" {
			t.Fatalf("POST %q: bad error body %q", body, rec.Body.String())
		}
	}

	// List ordering: priority asc, then id asc.
	rec = doReq(t, s, "GET", "/notes", "")
	var list []Note
	if err := json.Unmarshal(rec.Body.Bytes(), &list); err != nil {
		t.Fatal(err)
	}
	wantIDs := []string{"2", "1", "3"}
	var gotIDs []string
	for _, n := range list {
		gotIDs = append(gotIDs, n.ID)
	}
	if !reflect.DeepEqual(gotIDs, wantIDs) {
		t.Fatalf("list order = %v, want %v", gotIDs, wantIDs)
	}

	// Get existing / missing.
	rec = doReq(t, s, "GET", "/notes/2", "")
	if rec.Code != 200 {
		t.Fatalf("get: got %d", rec.Code)
	}
	rec = doReq(t, s, "GET", "/notes/99", "")
	if rec.Code != 404 {
		t.Fatalf("get missing: got %d", rec.Code)
	}

	// Patch partial.
	rec = doReq(t, s, "PATCH", "/notes/2", `{"done":true}`)
	if rec.Code != 200 {
		t.Fatalf("patch: got %d %q", rec.Code, rec.Body.String())
	}
	var patched Note
	if err := json.Unmarshal(rec.Body.Bytes(), &patched); err != nil {
		t.Fatal(err)
	}
	if !patched.Done || patched.Title != "b" || patched.Body != "bb" || patched.Priority != 1 {
		t.Fatalf("patched = %+v", patched)
	}

	// Patch invalid.
	for _, body := range []string{`{`, `{"title":""}`, `{"priority":9}`} {
		rec = doReq(t, s, "PATCH", "/notes/2", body)
		if rec.Code != 400 {
			t.Fatalf("PATCH %q: got %d, want 400", body, rec.Code)
		}
	}
	rec = doReq(t, s, "PATCH", "/notes/99", `{"done":true}`)
	if rec.Code != 404 {
		t.Fatalf("patch missing: got %d", rec.Code)
	}

	// Delete.
	rec = doReq(t, s, "DELETE", "/notes/1", "")
	if rec.Code != 204 {
		t.Fatalf("delete: got %d", rec.Code)
	}
	rec = doReq(t, s, "DELETE", "/notes/1", "")
	if rec.Code != 404 {
		t.Fatalf("delete missing: got %d", rec.Code)
	}

	// Unknown routes.
	for _, req := range []struct{ method, path string }{
		{"GET", "/"}, {"GET", "/nope"}, {"PUT", "/notes"}, {"POST", "/notes/1"},
		{"GET", "/notes/abc"}, {"HEAD", "/notes/1"},
	} {
		rec = doReq(t, s, req.method, req.path, "")
		if rec.Code != 404 {
			t.Fatalf("%s %s: got %d, want 404", req.method, req.path, rec.Code)
		}
	}
}

func TestConcurrentIDs(t *testing.T) {
	s := NewServer()
	var wg sync.WaitGroup
	const n = 50
	for i := 0; i < n; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			rec := doReq(t, s, "POST", "/notes", `{"title":"x"}`)
			if rec.Code != 201 {
				t.Errorf("create: got %d", rec.Code)
			}
		}()
	}
	wg.Wait()
	rec := doReq(t, s, "GET", "/notes", "")
	var list []Note
	if err := json.Unmarshal(rec.Body.Bytes(), &list); err != nil {
		t.Fatal(err)
	}
	if len(list) != n {
		t.Fatalf("got %d notes, want %d", len(list), n)
	}
	seen := map[string]bool{}
	for _, note := range list {
		if seen[note.ID] {
			t.Fatalf("duplicate id %s", note.ID)
		}
		seen[note.ID] = true
	}
	for i := 1; i <= n; i++ {
		if !seen[fmt.Sprint(i)] {
			t.Fatalf("missing id %d", i)
		}
	}
	// Sort order check on concurrent list.
	sorted := make([]Note, len(list))
	copy(sorted, list)
	sort.SliceStable(sorted, func(i, j int) bool { return sorted[i].Priority < sorted[j].Priority })
	if !reflect.DeepEqual(list, sorted) {
		t.Fatal("list not sorted by priority")
	}
}
