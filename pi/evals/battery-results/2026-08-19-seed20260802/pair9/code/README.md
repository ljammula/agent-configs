# notesapi

A small, thread-safe, in-memory REST API for notes, implemented as an
`http.Handler` in `notesapi.go`.

## Endpoints

- `POST /notes` — create a note from a JSON body `{"title": "...", "body": "..."}`; responds `201` with the created note (including its `id`). Invalid JSON → `400`.
- `GET /notes` — list all notes in creation order.
- `GET /notes/{id}` — fetch one note, or `404` if not found.
- `DELETE /notes/{id}` — delete a note (`204`), or `404` if not found.

Any other method/path combination responds `404`.

## Build, run, test

Build:

```sh
go build ./...
```

Run: `*notesapi.Server` is an `http.Handler`; serve it with any HTTP server, e.g.

```go
http.ListenAndServe(":8080", notesapi.NewServer())
```

Verify (canonical check for this repo):

```sh
make verify
```

which runs `go vet ./... && go test ./...`. The tests are also safe to run
with the race detector: `go test -race ./...`.
