# lru

A fixed-capacity LRU (least recently used) cache mapping `int` keys to `int`
values, in the `lru` package (`lru.go`).

## API

- `NewLRUCache(capacity int) *LRUCache` — create a cache holding at most
  `capacity` entries.
- `Get(key int) (int, bool)` — return the value for `key` and whether it was
  present; a hit counts as a use for eviction.
- `Put(key, value int)` — insert or update `key`; counts as a use. When at
  capacity, inserting a new key evicts the least recently used key.

## Build, run, test

There is no runnable binary; this is a library. Verify with:

```sh
make verify
```

which runs `go vet ./... && go test ./...`.
