package main

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// Fakes the `claude` CLI on PATH and checks we only emit text deltas and surface errors.
func TestAskClaudeCode(t *testing.T) {
	dir := t.TempDir()
	script := `#!/bin/sh
cat >/dev/null
echo '{"type":"system","subtype":"init"}'
echo '{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"thinking_delta","thinking":"hmm"}}}'
echo '{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"Hello"}}}'
echo 'not json'
echo '{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":", world"}}}'
if [ "$3" = "bad" ]; then echo '{"type":"result","is_error":true,"result":"model not found"}'; exit 1; fi
echo '{"type":"result","is_error":false,"result":"Hello, world","total_cost_usd":0.5,"usage":{"input_tokens":10,"output_tokens":4,"cache_read_input_tokens":100,"cache_creation_input_tokens":7}}'
`
	os.WriteFile(filepath.Join(dir, "claude"), []byte(script), 0o755)
	t.Setenv("PATH", dir+":"+os.Getenv("PATH"))

	var got strings.Builder
	u, err := askClaudeCode(context.Background(), llmReq{Model: "haiku", System: "sys", Prompt: "q"}, func(s string) { got.WriteString(s) })
	if err != nil {
		t.Fatal(err)
	}
	if (u != usage{In: 10, Out: 4, CacheRead: 100, CacheWrite: 7, Cost: 0.5, Calls: 1}) {
		t.Fatalf("usage: %+v", u)
	}
	if got.String() != "Hello, world" {
		t.Fatalf("got %q", got.String())
	}

	if s := parseSuggestions("Sure:\n1. Why grow?\n\n- What is d_k?\n• How scale?\nExtra one?", 3); strings.Join(s, "|") != "Why grow?|What is d_k?|How scale?" {
		t.Fatalf("parseSuggestions: %q", s)
	}
	if s := parseSuggestions("3D or 2D here?", 3); s[0] != "3D or 2D here?" {
		t.Fatalf("parseSuggestions: %q", s)
	}

	if s := parseSuggestions("I don't see an attached image. Could you share it.", 3); len(s) != 0 {
		t.Fatalf("refusal kept: %q", s)
	}

	_, err = askClaudeCode(context.Background(), llmReq{Model: "bad", System: "sys", Prompt: "q"}, func(string) {})
	if err == nil || !strings.Contains(err.Error(), "model not found") {
		t.Fatalf("want model error, got %v", err)
	}
}
