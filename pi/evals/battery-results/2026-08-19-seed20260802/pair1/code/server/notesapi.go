// Package notesapi implements a small in-memory REST API for notes.
package notesapi

import (
	"encoding/json"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"sync"
)

// Note is a single note. Do not change this type.
type Note struct {
	ID       string `json:"id"`
	Title    string `json:"title"`
	Body     string `json:"body"`
	Priority int    `json:"priority"`
	Done     bool   `json:"done"`
}

// Server serves the notes REST API. See spec.md for the required endpoints.
type Server struct {
	mu     sync.Mutex
	notes  map[int]Note
	nextID int
}

// NewServer returns a new, empty Server. Do not change this signature.
func NewServer() *Server {
	return &Server{notes: make(map[int]Note), nextID: 1}
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(v)
}

func writeError(w http.ResponseWriter, status int, msg string) {
	writeJSON(w, status, map[string]string{"error": msg})
}

func (s *Server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	path := strings.TrimPrefix(r.URL.Path, "/")
	parts := strings.Split(path, "/")

	switch {
	case len(parts) == 1 && parts[0] == "notes":
		switch r.Method {
		case http.MethodPost:
			s.handleCreate(w, r)
		case http.MethodGet:
			s.handleList(w)
		default:
			writeError(w, http.StatusNotFound, "not found")
		}
	case len(parts) == 2 && parts[0] == "notes" && parts[1] != "":
		id, err := strconv.Atoi(parts[1])
		if err != nil {
			writeError(w, http.StatusNotFound, "not found")
			return
		}
		switch r.Method {
		case http.MethodGet:
			s.handleGet(w, id)
		case http.MethodPatch:
			s.handlePatch(w, r, id)
		case http.MethodDelete:
			s.handleDelete(w, id)
		default:
			writeError(w, http.StatusNotFound, "not found")
		}
	default:
		writeError(w, http.StatusNotFound, "not found")
	}
}

func (s *Server) handleCreate(w http.ResponseWriter, r *http.Request) {
	var payload struct {
		Title    string `json:"title"`
		Body     string `json:"body"`
		Priority *int   `json:"priority"`
	}
	if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
		writeError(w, http.StatusBadRequest, "invalid JSON body")
		return
	}
	if payload.Title == "" {
		writeError(w, http.StatusBadRequest, "title is required and must be non-empty")
		return
	}
	priority := 3
	if payload.Priority != nil {
		if *payload.Priority < 1 || *payload.Priority > 5 {
			writeError(w, http.StatusBadRequest, "priority must be an integer between 1 and 5")
			return
		}
		priority = *payload.Priority
	}

	s.mu.Lock()
	defer s.mu.Unlock()
	note := Note{
		ID:       strconv.Itoa(s.nextID),
		Title:    payload.Title,
		Body:     payload.Body,
		Priority: priority,
		Done:     false,
	}
	s.notes[s.nextID] = note
	s.nextID++
	writeJSON(w, http.StatusCreated, note)
}

func (s *Server) handleList(w http.ResponseWriter) {
	s.mu.Lock()
	notes := make([]Note, 0, len(s.notes))
	for _, n := range s.notes {
		notes = append(notes, n)
	}
	s.mu.Unlock()

	sort.SliceStable(notes, func(i, j int) bool {
		if notes[i].Priority != notes[j].Priority {
			return notes[i].Priority < notes[j].Priority
		}
		return atoi(notes[i].ID) < atoi(notes[j].ID)
	})
	writeJSON(w, http.StatusOK, notes)
}

func (s *Server) handleGet(w http.ResponseWriter, id int) {
	s.mu.Lock()
	note, ok := s.notes[id]
	s.mu.Unlock()
	if !ok {
		writeError(w, http.StatusNotFound, "note not found")
		return
	}
	writeJSON(w, http.StatusOK, note)
}

func (s *Server) handlePatch(w http.ResponseWriter, r *http.Request, id int) {
	var payload struct {
		Title    *string `json:"title"`
		Body     *string `json:"body"`
		Priority *int    `json:"priority"`
		Done     *bool   `json:"done"`
	}
	if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
		writeError(w, http.StatusBadRequest, "invalid JSON body")
		return
	}
	if payload.Title != nil && *payload.Title == "" {
		writeError(w, http.StatusBadRequest, "title must be non-empty")
		return
	}
	if payload.Priority != nil && (*payload.Priority < 1 || *payload.Priority > 5) {
		writeError(w, http.StatusBadRequest, "priority must be an integer between 1 and 5")
		return
	}

	s.mu.Lock()
	defer s.mu.Unlock()
	note, ok := s.notes[id]
	if !ok {
		writeError(w, http.StatusNotFound, "note not found")
		return
	}
	if payload.Title != nil {
		note.Title = *payload.Title
	}
	if payload.Body != nil {
		note.Body = *payload.Body
	}
	if payload.Priority != nil {
		note.Priority = *payload.Priority
	}
	if payload.Done != nil {
		note.Done = *payload.Done
	}
	s.notes[id] = note
	writeJSON(w, http.StatusOK, note)
}

func (s *Server) handleDelete(w http.ResponseWriter, id int) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, ok := s.notes[id]; !ok {
		writeError(w, http.StatusNotFound, "note not found")
		return
	}
	delete(s.notes, id)
	w.WriteHeader(http.StatusNoContent)
}

func atoi(s string) int {
	n, _ := strconv.Atoi(s)
	return n
}
