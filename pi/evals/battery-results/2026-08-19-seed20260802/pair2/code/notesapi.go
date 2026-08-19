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
	notes  []Note
	nextID int
}

// NewServer returns a new, empty Server. Do not change this signature.
func NewServer() *Server {
	return &Server{nextID: 1}
}

func (s *Server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	notesPath := r.URL.Path == "/notes"
	if notesPath {
		switch r.Method {
		case http.MethodPost:
			s.handleCreate(w, r)
			return
		case http.MethodGet:
			s.handleList(w)
			return
		}
	}

	// /notes/{id}
	if parts := strings.Split(strings.Trim(r.URL.Path, "/"), "/"); len(parts) == 2 && parts[0] == "notes" {
		switch r.Method {
		case http.MethodGet:
			s.handleGet(w, parts[1])
			return
		case http.MethodDelete:
			s.handleDelete(w, parts[1])
			return
		}
	}

	w.WriteHeader(http.StatusNotFound)
}

func (s *Server) handleCreate(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Title string `json:"title"`
		Body  string `json:"body"`
	}
	if err := json.NewDecoder(r.Body).Decode(&in); err != nil {
		w.WriteHeader(http.StatusBadRequest)
		return
	}

	s.mu.Lock()
	note := Note{ID: strconv.Itoa(s.nextID), Title: in.Title, Body: in.Body}
	s.nextID++
	s.notes = append(s.notes, note)
	s.mu.Unlock()

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusCreated)
	json.NewEncoder(w).Encode(note)
}

func (s *Server) handleList(w http.ResponseWriter) {
	s.mu.Lock()
	notes := make([]Note, len(s.notes))
	copy(notes, s.notes)
	s.mu.Unlock()

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(notes)
}

func (s *Server) handleGet(w http.ResponseWriter, id string) {
	s.mu.Lock()
	note, ok := s.find(id)
	s.mu.Unlock()
	if !ok {
		w.WriteHeader(http.StatusNotFound)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(note)
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
	w.WriteHeader(http.StatusNotFound)
}

func (s *Server) find(id string) (Note, bool) {
	for _, n := range s.notes {
		if n.ID == id {
			return n, true
		}
	}
	return Note{}, false
}
