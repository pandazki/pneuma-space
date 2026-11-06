package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"html/template"
	"io"
	"log"
	"net/http"
	"os"
	"os/signal"
	"regexp"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/redis/go-redis/v9"
)

var dict = map[string]map[string]string{
	"en": {
		"title": "Pulse", "counter": "Counter", "about": "Every press adds one to a total kept in the key-value store and pushed to every open tab.",
		"pulse": "Pulse", "you": "You pulse as {name}.", "anonymous": "Anonymous", "youAnonymous": "You pulse anonymously.", "signIn": "Sign in",
		"recent": "Last ten pulses", "recentAbout": "Newest first, live over server-sent events.", "who": "Who", "when": "When", "empty": "No pulses yet.",
	},
	"zh": {
		"title": "脉冲", "counter": "计数", "about": "每按一次，键值存储里的总数加一，并推送到所有打开的标签页。",
		"pulse": "按一下", "you": "你以 {name} 的身份计数。", "anonymous": "匿名", "youAnonymous": "你正在匿名计数。", "signIn": "登录",
		"recent": "最近十次", "recentAbout": "最新的在前，通过服务器推送事件实时更新。", "who": "谁", "when": "时间", "empty": "还没有人按过。",
	},
}

var shell = map[string]map[string]string{
	"en": {"language": "Language", "theme": "Theme", "light": "Light", "dark": "Dark", "footer": "Runs on PneumaSpace"},
	"zh": {"language": "语言", "theme": "主题", "light": "浅色", "dark": "深色", "footer": "运行于 PneumaSpace"},
}

type Pulse struct {
	Subject string `json:"subject"`
	Name    string `json:"name"`
	At      string `json:"at"`
}

type View struct {
	Prefix, Lang, Path, Name string
	Signed                   bool
	Total                    int64
	Recent                   []Pulse
}

var page = template.Must(template.New("page").Funcs(template.FuncMap{
	"t":     func(lang, key string) string { return dict[lang][key] },
	"s":     func(lang, key string) string { return shell[lang][key] },
	"clock": func(at string) string { return at[11:19] },
	"you":   func(lang, name string) string { return strings.ReplaceAll(dict[lang]["you"], "{name}", name) },
}).Parse(`<!doctype html>
<html lang="{{.Lang}}" data-prefix="{{.Prefix}}">
<head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>{{t .Lang "title"}}</title>
<script>try{var t=localStorage.getItem('pneuma-space-theme')}catch(e){}document.documentElement.dataset.theme=t||(matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light')</script>
<link rel="stylesheet" href="{{.Prefix}}/ui.css">
<link rel="stylesheet" href="{{.Prefix}}/app.css">
<script type="application/json" id="ui-dict">{{index $.Dict .Lang}}</script>
<script defer src="{{.Prefix}}/ui.js"></script>
<script defer src="{{.Prefix}}/app.js"></script>
</head>
<body>
<div class="frame">
<header class="top">
<h1>{{t .Lang "title"}}</h1>
<div class="controls">
<div class="seg" role="group" aria-label="{{s .Lang "language"}}"><a href="{{.Prefix}}{{.Path}}?lang=zh"{{if eq .Lang "zh"}} aria-current="true"{{end}}>中</a><a href="{{.Prefix}}{{.Path}}?lang=en"{{if eq .Lang "en"}} aria-current="true"{{end}}>EN</a></div>
<div class="seg" role="group" aria-label="{{s .Lang "theme"}}"><button type="button" data-theme-set="light" aria-label="{{s .Lang "light"}}"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><circle cx="8" cy="8" r="3"/><path d="M8 1v1.5M8 13.5V15M1 8h1.5M13.5 8H15M3 3l1 1M12 12l1 1M3 13l1-1M12 4l1-1"/></svg></button><button type="button" data-theme-set="dark" aria-label="{{s .Lang "dark"}}"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"><path d="M13.5 9.5A5.5 5.5 0 0 1 6.5 2.5a5.5 5.5 0 1 0 7 7Z"/></svg></button></div>
</div>
</header>
<main>
<section>
<header><h2>{{t .Lang "counter"}}</h2><p>{{t .Lang "about"}}</p></header>
<div class="card pulse">
<b id="total" class="total">{{.Total}}</b>
<form id="pulse" method="post" action="{{.Prefix}}/pulse"><button class="primary">{{t .Lang "pulse"}}</button></form>
<p class="hint">{{if .Signed}}{{you .Lang .Name}}{{else}}{{t .Lang "youAnonymous"}} <a href="/_pneuma-space/login?next={{.Prefix}}/">{{t .Lang "signIn"}}</a>{{end}}</p>
</div>
</section>
<section>
<header><h2>{{t .Lang "recent"}}</h2><p>{{t .Lang "recentAbout"}}</p></header>
<div class="card">
<table><thead><tr><th>{{t .Lang "who"}}</th><th class="num">{{t .Lang "when"}}</th></tr></thead>
<tbody id="recent">{{range .Recent}}<tr><td>{{if .Name}}{{.Name}}{{else}}{{t $.Lang "anonymous"}}{{end}}</td><td class="num"><time datetime="{{.At}}">{{clock .At}}</time></td></tr>{{end}}</tbody></table>
<p id="empty" class="empty"{{if .Recent}} hidden{{end}}>{{t .Lang "empty"}}</p>
</div>
</section>
</main>
<footer>{{s .Lang "footer"}}</footer>
</div><div class="badge">pneuma-space-example-site</div>
</body>
</html>`))

type pageData struct {
	View
	Dict map[string]map[string]string
}

func render(w io.Writer, v View) error {
	return page.Execute(w, pageData{v, dict})
}

var (
	langCookie = regexp.MustCompile(`(?:^|;\s*)lang=(en|zh)(?:;|$)`)
	zhFirst    = regexp.MustCompile(`(?i)^\s*zh`)
)

