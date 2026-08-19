package lru

type node struct {
	key, value int
	prev, next *node
}

// LRUCache is a fixed-capacity least-recently-used cache mapping int keys to
// int values.
type LRUCache struct {
	capacity int
	data     map[int]*node
	head     *node // sentinel; head.next is most recently used
	tail     *node // sentinel; tail.prev is least recently used
}

// NewLRUCache returns a new cache that holds at most capacity entries.
func NewLRUCache(capacity int) *LRUCache {
	head, tail := &node{}, &node{}
	head.next = tail
	tail.prev = head
	return &LRUCache{
		capacity: capacity,
		data:     make(map[int]*node, capacity),
		head:     head,
		tail:     tail,
	}
}

func (c *LRUCache) remove(n *node) {
	n.prev.next = n.next
	n.next.prev = n.prev
}

func (c *LRUCache) pushFront(n *node) {
	n.prev = c.head
	n.next = c.head.next
	c.head.next.prev = n
	c.head.next = n
}

func (c *LRUCache) toFront(n *node) {
	c.remove(n)
	c.pushFront(n)
}

// Get returns the value for key and whether it was present. A successful
// lookup marks key as most recently used.
func (c *LRUCache) Get(key int) (int, bool) {
	n, ok := c.data[key]
	if !ok {
		return 0, false
	}
	c.toFront(n)
	return n.value, true
}

// Put inserts or updates the value for key, evicting the least recently used
// entry if the cache is over capacity.
func (c *LRUCache) Put(key, value int) {
	if n, ok := c.data[key]; ok {
		n.value = value
		c.toFront(n)
		return
	}
	n := &node{key: key, value: value}
	c.data[key] = n
	c.pushFront(n)

	if len(c.data) > c.capacity {
		oldest := c.tail.prev
		c.remove(oldest)
		delete(c.data, oldest.key)
	}
}
