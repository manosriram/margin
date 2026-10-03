package main

import (
	"path/filepath"
	"testing"
)

func TestStore(t *testing.T) {
	s, err := openStore(filepath.Join(t.TempDir(), "m.db"))
	if err != nil {
		t.Fatal(err)
	}
	s.putNote("a", "doc1", []byte(`{"id":"a","pinned":false}`))
	s.putNote("a", "doc1", []byte(`{"id":"a","pinned":true}`)) // upsert
	s.putNote("b", "doc2", []byte(`{"id":"b"}`))
	if n, _ := s.notes("doc1"); len(n) != 1 || string(n[0]) != `{"id":"a","pinned":true}` {
		t.Fatalf("notes: %s", n)
	}
	s.deleteNote("a")
	if n, _ := s.notes("doc1"); len(n) != 0 {
		t.Fatalf("not deleted: %s", n)
	}

	k := cacheKey("ask", "m", "sel", "q")
	if _, ok := s.cacheGet(k); ok {
		t.Fatal("unexpected hit")
	}
	s.cachePut(k, "answer")
	if v, ok := s.cacheGet(k); !ok || v != "answer" {
		t.Fatalf("cache: %q %v", v, ok)
	}
	if cacheKey("a", "bc") == cacheKey("ab", "c") {
		t.Fatal("cache key collision across part boundaries")
	}
}
