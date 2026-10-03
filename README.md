# Margin

Read a PDF, highlight a passage, ask about it. Answers live in the margin — pin them, or leave them to show on hover.

## Requirements

- [Claude Code](https://claude.com/claude-code) installed and logged in (`claude` on your PATH)

## Run

```sh
go build -o margin . && ./margin        # opens http://127.0.0.1:7777
./margin -addr 127.0.0.1:8080 -no-open
```

One binary; the web UI and pdf.js are embedded. Notes are kept in your browser's localStorage per PDF.

## Adding a provider

Add an entry to `providers` in `providers.go` (name, models, `ask` func that streams text).
