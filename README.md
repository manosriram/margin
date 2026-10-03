# Margin

Read a PDF, highlight a passage, ask about it. Answers live in the margin — pin them, or leave them to show on hover.

## Requirements

- [Claude Code](https://claude.com/claude-code) installed and logged in (`claude` on your PATH)

## Run

```sh
go build -o margin .
./margin                 # opens http://127.0.0.1:7889
./margin paper.pdf       # opens straight into the PDF
./margin -addr 127.0.0.1:8080 -no-open -db ./margin.db
```

One binary; the web UI and pdf.js are embedded. If the port is taken (another margin running), a free one is used.

## Data

Notes and a cache of answers/suggestions live in SQLite at `-db` (default: `~/Library/Application Support/margin/margin.db` on macOS, `~/.config/margin/margin.db` on Linux). Notes are keyed by the PDF's content hash, so renaming or moving the file keeps its history. Asking the same question about the same passage with the same model is answered from the cache.

A copy of each opened PDF is kept in `docs/` next to the database, so the intro page can reopen your last three papers in one click.
