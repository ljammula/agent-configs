# Bookmarks

A small in-memory bookmarks REST API in Go (`server/`) and a Dart client
library (`client/`) that talks to it (data/service layer for a Flutter
bookmarks app).

## Layout

- `server/` — Go module (`bookmarksapi`). `Server` implements `http.Handler`
  and serves:
  - `POST /bookmarks` — create (`{"url", "title", "tags"}`), returns `201`
  - `GET /bookmarks` — list, sorted by `visits` desc, then id asc
  - `GET /bookmarks/{id}` — fetch one
  - `POST /bookmarks/{id}/visit` — increment `visits`
  - `PATCH /bookmarks/{id}` — update `title` and/or `tags`
  - `DELETE /bookmarks/{id}` — delete
- `client/` — Dart package (`bookmarks_client`). `BookmarksApiClient`
  wraps the HTTP API; `BookmarksViewModel` keeps in-memory state for a UI.

## Build / run

Server (any `http.Handler` host, e.g.):

```sh
cd server
go build ./...
```

Client:

```sh
cd client
dart pub get
```

## Test / verify

```sh
make verify
```

This runs the project's full check:

```sh
(cd client && dart test) && (cd server && go vet ./... && go test ./...)
```

`make test` and `make lint` run the same command (there is no separate
lint step in this repo).
