package lru

// LRUCache is a fixed-capacity least-recently-used cache mapping int keys to
// int values.
type LRUCache struct {
	capacity int
	order    []int // keys in recency order: oldest first, most recently used last
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

// Get returns the value for key and whether it was present. A hit counts as
// a use of key for eviction purposes.
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
	if _, exists := c.data[key]; exists {
		c.touch(key)
	} else {
		c.order = append(c.order, key)
	}
	c.data[key] = value

	if len(c.data) > c.capacity {
		oldest := c.order[0]
		c.order = c.order[1:]
		delete(c.data, oldest)
	}
}

// touch moves key to the most recently used position in order.
func (c *LRUCache) touch(key int) {
	for i, k := range c.order {
		if k == key {
			copy(c.order[i:], c.order[i+1:])
			c.order[len(c.order)-1] = key
			return
		}
	}
}
