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
	// quick: skip extended thinking, for short background outputs
	ask func(ctx context.Context, model, system, prompt string, quick bool, emit func(string)) error
}

var providerOrder = []string{"claude-code"}

var providers = map[string]provider{
	"claude-code": {name: "Claude Code", models: []string{"sonnet", "opus", "haiku"}, fast: "haiku", ask: askClaudeCode},
}

// askClaudeCode shells out to the local `claude` CLI so users reuse their existing login.
func askClaudeCode(ctx context.Context, model, system, prompt string, quick bool, emit func(string)) error {
	cmd := exec.CommandContext(ctx, "claude", "-p",
		"--model", model,
		"--system-prompt", system,
		"--output-format", "stream-json", "--verbose", "--include-partial-messages",
		"--tools", "", "--strict-mcp-config", "--setting-sources", "",
		"--no-session-persistence")
	cmd.Stdin = strings.NewReader(prompt)
	cmd.Dir = os.TempDir() // keep CLAUDE.md/project files out of the context
	if quick {
		cmd.Env = append(os.Environ(), "MAX_THINKING_TOKENS=0") // thinking made suggestions ~25s instead of ~1s
	}
	var stderr strings.Builder
	cmd.Stderr = &stderr
	out, err := cmd.StdoutPipe()
	if err != nil {
		return err
	}
	if err := cmd.Start(); err != nil {
		return fmt.Errorf("could not run `claude` — is Claude Code installed and on PATH? (%w)", err)
	}

	sc := bufio.NewScanner(out)
	sc.Buffer(make([]byte, 1<<20), 16<<20)
	var resultErr string
	for sc.Scan() {
		var ev struct {
			Type    string `json:"type"`
			IsError bool   `json:"is_error"`
			Result  string `json:"result"`
			Event   struct {
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
		case ev.Type == "result" && ev.IsError:
			resultErr = ev.Result
		}
	}
	if err := cmd.Wait(); err != nil {
		if resultErr != "" {
			return fmt.Errorf("%s", resultErr)
		}
		return fmt.Errorf("claude exited: %v %s", err, strings.TrimSpace(stderr.String()))
	}
	if resultErr != "" {
		return fmt.Errorf("%s", resultErr)
	}
	return nil
}
