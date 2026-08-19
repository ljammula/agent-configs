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
	mu      sync.Mutex
	nextID  int
	bookmap map[string]*Bookmark
}

// NewServer returns a new, empty Server. Do not change this signature.
func NewServer() *Server {
	return &Server{bookmap: make(map[string]*Bookmark)}
}

func (s *Server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	path := strings.TrimPrefix(r.URL.Path, "/")
	parts := strings.Split(path, "/")

	switch {
	case len(parts) == 1 && parts[0] == "bookmarks":
		switch r.Method {
		case http.MethodPost:
			s.handleCreate(w, r)
		case http.MethodGet:
			s.handleList(w)
		default:
			s.writeError(w, http.StatusNotFound, "method not allowed")
		}
	case len(parts) == 2 && parts[0] == "bookmarks":
		id := parts[1]
		switch r.Method {
		case http.MethodGet:
			s.handleGet(w, id)
		case http.MethodPatch:
			s.handlePatch(w, r, id)
		case http.MethodDelete:
			s.handleDelete(w, id)
		default:
			s.writeError(w, http.StatusNotFound, "method not allowed")
		}
	case len(parts) == 3 && parts[0] == "bookmarks" && parts[2] == "visit" && r.Method == http.MethodPost:
		s.handleVisit(w, parts[1])
	default:
		s.writeError(w, http.StatusNotFound, "not found")
	}
}

func (s *Server) handleCreate(w http.ResponseWriter, r *http.Request) {
	var payload struct {
		URL   string   `json:"url"`
		Title string   `json:"title"`
		Tags  []string `json:"tags"`
	}
	if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
		s.writeError(w, http.StatusBadRequest, "invalid request body: "+err.Error())
		return
	}
	if payload.URL == "" {
		s.writeError(w, http.StatusBadRequest, "url is required")
		return
	}

	s.mu.Lock()
	s.nextID++
	bm := &Bookmark{
		ID:     strconv.Itoa(s.nextID),
		URL:    payload.URL,
		Title:  payload.Title,
		Tags:   payload.Tags,
		Visits: 0,
	}
	if bm.Tags == nil {
		bm.Tags = []string{}
	}
	s.bookmap[bm.ID] = bm
	s.mu.Unlock()

	s.writeJSON(w, http.StatusCreated, bm)
}

func (s *Server) handleList(w http.ResponseWriter) {
	s.mu.Lock()
	list := make([]*Bookmark, 0, len(s.bookmap))
	for _, bm := range s.bookmap {
		list = append(list, bm)
	}
	s.mu.Unlock()

	sort.Slice(list, func(i, j int) bool {
		if list[i].Visits != list[j].Visits {
			return list[i].Visits > list[j].Visits
		}
		return idNum(list[i].ID) < idNum(list[j].ID)
	})

	s.writeJSON(w, http.StatusOK, list)
}

func (s *Server) handleGet(w http.ResponseWriter, id string) {
	s.mu.Lock()
	bm, ok := s.bookmap[id]
	var out *Bookmark
	if ok {
		out = copyBookmark(bm)
	}
	s.mu.Unlock()

	if !ok {
		s.writeError(w, http.StatusNotFound, "bookmark not found")
		return
	}
	s.writeJSON(w, http.StatusOK, out)
}

func (s *Server) handleVisit(w http.ResponseWriter, id string) {
	s.mu.Lock()
	bm, ok := s.bookmap[id]
	if !ok {
		s.mu.Unlock()
		s.writeError(w, http.StatusNotFound, "bookmark not found")
		return
	}
	bm.Visits++
	out := copyBookmark(bm)
	s.mu.Unlock()

	s.writeJSON(w, http.StatusOK, out)
}

func (s *Server) handlePatch(w http.ResponseWriter, r *http.Request, id string) {
	var payload struct {
		Title *string   `json:"title"`
		Tags  *[]string `json:"tags"`
	}
	if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
		s.writeError(w, http.StatusBadRequest, "invalid request body: "+err.Error())
		return
	}
	if payload.Title != nil && *payload.Title == "" {
		s.writeError(w, http.StatusBadRequest, "title must be a non-empty string")
		return
	}

	s.mu.Lock()
	bm, ok := s.bookmap[id]
	if !ok {
		s.mu.Unlock()
		s.writeError(w, http.StatusNotFound, "bookmark not found")
		return
	}
	if payload.Title != nil {
		bm.Title = *payload.Title
	}
	if payload.Tags != nil {
		tags := *payload.Tags
		if tags == nil {
			tags = []string{}
		}
		bm.Tags = tags
	}
	out := copyBookmark(bm)
	s.mu.Unlock()

	s.writeJSON(w, http.StatusOK, out)
}

func (s *Server) handleDelete(w http.ResponseWriter, id string) {
	s.mu.Lock()
	_, ok := s.bookmap[id]
	if ok {
		delete(s.bookmap, id)
	}
	s.mu.Unlock()

	if !ok {
		s.writeError(w, http.StatusNotFound, "bookmark not found")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func copyBookmark(bm *Bookmark) *Bookmark {
	tags := make([]string, len(bm.Tags))
	copy(tags, bm.Tags)
	return &Bookmark{ID: bm.ID, URL: bm.URL, Title: bm.Title, Tags: tags, Visits: bm.Visits}
}

func idNum(id string) int {
	n, err := strconv.Atoi(id)
	if err != nil {
		return 0
	}
	return n
}

func (s *Server) writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(v)
}

func (s *Server) writeError(w http.ResponseWriter, status int, msg string) {
	s.writeJSON(w, status, map[string]string{"error": msg})
}
