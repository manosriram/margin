package main

import (
	"crypto/sha256"
	"embed"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"io/fs"
	"log"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"strconv"
	"strings"
	"sync"
)

//go:embed web
var webFS embed.FS

const systemPrompt = `You are a reading companion inside a PDF reader. The user highlighted a passage, or selected a region of the page (attached as an image), and asked a question about it.
Answer directly and concisely (usually 2-6 sentences). Use the surrounding page text for context. Plain prose; light markdown only if it truly helps.
Write math as LaTeX: $...$ inline, $$...$$ for display. Never use $ for currency; write "USD 5" instead.`

type askReq struct {
	Provider  string `json:"provider"`
	Model     string `json:"model"`
	Doc       string `json:"doc"`
	Page      int    `json:"page"`
	Selection string `json:"selection"`
	Context   string `json:"context"`
	Question  string `json:"question"`
	Image     string `json:"image"`   // optional data URL of a selected page region
	History   []turn `json:"history"` // earlier questions and answers on this highlight, oldest first
}

type turn struct {
	Question string `json:"question"`
	Answer   string `json:"answer"`
}

// prompt describes the page, the highlight and/or attached region, and the question (if any).
func (q askReq) prompt() string {
	s := fmt.Sprintf("Document: %s (page %d)\n\n<page_text>\n%s\n</page_text>\n", q.Doc, q.Page, q.Context)
	if q.Image != "" {
		s += "\nThe user selected a region of this page (figure, table, equation or image); it is attached.\n"
	}
	if q.Selection != "" {
		s += fmt.Sprintf("\n<highlight>\n%s\n</highlight>\n", q.Selection)
	}
	for _, t := range q.History {
		s += fmt.Sprintf("\nEarlier question: %s\nYour answer: %s\n", t.Question, t.Answer)
	}
	if q.Question != "" {
		if len(q.History) > 0 {
			s += "\nFollow-up question: " + q.Question
		} else {
			s += "\nQuestion: " + q.Question
		}
	}
	return s
}

var dataURL = regexp.MustCompile(`^data:(image/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=]+)$`)

// llm builds the provider request; ok is false if the image isn't a supported data URL.
func (q askReq) llm(model, system string, quick bool) (llmReq, bool) {
	r := llmReq{Model: model, System: system, Prompt: q.prompt(), Quick: quick}
	if q.Image != "" {
		m := dataURL.FindStringSubmatch(q.Image)
		if m == nil {
			return r, false
		}
		r.ImageType, r.ImageB64 = m[1], m[2]
	}
	return r, true
}

const maxBody = 12 << 20 // room for a page-region screenshot

// Tokens consumed since this margin process started (cache hits cost nothing and aren't counted).
var (
	usageMu      sync.Mutex
	sessionUsage usage
)

func addUsage(u usage) {
	usageMu.Lock()
	sessionUsage.add(u)
	usageMu.Unlock()
}

const defaultAddr = "127.0.0.1:7889"

