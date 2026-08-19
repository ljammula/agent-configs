// Package bookmarksapi implements a small in-memory REST API for bookmarks.
package bookmarksapi

import (
	"encoding/json"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"sync"
)

// Bookmark is a single bookmark. Do not change this type.
type Bookmark struct {
	ID     string   `json:"id"`
	URL    string   `json:"url"`
	Title  string   `json:"title"`
	Tags   []string `json:"tags"`
	Visits int      `json:"visits"`
}

// Server serves the bookmarks REST API. See spec.md for the required
// endpoints.
type Server struct {
	mu     sync.Mutex
	nextID int
	items  map[string]*Bookmark
}

// NewServer returns a new, empty Server. Do not change this signature.
func NewServer() *Server {
	return &Server{items: make(map[string]*Bookmark)}
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func writeError(w http.ResponseWriter, status int, msg string) {
	writeJSON(w, status, map[string]string{"error": msg})
}

func (s *Server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	path := r.URL.Path
	switch {
	case path == "/bookmarks":
		switch r.Method {
		case http.MethodPost:
			s.handleCreate(w, r)
		case http.MethodGet:
			s.handleList(w)
		default:
			writeError(w, http.StatusNotFound, "not found")
		}
	case strings.HasPrefix(path, "/bookmarks/"):
		rest := strings.TrimPrefix(path, "/bookmarks/")
		id, sub, hasSub := strings.Cut(rest, "/")
		if !hasSub {
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
		} else if sub == "visit" && r.Method == http.MethodPost {
			s.handleVisit(w, id)
		} else {
			writeError(w, http.StatusNotFound, "not found")
		}
	default:
		writeError(w, http.StatusNotFound, "not found")
	}
}

func (s *Server) handleCreate(w http.ResponseWriter, r *http.Request) {
	var body struct {
		URL   string   `json:"url"`
		Title string   `json:"title"`
		Tags  []string `json:"tags"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid JSON body")
		return
	}
	if body.URL == "" {
		writeError(w, http.StatusBadRequest, "url is required")
		return
	}
	if body.Tags == nil {
		body.Tags = []string{}
	}
	s.mu.Lock()
	s.nextID++
	bm := &Bookmark{
		ID:     strconv.Itoa(s.nextID),
		URL:    body.URL,
		Title:  body.Title,
		Tags:   body.Tags,
		Visits: 0,
	}
	s.items[bm.ID] = bm
	s.mu.Unlock()
	writeJSON(w, http.StatusCreated, bm)
}

func (s *Server) handleList(w http.ResponseWriter) {
	s.mu.Lock()
	list := make([]Bookmark, 0, len(s.items))
	for _, bm := range s.items {
		list = append(list, *bm)
	}
	s.mu.Unlock()
	sort.Slice(list, func(i, j int) bool {
		if list[i].Visits != list[j].Visits {
			return list[i].Visits > list[j].Visits
		}
		ii, _ := strconv.Atoi(list[i].ID)
		jj, _ := strconv.Atoi(list[j].ID)
		return ii < jj
	})
	writeJSON(w, http.StatusOK, list)
}

func (s *Server) handleGet(w http.ResponseWriter, id string) {
	s.mu.Lock()
	bm, ok := s.items[id]
	var out Bookmark
	if ok {
		out = *bm
	}
	s.mu.Unlock()
	if !ok {
		writeError(w, http.StatusNotFound, "bookmark not found")
		return
	}
	writeJSON(w, http.StatusOK, out)
}

func (s *Server) handleVisit(w http.ResponseWriter, id string) {
	s.mu.Lock()
	bm, ok := s.items[id]
	if ok {
		bm.Visits++
	}
	var out Bookmark
	if ok {
		out = *bm
	}
	s.mu.Unlock()
	if !ok {
		writeError(w, http.StatusNotFound, "bookmark not found")
		return
	}
	writeJSON(w, http.StatusOK, out)
}

func (s *Server) handlePatch(w http.ResponseWriter, r *http.Request, id string) {
	var body struct {
		Title *string   `json:"title"`
		Tags  *[]string `json:"tags"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid JSON body")
		return
	}
	if body.Title != nil && *body.Title == "" {
		writeError(w, http.StatusBadRequest, "title must be a non-empty string")
		return
	}
	s.mu.Lock()
	bm, ok := s.items[id]
	if ok {
		if body.Title != nil {
			bm.Title = *body.Title
		}
		if body.Tags != nil {
			bm.Tags = *body.Tags
		}
	}
	var out Bookmark
	if ok {
		out = *bm
	}
	s.mu.Unlock()
	if !ok {
		writeError(w, http.StatusNotFound, "bookmark not found")
		return
	}
	writeJSON(w, http.StatusOK, out)
}

func (s *Server) handleDelete(w http.ResponseWriter, id string) {
	s.mu.Lock()
	_, ok := s.items[id]
	if ok {
		delete(s.items, id)
	}
	s.mu.Unlock()
	if !ok {
		writeError(w, http.StatusNotFound, "bookmark not found")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
