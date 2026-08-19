# Notes API + Dart client

Two packages:

- `server/` — a small thread-safe, in-memory Go REST API for notes
  (`POST /notes`, `GET /notes`, `GET /notes/{id}`, `PATCH /notes/{id}`,
  `DELETE /notes/{id}`).
- `client/` — a Dart library (`notes_client`): the `Note` model, a
  `NotesApiClient` that talks to the server over HTTP, and a
  `NotesViewModel` wrapping the client with in-memory state for a UI layer.

## Requirements

- Go 1.22+
- Dart 3.0+

## Build / run

```sh
# Server (library; use it as an http.Handler, e.g. http.ListenAndServe(addr, notesapi.NewServer()))
cd server && go build ./...

# Client (library; fetch dependencies first)
cd client && dart pub get
```

## Test / verify

```sh
make verify
```

This runs the canonical check:

```sh
(cd 'client' && dart test ) && (cd 'server' && go vet ./... && go test ./... )
```
