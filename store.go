package main

import (
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"

	_ "modernc.org/sqlite"
)

// Notes are stored as the client's JSON blob, keyed by note id and grouped by document hash.
// ponytail: cache grows forever; add an LRU sweep on created if the db gets big.
const schema = `
CREATE TABLE IF NOT EXISTS notes (id TEXT PRIMARY KEY, doc TEXT NOT NULL, data TEXT NOT NULL, updated INTEGER NOT NULL DEFAULT (unixepoch()));
CREATE INDEX IF NOT EXISTS notes_doc ON notes(doc);
CREATE TABLE IF NOT EXISTS cache (key TEXT PRIMARY KEY, value TEXT NOT NULL, created INTEGER NOT NULL DEFAULT (unixepoch()));`

type store struct{ db *sql.DB }

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
	return &store{db}, nil
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
