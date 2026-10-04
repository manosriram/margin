package main

import (
	"bytes"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"regexp"

	_ "modernc.org/sqlite"
)

// Notes are stored as the client's JSON blob, keyed by note id and grouped by document hash.
// ponytail: cache grows forever; add an LRU sweep on created if the db gets big.
const schema = `
CREATE TABLE IF NOT EXISTS notes (id TEXT PRIMARY KEY, doc TEXT NOT NULL, data TEXT NOT NULL, updated INTEGER NOT NULL DEFAULT (unixepoch()));
CREATE INDEX IF NOT EXISTS notes_doc ON notes(doc);
CREATE TABLE IF NOT EXISTS cache (key TEXT PRIMARY KEY, value TEXT NOT NULL, created INTEGER NOT NULL DEFAULT (unixepoch()));
CREATE TABLE IF NOT EXISTS docs (hash TEXT PRIMARY KEY, name TEXT NOT NULL, pages INTEGER NOT NULL DEFAULT 0, opened INTEGER NOT NULL DEFAULT (unixepoch()));`

// docsDir holds a copy of every opened PDF as <sha256>.pdf, so recent papers reopen in one click.
// ponytail: copies are never pruned; add cleanup for docs not opened in N days if disk use matters.
type store struct {
	db      *sql.DB
	docsDir string
}

func defaultDBPath() string {
	dir, err := os.UserConfigDir()
	if err != nil {
		dir = "."
	}
	return filepath.Join(dir, "margin", "margin.db")
}

func openStore(path string) (*store, error) {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return nil, err
	}
	db, err := sql.Open("sqlite", path+"?_pragma=journal_mode(WAL)&_pragma=busy_timeout(5000)")
	if err != nil {
		return nil, err
	}
	if _, err := db.Exec(schema); err != nil {
		return nil, err
	}
	dir := filepath.Join(filepath.Dir(path), "docs")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return nil, err
	}
	return &store{db, dir}, nil
}

var docHash = regexp.MustCompile(`^[0-9a-f]{64}$`)

// docPath returns where a document's copy lives; ok is false for anything that isn't a sha256 hex
// (which also rules out path traversal).
func (s *store) docPath(hash string) (string, bool) {
	if !docHash.MatchString(hash) {
		return "", false
	}
	return filepath.Join(s.docsDir, hash+".pdf"), true
}

var errBadDoc = errors.New("not a PDF matching its hash")

// saveDoc stores body as the copy of hash, rejecting anything that isn't a PDF with that sha256.
func (s *store) saveDoc(hash string, body io.Reader) error {
	path, ok := s.docPath(hash)
	if !ok {
		return errBadDoc
	}
	tmp, err := os.CreateTemp(s.docsDir, "upload-*")
	if err != nil {
		return err
	}
	defer os.Remove(tmp.Name())
	h := sha256.New()
	var head bytes.Buffer
	if _, err := io.Copy(io.MultiWriter(tmp, h, &limitedWriter{&head, 5}), body); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	if hex.EncodeToString(h.Sum(nil)) != hash || head.String() != "%PDF-" {
		return errBadDoc
	}
	return os.Rename(tmp.Name(), path)
}

// limitedWriter keeps only the first n bytes (used to sniff the PDF header).
type limitedWriter struct {
	b *bytes.Buffer
	n int
}

func (w *limitedWriter) Write(p []byte) (int, error) {
	if left := w.n - w.b.Len(); left > 0 {
		w.b.Write(p[:min(left, len(p))])
	}
	return len(p), nil
}

func (s *store) touchDoc(hash, name string, pages int) error {
	_, err := s.db.Exec(`INSERT INTO docs(hash, name, pages) VALUES(?, ?, ?)
		ON CONFLICT(hash) DO UPDATE SET name = excluded.name, pages = excluded.pages, opened = unixepoch()`, hash, name, pages)
	return err
}

type recentDoc struct {
	Hash   string `json:"hash"`
	Name   string `json:"name"`
	Pages  int    `json:"pages"`
	Opened int64  `json:"opened"`
}

var hashPrefix = regexp.MustCompile(`^[0-9a-f]{6,64}$`)

// resolveDoc finds the stored document whose hash starts with prefix (the slug in /d/<prefix>).
// found is false if none or several match, or the copy is missing.
func (s *store) resolveDoc(prefix string) (d recentDoc, found bool, err error) {
	if !hashPrefix.MatchString(prefix) {
		return d, false, nil
	}
	rows, err := s.db.Query(`SELECT hash, name, pages, opened FROM docs WHERE hash LIKE ? || '%' LIMIT 2`, prefix)
	if err != nil {
		return d, false, err
	}
	defer rows.Close()
	n := 0
	for rows.Next() {
		if err := rows.Scan(&d.Hash, &d.Name, &d.Pages, &d.Opened); err != nil {
			return d, false, err
		}
		n++
	}
	if n != 1 {
		return d, false, rows.Err()
	}
	p, _ := s.docPath(d.Hash)
	_, statErr := os.Stat(p)
	return d, statErr == nil, nil
}

// recentDocs lists the most recently opened documents whose copy still exists.
func (s *store) recentDocs(n int) ([]recentDoc, error) {
	rows, err := s.db.Query(`SELECT hash, name, pages, opened FROM docs ORDER BY opened DESC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []recentDoc{}
	for rows.Next() && len(out) < n {
		var d recentDoc
		if err := rows.Scan(&d.Hash, &d.Name, &d.Pages, &d.Opened); err != nil {
			return nil, err
		}
		if p, ok := s.docPath(d.Hash); ok {
			if _, err := os.Stat(p); err == nil {
				out = append(out, d)
			}
		}
	}
	return out, rows.Err()
}

func (s *store) notes(doc string) ([]json.RawMessage, error) {
	rows, err := s.db.Query(`SELECT data FROM notes WHERE doc = ? ORDER BY updated`, doc)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []json.RawMessage{}
	for rows.Next() {
		var d string
		if err := rows.Scan(&d); err != nil {
			return nil, err
		}
		out = append(out, json.RawMessage(d))
	}
	return out, rows.Err()
}

func (s *store) putNote(id, doc string, data []byte) error {
	_, err := s.db.Exec(`INSERT INTO notes(id, doc, data) VALUES(?, ?, ?)
		ON CONFLICT(id) DO UPDATE SET doc = excluded.doc, data = excluded.data, updated = unixepoch()`, id, doc, string(data))
	return err
}

func (s *store) deleteNote(id string) error {
	_, err := s.db.Exec(`DELETE FROM notes WHERE id = ?`, id)
	return err
}

// cacheKey hashes everything that affects the model's output.
func cacheKey(parts ...string) string {
	b, _ := json.Marshal(parts)
	h := sha256.Sum256(b)
	return hex.EncodeToString(h[:])
}

func (s *store) cacheGet(key string) (string, bool) {
	var v string
	err := s.db.QueryRow(`SELECT value FROM cache WHERE key = ?`, key).Scan(&v)
	return v, err == nil
}

func (s *store) cachePut(key, value string) {
	s.db.Exec(`INSERT OR REPLACE INTO cache(key, value) VALUES(?, ?)`, key, value)
}