func pickLang(r *http.Request) string {
	if m := langCookie.FindStringSubmatch(r.Header.Get("Cookie")); m != nil {
		return m[1]
	}
	if zhFirst.MatchString(r.Header.Get("Accept-Language")) {
		return "zh"
	}
	return "en"
}

type App struct {
	rdb     *redis.Client
	prefix  string
	streams context.Context
}

func (a *App) key(name string) string { return a.prefix + name }

func (a *App) state(ctx context.Context) (int64, []Pulse, error) {
	total, err := a.rdb.Get(ctx, a.key("total")).Int64()
	if err != nil && !errors.Is(err, redis.Nil) {
		return 0, nil, err
	}
	raw, err := a.rdb.LRange(ctx, a.key("recent"), 0, 9).Result()
	recent := make([]Pulse, 0, len(raw))
	for _, item := range raw {
		var p Pulse
		if json.Unmarshal([]byte(item), &p) == nil {
			recent = append(recent, p)
		}
	}
	return total, recent, err
}

func (a *App) home(w http.ResponseWriter, r *http.Request) {
	prefix := r.Header.Get("X-Forwarded-Prefix")
	if lang := r.URL.Query().Get("lang"); lang == "zh" || lang == "en" {
		rest := r.URL.Query()
		rest.Del("lang")
		location := prefix + r.URL.Path
		if len(rest) > 0 {
			location += "?" + rest.Encode()
		}
		cookiePath := prefix
		if cookiePath == "" {
			cookiePath = "/"
		}
		w.Header().Set("Set-Cookie", fmt.Sprintf("lang=%s; Path=%s; Max-Age=31536000; SameSite=Lax", lang, cookiePath))
		http.Redirect(w, r, location, http.StatusSeeOther)
		return
	}
	total, recent, err := a.state(r.Context())
	if err != nil {
		http.Error(w, err.Error(), http.StatusServiceUnavailable)
		return
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	subject := r.Header.Get("X-Pneuma-Space-Subject")
	v := View{Prefix: prefix, Lang: pickLang(r), Path: "/", Name: r.Header.Get("X-Pneuma-Space-Name"), Signed: subject != "", Total: total, Recent: recent}
	if err := render(w, v); err != nil {
		log.Print(err)
	}
}

func (a *App) pulse(w http.ResponseWriter, r *http.Request) {
	p := Pulse{Subject: r.Header.Get("X-Pneuma-Space-Subject"), Name: r.Header.Get("X-Pneuma-Space-Name"), At: time.Now().UTC().Format(time.RFC3339Nano)}
	item, _ := json.Marshal(p)
	var total *redis.IntCmd
	_, err := a.rdb.TxPipelined(r.Context(), func(tx redis.Pipeliner) error {
		total = tx.Incr(r.Context(), a.key("total"))
		tx.LPush(r.Context(), a.key("recent"), item)
		tx.LTrim(r.Context(), a.key("recent"), 0, 9)
		return nil
	})
	if err == nil {
		event, _ := json.Marshal(map[string]any{"total": total.Val(), "pulse": p})
		err = a.rdb.Publish(r.Context(), a.key("pulses"), event).Err()
	}
	if err != nil {
		http.Error(w, err.Error(), http.StatusServiceUnavailable)
		return
	}
	http.Redirect(w, r, r.Header.Get("X-Forwarded-Prefix")+"/", http.StatusSeeOther)
}

func (a *App) stream(w http.ResponseWriter, r *http.Request) {
	sub := a.rdb.Subscribe(r.Context(), a.key("pulses"))
	defer sub.Close()
	if _, err := sub.Receive(r.Context()); err != nil {
		http.Error(w, err.Error(), http.StatusServiceUnavailable)
		return
	}
	total, _, err := a.state(r.Context())
	if err != nil {
		http.Error(w, err.Error(), http.StatusServiceUnavailable)
		return
	}
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-store")
	flusher := w.(http.Flusher)
	fmt.Fprintf(w, "data: {\"total\":%d}\n\n", total)
	flusher.Flush()
	messages := sub.Channel()
	for {
		select {
		case m := <-messages:
			fmt.Fprintf(w, "data: %s\n\n", m.Payload)
			flusher.Flush()
		case <-r.Context().Done():
			return
		case <-a.streams.Done():
			return
		}
	}
}

func main() {
	opts, err := redis.ParseURL(os.Getenv("PNEUMA_SPACE_KV_URL"))
	if err != nil {
		log.Fatal(err)
	}
	streams, closeStreams := context.WithCancel(context.Background())
	app := &App{rdb: redis.NewClient(opts), prefix: os.Getenv("PNEUMA_SPACE_KV_PREFIX"), streams: streams}
	mux := http.NewServeMux()
	mux.HandleFunc("GET /{$}", app.home)
	mux.HandleFunc("POST /pulse", app.pulse)
	mux.HandleFunc("GET /stream", app.stream)
	port := os.Getenv("PNEUMA_SPACE_PORT")
	if _, err := strconv.Atoi(port); err != nil {
		port = "8000"
	}
	srv := &http.Server{Addr: "0.0.0.0:" + port, Handler: mux}
	// Shutdown waits for idle connections, and an open event stream never idles.
	srv.RegisterOnShutdown(closeStreams)
	go func() {
		if err := srv.ListenAndServe(); !errors.Is(err, http.ErrServerClosed) {
			log.Fatal(err)
		}
	}()
	log.Printf("pulse-go on :%s", port)
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGTERM, os.Interrupt)
	defer stop()
	<-ctx.Done()
	drain, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	if err := srv.Shutdown(drain); err != nil {
		log.Print(err)
	}
	app.rdb.Close()
}