func main() {
	addr := flag.String("addr", defaultAddr, "listen address")
	noOpen := flag.Bool("no-open", false, "don't open the browser")
	dbPath := flag.String("db", defaultDBPath(), "SQLite database for notes and cache")
	flag.Usage = func() {
		fmt.Fprintf(flag.CommandLine.Output(), "usage: margin [flags] [file.pdf]\n")
		flag.PrintDefaults()
	}
	flag.Parse()

	var pdfPath string
	if flag.NArg() > 0 {
		pdfPath, _ = filepath.Abs(flag.Arg(0))
		if _, err := os.Stat(pdfPath); err != nil {
			log.Fatal(err)
		}
	}

	db, err := openStore(*dbPath)
	if err != nil {
		log.Fatalf("open db %s: %v", *dbPath, err)
	}

	web, _ := fs.Sub(webFS, "web")
	http.Handle("/", http.FileServerFS(web))
	// /d/<hash prefix> is a shareable link to a stored paper; the page itself resolves and opens it.
	http.HandleFunc("GET /d/{slug}", func(w http.ResponseWriter, r *http.Request) {
		http.ServeFileFS(w, r, web, "index.html")
	})

	// The PDF given on the command line, if any; the UI opens it on load.
	http.HandleFunc("GET /api/doc", func(w http.ResponseWriter, r *http.Request) {
		if pdfPath == "" {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("X-Doc-Name", filepath.Base(pdfPath))
		w.Header().Set("Content-Type", "application/pdf")
		http.ServeFile(w, r, pdfPath)
	})

	// SHA-256 of the body, for browsers without crypto.subtle (plain http on a non-localhost address).
	http.HandleFunc("POST /api/hash", func(w http.ResponseWriter, r *http.Request) {
		h := sha256.New()
		if _, err := io.Copy(h, http.MaxBytesReader(w, r.Body, 1<<30)); err != nil {
			http.Error(w, err.Error(), 400)
			return
		}
		fmt.Fprintf(w, "%x", h.Sum(nil))
	})

	// Copies of opened PDFs, for the "recent" list on the intro page.
	http.HandleFunc("GET /api/recent", func(w http.ResponseWriter, r *http.Request) {
		docs, err := db.recentDocs(3)
		if err != nil {
			http.Error(w, err.Error(), 500)
			return
		}
		json.NewEncoder(w).Encode(docs)
	})

	http.HandleFunc("GET /api/resolve/{slug}", func(w http.ResponseWriter, r *http.Request) {
		d, ok, err := db.resolveDoc(r.PathValue("slug"))
		if err != nil {
			http.Error(w, err.Error(), 500)
			return
		}
		if !ok {
			http.NotFound(w, r)
			return
		}
		json.NewEncoder(w).Encode(d)
	})

	http.HandleFunc("GET /api/docs/{hash}", func(w http.ResponseWriter, r *http.Request) { // GET also answers HEAD
		path, ok := db.docPath(r.PathValue("hash"))
		if _, err := os.Stat(path); !ok || err != nil {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Type", "application/pdf")
		http.ServeFile(w, r, path)
	})

	// PUT with the PDF as body stores a copy (the client skips the body if HEAD says we have it);
	// either way the doc is marked as just opened.
	http.HandleFunc("PUT /api/docs/{hash}", func(w http.ResponseWriter, r *http.Request) {
		hash := r.PathValue("hash")
		path, ok := db.docPath(hash)
		if !ok {
			http.Error(w, "bad hash", 400)
			return
		}
		if r.ContentLength != 0 {
			if err := db.saveDoc(hash, http.MaxBytesReader(w, r.Body, 1<<30)); err != nil {
				http.Error(w, err.Error(), 400)
				return
			}
		} else if _, err := os.Stat(path); err != nil {
			http.Error(w, "no stored copy; send the PDF", 409)
			return
		}
		pages, _ := strconv.Atoi(r.URL.Query().Get("pages"))
		if err := db.touchDoc(hash, r.URL.Query().Get("name"), pages); err != nil {
			http.Error(w, err.Error(), 500)
		}
	})

	http.HandleFunc("GET /api/models", func(w http.ResponseWriter, r *http.Request) {
		type p struct {
			ID     string   `json:"id"`
			Name   string   `json:"name"`
			Models []string `json:"models"`
		}
		out := []p{}
		for _, id := range providerOrder {
			out = append(out, p{id, providers[id].name, providers[id].models})
		}
		json.NewEncoder(w).Encode(out)
	})

	http.HandleFunc("GET /api/usage", func(w http.ResponseWriter, r *http.Request) {
		usageMu.Lock()
		defer usageMu.Unlock()
		json.NewEncoder(w).Encode(sessionUsage)
	})

	http.HandleFunc("GET /api/notes", func(w http.ResponseWriter, r *http.Request) {
		notes, err := db.notes(r.URL.Query().Get("doc"))
		if err != nil {
			http.Error(w, err.Error(), 500)
			return
		}
		json.NewEncoder(w).Encode(notes)
	})

	http.HandleFunc("PUT /api/notes/{id}", func(w http.ResponseWriter, r *http.Request) {
		var raw json.RawMessage
		if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, maxBody)).Decode(&raw); err != nil {
			http.Error(w, "bad request", 400)
			return
		}
		var n struct {
			Doc string `json:"doc"`
		}
		if json.Unmarshal(raw, &n) != nil || n.Doc == "" {
			http.Error(w, "note needs a doc", 400)
			return
		}
		if err := db.putNote(r.PathValue("id"), n.Doc, raw); err != nil {
			http.Error(w, err.Error(), 500)
		}
	})

	http.HandleFunc("DELETE /api/notes/{id}", func(w http.ResponseWriter, r *http.Request) {
		if err := db.deleteNote(r.PathValue("id")); err != nil {
			http.Error(w, err.Error(), 500)
		}
	})

	http.HandleFunc("POST /api/ask", func(w http.ResponseWriter, r *http.Request) {
		var q askReq
		if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, maxBody)).Decode(&q); err != nil {
			http.Error(w, "bad request", 400)
			return
		}
		p, ok := providers[q.Provider]
		req, imgOK := q.llm(q.Model, systemPrompt, false)
		if !ok || !imgOK || !contains(p.models, q.Model) || strings.TrimSpace(q.Question) == "" {
			http.Error(w, "unknown provider/model, bad image or empty question", 400)
			return
		}
		w.Header().Set("Content-Type", "text/plain; charset=utf-8")
		w.Header().Set("X-Content-Type-Options", "nosniff")

		parts := []string{"ask", q.Provider, q.Model, q.Selection, q.Context, q.Image, strings.TrimSpace(q.Question)}
		if len(q.History) > 0 { // first questions keep their existing cache keys
			hist, _ := json.Marshal(q.History)
			parts = append(parts, string(hist))
		}
		key := cacheKey(parts...)
		if v, ok := db.cacheGet(key); ok {
			w.Header().Set("X-Cache", "hit")
			w.Write([]byte(v))
			return
		}

		flusher, _ := w.(http.Flusher)
		var full strings.Builder
		u, err := p.ask(r.Context(), req, func(chunk string) {
			full.WriteString(chunk)
			w.Write([]byte(chunk))
			if flusher != nil {
				flusher.Flush()
			}
		})
		addUsage(u)
		switch {
		case err == nil && full.Len() > 0:
			db.cachePut(key, full.String())
		case err != nil && r.Context().Err() == nil:
			log.Printf("ask: %v", err)
			fmt.Fprintf(w, "\n\n⚠ %v", err)
		}
	})

	http.HandleFunc("POST /api/suggest", func(w http.ResponseWriter, r *http.Request) {
		var q askReq
		if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, maxBody)).Decode(&q); err != nil {
			http.Error(w, "bad request", 400)
			return
		}
		q.Question = ""
		p, ok := providers[q.Provider]
		req, imgOK := q.llm(p.fast, suggestPrompt, true)
		if !ok || !imgOK || (strings.TrimSpace(q.Selection) == "" && q.Image == "") {
			http.Error(w, "unknown provider, bad image or empty selection", 400)
			return
		}
		key := cacheKey("suggest", q.Provider, p.fast, q.Selection, q.Context, q.Image)
		if v, ok := db.cacheGet(key); ok {
			w.Header().Set("X-Cache", "hit")
			w.Write([]byte(v))
			return
		}
		var out strings.Builder
		// suggestions use the provider's fast model: they must appear before the user starts typing
		u, err := p.ask(r.Context(), req, func(s string) { out.WriteString(s) })
		addUsage(u)
		if err != nil {
			log.Printf("suggest: %v", err)
			http.Error(w, err.Error(), 502)
			return
		}
		b, _ := json.Marshal(parseSuggestions(out.String(), 3))
		if len(b) > 2 { // don't cache an empty list
			db.cachePut(key, string(b))
		}
		w.Write(b)
	})

	ln, err := net.Listen("tcp", *addr)
	if err != nil && *addr == defaultAddr {
		// another margin is probably running on the default port; take any free one
		ln, err = net.Listen("tcp", "127.0.0.1:0")
	}
	if err != nil {
		log.Fatal(err)
	}
	url := browserURL(ln.Addr().(*net.TCPAddr))
	fmt.Println("Margin running at", url)
	if !*noOpen {
		openBrowser(url)
	}
	log.Fatal(http.Serve(ln, noStoreAPI(http.DefaultServeMux)))
}

