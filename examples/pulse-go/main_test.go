package main

import (
	"regexp"
	"strings"
	"testing"
)

func TestEveryLinkAndFormStartsWithThePrefix(t *testing.T) {
	var html strings.Builder
	view := View{Prefix: "/apps/pulse-go", Lang: "en", Path: "/", Recent: []Pulse{{At: "2026-11-06T00:00:00Z"}}}
	if err := render(&html, view); err != nil {
		t.Fatal(err)
	}
	urls := regexp.MustCompile(`(?:href|src|action)="([^"]*)"`).FindAllStringSubmatch(html.String(), -1)
	if len(urls) < 6 {
		t.Fatalf("found %d urls", len(urls))
	}
	for _, m := range urls {
		// The login page is the platform's, outside every app's address; its next is the app's.
		if !strings.HasPrefix(m[1], "/apps/pulse-go/") && m[1] != "/_pneuma-space/login?next=%2fapps%2fpulse-go/" {
			t.Errorf("%s does not start with the prefix", m[1])
		}
	}
}
