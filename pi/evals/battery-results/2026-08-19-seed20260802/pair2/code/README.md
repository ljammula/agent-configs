# notesapi

A small, thread-safe, in-memory REST API for notes, implemented in Go.

## Endpoints

- `POST /notes` — create a note from a JSON body `{"title": "...", "body": "..."}`.
  Responds `201` with the created note (including its assigned `id`).
  Invalid JSON → `400`.
- `GET /notes` — list all notes in creation order.
- `GET /notes/{id}` — fetch one note, or `404` if it does not exist.
- `DELETE /notes/{id}` — delete a note, responding `204`, or `404` if it does not exist.
- Anything else → `404`.

## Build, run, test

```sh
go build ./...
make verify   # runs: go vet ./... && go test ./...
```

The server is a plain `http.Handler` (`notesapi.NewServer()`), so it can be
mounted on any `http.Server` or used directly with `httptest` in tests.
Concurrency is covered by `go test -race`.