// browserURL is the address to open. A wildcard listen address (":8080", "0.0.0.0:8080") would
// give http://[::]:8080, which browsers don't treat as a secure context, so crypto.subtle and
// crypto.randomUUID are missing; open it as 127.0.0.1 instead.
func browserURL(a *net.TCPAddr) string {
	host := a.IP.String()
	if a.IP.IsUnspecified() {
		host = "127.0.0.1"
	}
	return "http://" + net.JoinHostPort(host, strconv.Itoa(a.Port))
}

// noStoreAPI keeps the browser from caching API responses. Without it, /api/doc (served with
// Last-Modified) was heuristically cached, so a later `margin` reopened the previous run's PDF.
func noStoreAPI(h http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasPrefix(r.URL.Path, "/api/") {
			w.Header().Set("Cache-Control", "no-store")
		}
		h.ServeHTTP(w, r)
	})
}

const suggestPrompt = `You suggest questions a careful reader might ask about a highlighted passage or selected region (attached image) of a PDF.
Output exactly 3 short, specific questions (under 12 words each), one per line, no numbering, no other text.`

var listMarker = regexp.MustCompile(`^\s*(?:[-*•]|\d+[.)])\s*`)

// parseSuggestions keeps up to max question lines, stripping list markers the model may add anyway.
// Non-questions (e.g. "I don't see an image…") are dropped so they're never shown or cached.
func parseSuggestions(s string, max int) []string {
	out := []string{}
	for _, line := range strings.Split(s, "\n") {
		line = strings.TrimSpace(listMarker.ReplaceAllString(line, ""))
		if strings.HasSuffix(line, "?") && len(out) < max {
			out = append(out, line)
		}
	}
	return out
}

func contains(xs []string, s string) bool {
	for _, x := range xs {
		if x == s {
			return true
		}
	}
	return false
}

func openBrowser(url string) {
	cmd := map[string]string{"darwin": "open", "windows": "explorer"}[runtime.GOOS]
	if cmd == "" {
		cmd = "xdg-open"
	}
	exec.Command(cmd, url).Start()
}
