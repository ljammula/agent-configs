# lru

A fixed-capacity least-recently-used (LRU) cache mapping `int` keys to `int`
values, in package `lru`. Both `Get` (on a hit) and `Put` count as a use of the
key; when the cache is at capacity, inserting a new key evicts the least
recently used one.

This is a library — there is no runnable entry point.

## Build

```sh
go build ./...
```

## Test

The canonical check (run by `make verify`):

```sh
go vet ./... && go test ./...
```

`make test`, `make lint`, and `make verify` all run this same command.
