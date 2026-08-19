# Bookmarks

A small in-memory bookmarks REST API (Go) and a Dart client library
(data/service layer for a Flutter bookmarks app) that talks to it.

- `server/` — Go package `bookmarksapi`. `NewServer()` returns an
  `http.Handler` serving:
  - `POST /bookmarks` — create (`201`, JSON bookmark with assigned `id`)
  - `GET /bookmarks` — list, sorted by `visits` desc, then `id` asc
  - `GET /bookmarks/{id}` — fetch one (`404` if missing)
  - `POST /bookmarks/{id}/visit` — increment `visits` (`404` if missing)
  - `PATCH /bookmarks/{id}` — update `title` and/or `tags`
  - `DELETE /bookmarks/{id}` — delete (`204`)
- `client/` — Dart package `bookmarks_client` with `BookmarksApiClient`
  (HTTP wrapper) and `BookmarksViewModel` (in-memory state for a UI layer).

## Build

```sh
cd server && go build ./...
cd client && dart pub get
```

## Run the server

The server is a library; serve it with any `http.Server`, e.g.:

```sh
cd server
cat > /tmp/bm_main.go <<'EOF'
package main

import (
	"net/http"

	"bookmarksapi"
)

func main() {
	http.ListenAndServe("127.0.0.1:8080", bookmarksapi.NewServer())
}
EOF
go run /tmp/bm_main.go
```

## Test

Canonical check (run from the repo root):

```sh
make verify
```

This runs:

```sh
(cd 'client' && dart test ) && (cd 'server' && go vet ./... && go test ./... )
```

`make test` and `make lint` run the same command.
