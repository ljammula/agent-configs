package notesapi

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
)

func TestCreateAndGet(t *testing.T) {
	srv := httptest.NewServer(NewServer())
	defer srv.Close()

	created := postNote(t, srv.URL, Note{Title: "first", Body: "hello"})
	if created.ID == "" {
		t.Fatalf("expected created note to have an id, got %+v", created)
	}
	if created.Title != "first" || created.Body != "hello" {
		t.Fatalf("unexpected created note: %+v", created)
	}

	got := getNote(t, srv.URL, created.ID)
	if got != created {
		t.Fatalf("got %+v, want %+v", got, created)
	}
}

func TestGetMissingReturns404(t *testing.T) {
	srv := httptest.NewServer(NewServer())
	defer srv.Close()

	resp, err := http.Get(srv.URL + "/notes/does-not-exist")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusNotFound {
		t.Fatalf("got status %d, want 404", resp.StatusCode)
	}
}

func TestListReturnsCreationOrder(t *testing.T) {
	srv := httptest.NewServer(NewServer())
	defer srv.Close()

	a := postNote(t, srv.URL, Note{Title: "a"})
	b := postNote(t, srv.URL, Note{Title: "b"})

	resp, err := http.Get(srv.URL + "/notes")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("got status %d, want 200", resp.StatusCode)
	}

	var notes []Note
	if err := json.NewDecoder(resp.Body).Decode(&notes); err != nil {
		t.Fatal(err)
	}
	if len(notes) != 2 || notes[0].ID != a.ID || notes[1].ID != b.ID {
		t.Fatalf("got %+v, want [%+v %+v]", notes, a, b)
	}
}

func TestDelete(t *testing.T) {
	srv := httptest.NewServer(NewServer())
	defer srv.Close()

	a := postNote(t, srv.URL, Note{Title: "a"})

	req, _ := http.NewRequest(http.MethodDelete, srv.URL+"/notes/"+a.ID, nil)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusNoContent {
		t.Fatalf("got status %d, want 204", resp.StatusCode)
	}

	resp2, err := http.Get(srv.URL + "/notes/" + a.ID)
	if err != nil {
		t.Fatal(err)
	}
	defer resp2.Body.Close()
	if resp2.StatusCode != http.StatusNotFound {
		t.Fatalf("after delete, got status %d, want 404", resp2.StatusCode)
	}

	req2, _ := http.NewRequest(http.MethodDelete, srv.URL+"/notes/"+a.ID, nil)
	resp3, err := http.DefaultClient.Do(req2)
	if err != nil {
		t.Fatal(err)
	}
	resp3.Body.Close()
	if resp3.StatusCode != http.StatusNotFound {
		t.Fatalf("deleting twice, got status %d, want 404", resp3.StatusCode)
	}
}

func TestInvalidBodyReturns400(t *testing.T) {
	srv := httptest.NewServer(NewServer())
	defer srv.Close()

	resp, err := http.Post(srv.URL+"/notes", "application/json", bytes.NewBufferString("not json"))
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("got status %d, want 400", resp.StatusCode)
	}
}

func TestConcurrentCreates(t *testing.T) {
	srv := httptest.NewServer(NewServer())
	defer srv.Close()

	const n = 20
	var wg sync.WaitGroup
	for i := 0; i < n; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			postNote(t, srv.URL, Note{Title: "concurrent"})
		}()
	}
	wg.Wait()

	resp, err := http.Get(srv.URL + "/notes")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	var notes []Note
	if err := json.NewDecoder(resp.Body).Decode(&notes); err != nil {
		t.Fatal(err)
	}
	if len(notes) != n {
		t.Fatalf("got %d notes, want %d", len(notes), n)
	}
	ids := make(map[string]bool, n)
	for _, note := range notes {
		if ids[note.ID] {
			t.Fatalf("duplicate id %q", note.ID)
		}
		ids[note.ID] = true
	}
}

func postNote(t *testing.T, baseURL string, note Note) Note {
	t.Helper()
	body, err := json.Marshal(note)
	if err != nil {
		t.Fatal(err)
	}
	resp, err := http.Post(baseURL+"/notes", "application/json", bytes.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusCreated {
		t.Fatalf("POST /notes: got status %d, want 201", resp.StatusCode)
	}
	var created Note
	if err := json.NewDecoder(resp.Body).Decode(&created); err != nil {
		t.Fatal(err)
	}
	return created
}

func getNote(t *testing.T, baseURL, id string) Note {
	t.Helper()
	resp, err := http.Get(baseURL + "/notes/" + id)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("GET /notes/%s: got status %d, want 200", id, resp.StatusCode)
	}
	var note Note
	if err := json.NewDecoder(resp.Body).Decode(&note); err != nil {
		t.Fatal(err)
	}
	return note
}
