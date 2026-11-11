package main

import (
	"fmt"
	"regexp"
	"strings"
	"testing"
)

// gatewayEncode follows docs/app-contract.md: `%`, control characters and non-ASCII bytes as percent-encoded UTF-8, every other byte literal.
func gatewayEncode(name string) string {
	var out strings.Builder
	for _, r := range name {
		if r == '%' || r < 0x20 || r >= 0x7f {
			for _, b := range []byte(string(r)) {
				fmt.Fprintf(&out, "%%%02X", b)
			}
		} else {
			out.WriteRune(r)
		}
	}
	return out.String()
}

func TestDisplayNameUndoesTheGatewayEncoding(t *testing.T) {
	for _, name := range []string{"alice", "审查用户", "100% real", "a+b c", "日本語 & <b>", "Ünï %41 码"} {
		if got := displayName(gatewayEncode(name)); got != name {
			t.Errorf("displayName(%q) = %q, want %q", gatewayEncode(name), got, name)
		}
	}
}

func TestDisplayNameKeepsAValueThatIsNotValidPercentEncoding(t *testing.T) {
	for _, raw := range []string{"%", "%E5%AE", "%ZZ", "%E5%AE%A1%ZZ"} {
		if got := displayName(raw); got != raw {
			t.Errorf("displayName(%q) = %q", raw, got)
		}
	}
}

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
