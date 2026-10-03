package main

import (
	"net"
	"testing"
)

func TestBrowserURL(t *testing.T) {
	for in, want := range map[string]string{
		"[::]:8080":         "http://127.0.0.1:8080",
		"0.0.0.0:8080":      "http://127.0.0.1:8080",
		"127.0.0.1:7889":    "http://127.0.0.1:7889",
		"192.168.1.20:8080": "http://192.168.1.20:8080",
		"[::1]:8080":        "http://[::1]:8080",
	} {
		a, err := net.ResolveTCPAddr("tcp", in)
		if err != nil {
			t.Fatal(err)
		}
		if got := browserURL(a); got != want {
			t.Errorf("browserURL(%s) = %s, want %s", in, got, want)
		}
	}
}
