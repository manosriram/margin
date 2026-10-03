package main

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"strings"
)

// A provider streams an answer by calling emit for each text chunk.
type provider struct {
	name   string
	models []string // first is the default
	fast   string   // cheap model for background tasks like suggested questions
	ask    func(ctx context.Context, r llmReq, emit func(string)) (usage, error)
}

// usage is what one model call consumed, as reported by the provider.
type usage struct {
	In         int     `json:"in"`
	Out        int     `json:"out"`
	CacheRead  int     `json:"cacheRead"`
	CacheWrite int     `json:"cacheWrite"`
	Cost       float64 `json:"cost"` // USD at API prices (informational on a subscription)
	Calls      int     `json:"calls"`
}

func (u *usage) add(v usage) {
	u.In += v.In
	u.Out += v.Out
	u.CacheRead += v.CacheRead
	u.CacheWrite += v.CacheWrite
	u.Cost += v.Cost
	u.Calls += v.Calls
}

type llmReq struct {
	Model, System, Prompt string
	ImageType, ImageB64   string // optional image (e.g. "image/png" + base64 data)
	Quick                 bool   // skip extended thinking, for short background outputs
}

var providerOrder = []string{"claude-code"}

var providers = map[string]provider{
	"claude-code": {name: "Claude Code", models: []string{"sonnet", "opus", "haiku"}, fast: "haiku", ask: askClaudeCode},
}

// askClaudeCode shells out to the local `claude` CLI so users reuse their existing login.
func askClaudeCode(ctx context.Context, r llmReq, emit func(string)) (u usage, err error) {
	cmd := exec.CommandContext(ctx, "claude", "-p",
		"--model", r.Model,
		"--system-prompt", r.System,
		"--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--include-partial-messages",
		"--tools", "", "--strict-mcp-config", "--setting-sources", "",
		"--no-session-persistence")
	// stream-json input is the only way to hand the CLI an image without enabling file tools
	content := []any{}
	if r.ImageB64 != "" {
		content = append(content, map[string]any{"type": "image", "source": map[string]string{"type": "base64", "media_type": r.ImageType, "data": r.ImageB64}})
	}
	content = append(content, map[string]string{"type": "text", "text": r.Prompt})
	msg, _ := json.Marshal(map[string]any{"type": "user", "message": map[string]any{"role": "user", "content": content}})
	cmd.Stdin = strings.NewReader(string(msg) + "\n")
	cmd.Dir = os.TempDir() // keep CLAUDE.md/project files out of the context
	if r.Quick {
		cmd.Env = append(os.Environ(), "MAX_THINKING_TOKENS=0") // thinking made suggestions ~25s instead of ~1s
	}
	var stderr strings.Builder
	cmd.Stderr = &stderr
	out, err := cmd.StdoutPipe()
	if err != nil {
		return u, err
	}
	if err := cmd.Start(); err != nil {
		return u, fmt.Errorf("could not run `claude` — is Claude Code installed and on PATH? (%w)", err)
	}

	sc := bufio.NewScanner(out)
	sc.Buffer(make([]byte, 1<<20), 16<<20)
	var resultErr string
	for sc.Scan() {
		var ev struct {
			Type    string  `json:"type"`
			IsError bool    `json:"is_error"`
			Result  string  `json:"result"`
			Cost    float64 `json:"total_cost_usd"`
			Usage   struct {
				In         int `json:"input_tokens"`
				Out        int `json:"output_tokens"`
				CacheRead  int `json:"cache_read_input_tokens"`
				CacheWrite int `json:"cache_creation_input_tokens"`
			} `json:"usage"`
			Event struct {
				Type  string `json:"type"`
				Delta struct {
					Type string `json:"type"`
					Text string `json:"text"`
				} `json:"delta"`
			} `json:"event"`
		}
		if json.Unmarshal(sc.Bytes(), &ev) != nil {
			continue
		}
		switch {
		case ev.Type == "stream_event" && ev.Event.Delta.Type == "text_delta":
			emit(ev.Event.Delta.Text)
		case ev.Type == "result":
			u = usage{ev.Usage.In, ev.Usage.Out, ev.Usage.CacheRead, ev.Usage.CacheWrite, ev.Cost, 1}
			if ev.IsError {
				resultErr = ev.Result
			}
		}
	}
	if err := cmd.Wait(); err != nil {
		if resultErr != "" {
			return u, fmt.Errorf("%s", resultErr)
		}
		return u, fmt.Errorf("claude exited: %v %s", err, strings.TrimSpace(stderr.String()))
	}
	if resultErr != "" {
		return u, fmt.Errorf("%s", resultErr)
	}
	return u, nil
}
