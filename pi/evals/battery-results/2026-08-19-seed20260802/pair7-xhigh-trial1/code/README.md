# lru

A fixed-capacity LRU (least recently used) cache mapping `int` keys to `int`
values, in package `lru`.

## API

```go
c := lru.NewLRUCache(capacity) // holds at most `capacity` entries
v, ok := c.Get(key)            // ok is false if key is absent
c.Put(key, value)              // insert or update
```

Both `Get` (on a hit) and `Put` count as a "use" of the key. When the cache is
at capacity and a new key is inserted via `Put`, the least recently used key
is evicted.

## Build

```sh
go build ./...
```

This is a library; there is no binary to run.

## Test

```sh
make verify
```

`make verify` (and the equivalent `make test` / `make lint`) runs the project's
verification command:

```sh
go vet ./... && go test ./...
```
