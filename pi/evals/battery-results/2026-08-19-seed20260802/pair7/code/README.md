# lru

A fixed-capacity least-recently-used (LRU) cache mapping `int` keys to `int`
values.

- `NewLRUCache(capacity int) *LRUCache` — creates a cache holding at most
  `capacity` entries.
- `Get(key int) (int, bool)` — returns the value and whether the key was
  present; a successful `Get` counts as a use of the key.
- `Put(key, value int)` — inserts or updates the key; when at capacity, the
  least recently used key (by `Get` or `Put`) is evicted.

## Build, run, test

```sh
go build ./...   # build
go test ./...    # run the tests
make verify      # canonical check: go vet ./... && go test ./...
```
