package main

import (
	"strings"
	"testing"
)

func TestPromptFollowUp(t *testing.T) {
	q := askReq{Doc: "d.pdf", Page: 2, Selection: "x", Question: "why?"}
	if p := q.prompt(); !strings.Contains(p, "\nQuestion: why?") || strings.Contains(p, "Earlier") {
		t.Fatalf("first question prompt:\n%s", p)
	}
	q.History = []turn{{Question: "what is x?", Answer: "a variable"}}
	p := q.prompt()
	for _, want := range []string{"Earlier question: what is x?", "Your answer: a variable", "Follow-up question: why?"} {
		if !strings.Contains(p, want) {
			t.Fatalf("missing %q in:\n%s", want, p)
		}
	}
}
