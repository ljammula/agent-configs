package lru

import "container/list"

// LRUCache is a fixed-capacity least-recently-used cache mapping int keys to
// int values.
type LRUCache struct {
	capacity int
	order    *list.List // front = least recently used, back = most recently used
	data     map[int]*list.Element
}

// NewLRUCache returns a new cache that holds at most capacity entries.
func NewLRUCache(capacity int) *LRUCache {
	return &LRUCache{
		capacity: capacity,
		order:    list.New(),
		data:     make(map[int]*list.Element, capacity),
	}
}

// Get returns the value for key and whether it was present. A successful Get
// counts as a use of key for eviction purposes.
func (c *LRUCache) Get(key int) (int, bool) {
	if el, ok := c.data[key]; ok {
		c.order.MoveToBack(el)
		return el.Value.(int), true
	}
	return 0, false
}

// Put inserts or updates the value for key, evicting the least recently used
// entry if the cache is over capacity.
func (c *LRUCache) Put(key, value int) {
	if el, ok := c.data[key]; ok {
		el.Value = value
		c.order.MoveToBack(el)
		return
	}
	el := c.order.PushBack(value)
	c.data[key] = el

	if c.order.Len() > c.capacity {
		oldest := c.order.Front()
		c.order.Remove(oldest)
		delete(c.data, oldest.Value.(int))
	}
}
