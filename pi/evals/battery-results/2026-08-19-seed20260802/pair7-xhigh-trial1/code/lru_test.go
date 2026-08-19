package lru

import "testing"

func TestGetMissing(t *testing.T) {
	c := NewLRUCache(2)
	if _, ok := c.Get(1); ok {
		t.Fatalf("expected miss for key 1")
	}
}

func TestPutAndGet(t *testing.T) {
	c := NewLRUCache(2)
	c.Put(1, 100)
	if v, ok := c.Get(1); !ok || v != 100 {
		t.Fatalf("got (%d, %v), want (100, true)", v, ok)
	}
}

func TestEvictsLeastRecentlyUsed(t *testing.T) {
	c := NewLRUCache(2)
	c.Put(1, 1)
	c.Put(2, 2)
	c.Get(1)    // 1 is now most-recently-used; 2 is least-recently-used
	c.Put(3, 3) // should evict 2, not 1

	if _, ok := c.Get(2); ok {
		t.Fatalf("expected key 2 to be evicted")
	}
	if v, ok := c.Get(1); !ok || v != 1 {
		t.Fatalf("expected key 1 to remain, got (%d, %v)", v, ok)
	}
	if v, ok := c.Get(3); !ok || v != 3 {
		t.Fatalf("expected key 3 to be present, got (%d, %v)", v, ok)
	}
}

func TestPutUpdatesValueAndRecency(t *testing.T) {
	c := NewLRUCache(2)
	c.Put(1, 1)
	c.Put(2, 2)
	c.Put(1, 11) // update 1; 1 is now most-recently-used
	c.Put(3, 3)  // should evict 2, not 1

	if v, ok := c.Get(1); !ok || v != 11 {
		t.Fatalf("expected key 1 = 11, got (%d, %v)", v, ok)
	}
	if _, ok := c.Get(2); ok {
		t.Fatalf("expected key 2 to be evicted")
	}
}

// Every eviction test above uses key == value (Put(1, 1), Put(2, 2), ...),
// which can't distinguish an implementation that evicts by key from one
// that accidentally evicts by value (e.g. storing the value where the key
// belongs in an internal list node, then reading it back out as if it were
// the key). Found live 2026-08-16 in a Qwen3.8-driven Pi harness run: the
// submitted code passed every test above at 100% coverage but evicted the
// wrong entry whenever a key differed from its value — see
// agent-configs/pi-harness-validation-status.md's "First live claude-sonnet-5
// comparison" entry. This test uses keys and values that never coincide.
func TestEvictsByKeyNotValue(t *testing.T) {
	c := NewLRUCache(2)
	c.Put(10, 100)
	c.Put(20, 200)
	c.Put(30, 300) // over capacity: should evict key 10 (LRU), not key 100

	if _, ok := c.Get(10); ok {
		t.Fatalf("expected key 10 to be evicted")
	}
	if v, ok := c.Get(20); !ok || v != 200 {
		t.Fatalf("expected key 20 = 200, got (%d, %v)", v, ok)
	}
	if v, ok := c.Get(30); !ok || v != 300 {
		t.Fatalf("expected key 30 = 300, got (%d, %v)", v, ok)
	}
}
