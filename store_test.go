package main

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"path/filepath"
	"strings"
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
	pdf := []byte("%PDF-1.4 test")
	sum := sha256.Sum256(pdf)
	h := hex.EncodeToString(sum[:])
	if err := s.saveDoc(h, bytes.NewReader([]byte("not a pdf"))); err == nil {
		t.Fatal("accepted body not matching its hash")
	}
	notPDF := []byte("hello")
	ns := sha256.Sum256(notPDF)
	if err := s.saveDoc(hex.EncodeToString(ns[:]), bytes.NewReader(notPDF)); err == nil {
		t.Fatal("accepted non-PDF")
	}
	if _, ok := s.docPath("../../etc/passwd"); ok {
		t.Fatal("path traversal accepted")
	}
	if err := s.saveDoc(h, bytes.NewReader(pdf)); err != nil {
		t.Fatal(err)
	}
	s.touchDoc(h, "a.pdf", 3)
	if r, _ := s.recentDocs(3); len(r) != 1 || r[0].Name != "a.pdf" || r[0].Pages != 3 {
		t.Fatalf("recent: %+v", r)
	}
	s.touchDoc(strings.Repeat("0", 64), "gone.pdf", 1) // no stored copy → not listed
	if r, _ := s.recentDocs(3); len(r) != 1 {
		t.Fatalf("listed doc without a copy: %+v", r)
	}

	if cacheKey("a", "bc") == cacheKey("ab", "c") {
		t.Fatal("cache key collision across part boundaries")
	}
}
