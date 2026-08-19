// Package notesapi implements a small in-memory REST API for notes.
package notesapi

import (
	"encoding/json"
	"net/http"
	"strconv"
	"strings"
	"sync"
)

// Note is a single note. Do not change this type.
type Note struct {
	ID    string `json:"id"`
	Title string `json:"title"`
	Body  string `json:"body"`
}

// Server serves the notes REST API. See spec.md for the required endpoints.
type Server struct {
	mu     sync.Mutex
	notes  []*Note
	nextID int
}

// NewServer returns a new, empty Server. Do not change this signature.
func NewServer() *Server {
	return &Server{nextID: 1}
}

func (s *Server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if !strings.HasPrefix(r.URL.Path, "/notes") {
		http.NotFound(w, r)
		return
	}
	rest := strings.TrimPrefix(r.URL.Path, "/notes")
	if rest == "" {
		switch r.Method {
		case http.MethodGet:
			s.handleList(w, r)
		case http.MethodPost:
			s.handleCreate(w, r)
		default:
			http.NotFound(w, r)
		}
		return
	}
	id := strings.TrimPrefix(rest, "/")
	if id == "" || strings.Contains(id, "/") {
		http.NotFound(w, r)
		return
	}
	switch r.Method {
	case http.MethodGet:
		s.handleGet(w, id)
	case http.MethodDelete:
		s.handleDelete(w, id)
	default:
		http.NotFound(w, r)
	}
}

func (s *Server) handleCreate(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Title string `json:"title"`
		Body  string `json:"body"`
	}
	if err := json.NewDecoder(r.Body).Decode(&in); err != nil {
		http.Error(w, "invalid JSON body", http.StatusBadRequest)
		return
	}
	s.mu.Lock()
	n := &Note{ID: strconv.Itoa(s.nextID), Title: in.Title, Body: in.Body}
	s.nextID++
	s.notes = append(s.notes, n)
	s.mu.Unlock()
	writeJSON(w, http.StatusCreated, n)
}

func (s *Server) handleList(w http.ResponseWriter, r *http.Request) {
	s.mu.Lock()
	notes := make([]*Note, len(s.notes))
	copy(notes, s.notes)
	s.mu.Unlock()
	writeJSON(w, http.StatusOK, notes)
}

func (s *Server) handleGet(w http.ResponseWriter, id string) {
	s.mu.Lock()
	n := s.findLocked(id)
	s.mu.Unlock()
	if n == nil {
		http.NotFound(w, nil)
		return
	}
	writeJSON(w, http.StatusOK, n)
}

func (s *Server) handleDelete(w http.ResponseWriter, id string) {
	s.mu.Lock()
	for i, n := range s.notes {
		if n.ID == id {
			s.notes = append(s.notes[:i], s.notes[i+1:]...)
			s.mu.Unlock()
			w.WriteHeader(http.StatusNoContent)
			return
		}
	}
	s.mu.Unlock()
	http.NotFound(w, nil)
}

func (s *Server) findLocked(id string) *Note {
	for _, n := range s.notes {
		if n.ID == id {
			return n
		}
	}
	return nil
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(v)
}
