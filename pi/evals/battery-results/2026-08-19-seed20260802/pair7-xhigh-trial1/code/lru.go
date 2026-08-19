package lru

// LRUCache is a fixed-capacity least-recently-used cache mapping int keys to
// int values.
type LRUCache struct {
	capacity int
	order    []int // keys in use order: least recently used first
	data     map[int]int
}

// NewLRUCache returns a new cache that holds at most capacity entries.
func NewLRUCache(capacity int) *LRUCache {
	return &LRUCache{
		capacity: capacity,
		order:    make([]int, 0, capacity),
		data:     make(map[int]int, capacity),
	}
}

// Get returns the value for key and whether it was present. A successful Get
// counts as a use of key for eviction purposes.
func (c *LRUCache) Get(key int) (int, bool) {
	v, ok := c.data[key]
	if ok {
		c.touch(key)
	}
	return v, ok
}

// Put inserts or updates the value for key, evicting the least recently used
// entry if the cache is over capacity. Put counts as a use of key.
func (c *LRUCache) Put(key, value int) {
	c.touch(key)
	c.data[key] = value

	if len(c.data) > c.capacity {
		oldest := c.order[0]
		c.order = c.order[1:]
		delete(c.data, oldest)
	}
}

// touch moves key to the most recently used position in order, appending it
// if it is not present.
func (c *LRUCache) touch(key int) {
	for i, k := range c.order {
		if k == key {
			c.order = append(c.order[:i], c.order[i+1:]...)
			c.order = append(c.order, key)
			return
		}
	}
	c.order = append(c.order, key)
}
