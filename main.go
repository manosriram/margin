package main

import (
	"embed"
	"encoding/json"
	"flag"
	"fmt"
	"io/fs"
	"log"
	"net"
	"net/http"
	"os/exec"
	"regexp"
	"runtime"
	"strings"
)

//go:embed web
var webFS embed.FS

const systemPrompt = `You are a reading companion inside a PDF reader. The user highlighted a passage and asked a question about it.
Answer directly and concisely (usually 2-6 sentences). Use the surrounding page text for context. Plain prose; light markdown only if it truly helps.`

type askReq struct {
	Provider  string `json:"provider"`
	Model     string `json:"model"`
	Doc       string `json:"doc"`
	Page      int    `json:"page"`
	Selection string `json:"selection"`
	Context   string `json:"context"`
	Question  string `json:"question"`
}

func main() {
	addr := flag.String("addr", "127.0.0.1:7777", "listen address")
	noOpen := flag.Bool("no-open", false, "don't open the browser")
	flag.Parse()

	web, _ := fs.Sub(webFS, "web")
	http.Handle("/", http.FileServerFS(web))

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

	http.HandleFunc("POST /api/ask", func(w http.ResponseWriter, r *http.Request) {
		var q askReq
		if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20)).Decode(&q); err != nil {
			http.Error(w, "bad request", 400)
			return
		}
		p, ok := providers[q.Provider]
		if !ok || !contains(p.models, q.Model) || strings.TrimSpace(q.Question) == "" {
			http.Error(w, "unknown provider/model or empty question", 400)
			return
		}
		prompt := fmt.Sprintf("Document: %s (page %d)\n\n<page_text>\n%s\n</page_text>\n\n<highlight>\n%s\n</highlight>\n\nQuestion: %s",
			q.Doc, q.Page, q.Context, q.Selection, q.Question)

		w.Header().Set("Content-Type", "text/plain; charset=utf-8")
		w.Header().Set("X-Content-Type-Options", "nosniff")
		flusher, _ := w.(http.Flusher)
		err := p.ask(r.Context(), q.Model, systemPrompt, prompt, false, func(chunk string) {
			w.Write([]byte(chunk))
			if flusher != nil {
				flusher.Flush()
			}
		})
		if err != nil && r.Context().Err() == nil {
			log.Printf("ask: %v", err)
			fmt.Fprintf(w, "\n\n⚠ %v", err)
		}
	})

	http.HandleFunc("POST /api/suggest", func(w http.ResponseWriter, r *http.Request) {
		var q askReq
		if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20)).Decode(&q); err != nil {
			http.Error(w, "bad request", 400)
			return
		}
		p, ok := providers[q.Provider]
		if !ok || strings.TrimSpace(q.Selection) == "" {
			http.Error(w, "unknown provider or empty selection", 400)
			return
		}
		prompt := fmt.Sprintf("Document: %s (page %d)\n\n<page_text>\n%s\n</page_text>\n\n<highlight>\n%s\n</highlight>",
			q.Doc, q.Page, q.Context, q.Selection)
		var out strings.Builder
		// suggestions use the provider's fast model: they must appear before the user starts typing
		if err := p.ask(r.Context(), p.fast, suggestPrompt, prompt, true, func(s string) { out.WriteString(s) }); err != nil {
			log.Printf("suggest: %v", err)
			http.Error(w, err.Error(), 502)
			return
		}
		json.NewEncoder(w).Encode(parseSuggestions(out.String(), 3))
	})

	ln, err := net.Listen("tcp", *addr)
	if err != nil {
		log.Fatal(err)
	}
	url := "http://" + ln.Addr().String()
	fmt.Println("Margin running at", url)
	if !*noOpen {
		openBrowser(url)
	}
	log.Fatal(http.Serve(ln, nil))
}

const suggestPrompt = `You suggest questions a careful reader might ask about a highlighted passage in a PDF.
Output exactly 3 short, specific questions (under 12 words each), one per line, no numbering, no other text.`

var listMarker = regexp.MustCompile(`^\s*(?:[-*•]|\d+[.)])\s*`)

// parseSuggestions keeps up to max question lines, stripping list markers the model may add anyway.
func parseSuggestions(s string, max int) []string {
	out := []string{}
	for _, line := range strings.Split(s, "\n") {
		line = strings.TrimSpace(listMarker.ReplaceAllString(line, ""))
		if line != "" && len(out) < max {
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
