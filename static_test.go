package main

import (
	"net/http"
	"strings"
	"testing"
)

func TestStaticFiles(t *testing.T) {
	s := newTestServer(t)

	w := call(s, "GET", "/", "")
	if w.Code != http.StatusOK || !strings.HasPrefix(w.Header().Get("Content-Type"), "text/html") {
		t.Fatalf("/: código %d, tipo %q", w.Code, w.Header().Get("Content-Type"))
	}
	if !strings.Contains(w.Body.String(), `<script type="module" src="js/main.js">`) {
		t.Error("index.html devia carregar js/main.js como módulo")
	}
	etag := w.Header().Get("ETag")
	if etag == "" {
		t.Fatal("falta ETag")
	}
	if w := call(s, "GET", "/", "", func(r *http.Request) { r.Header.Set("If-None-Match", etag) }); w.Code != http.StatusNotModified {
		t.Errorf("If-None-Match: código %d, esperava 304", w.Code)
	}

	for _, p := range []string{"/js/main.js", "/js/i18n.js", "/js/tz.js", "/js/ui/board.js", "/css/app.css"} {
		if w := call(s, "GET", p, ""); w.Code != http.StatusOK || w.Body.Len() == 0 {
			t.Errorf("%s: código %d", p, w.Code)
		}
	}
	// O browser recusa módulos ES que não venham como JavaScript. Os tipos são
	// fixos para não dependerem do registo do Windows nem de /etc/mime.types.
	for p, want := range map[string]string{
		"/":            "text/html; charset=utf-8",
		"/js/main.js":  "text/javascript; charset=utf-8",
		"/css/app.css": "text/css; charset=utf-8",
	} {
		if ct := call(s, "GET", p, "").Header().Get("Content-Type"); ct != want {
			t.Errorf("%s: tipo %q, esperava %q", p, ct, want)
		}
	}
	if w := call(s, "HEAD", "/js/main.js", ""); w.Code != http.StatusOK || w.Body.Len() != 0 {
		t.Errorf("HEAD: código %d, corpo com %d bytes", w.Code, w.Body.Len())
	}
	if w := call(s, "GET", "/nao-existe.js", ""); w.Code != http.StatusNotFound {
		t.Errorf("ficheiro inexistente: código %d", w.Code)
	}
	if w := call(s, "POST", "/", ""); w.Code != http.StatusMethodNotAllowed {
		t.Errorf("POST /: código %d", w.Code)
	}
}

func TestStaticModulePreload(t *testing.T) {
	s := newTestServer(t)
	body := call(s, "GET", "/", "").Body.String()
	head, _, ok := strings.Cut(body, "</head>")
	if !ok {
		t.Fatal("index.html sem </head>")
	}
	// Todos os módulos são pedidos logo, em vez de um nível de imports de cada vez.
	n := 0
	for p := range s.static {
		if strings.HasSuffix(p, ".js") {
			n++
			if link := `<link rel="modulepreload" href="` + strings.TrimPrefix(p, "/") + `">`; !strings.Contains(head, link) {
				t.Errorf("falta %s no <head>", link)
			}
		}
	}
	if n < 10 || strings.Count(body, "modulepreload") != n {
		t.Errorf("%d módulos, %d modulepreload", n, strings.Count(body, "modulepreload"))
	}
	// A ordem é fixa: o ETag não muda entre arranques.
	if a, b := s.static["/index.html"].etag, newTestServer(t).static["/index.html"].etag; a != b {
		t.Errorf("ETag do index.html muda entre arranques: %s, %s", a, b)
	}
}

func TestContentType(t *testing.T) {
	for p, want := range map[string]string{
		"web/js/main.js":       "text/javascript; charset=utf-8",
		"web/IMG/LOGO.PNG":     "image/png", // extensão em maiúsculas
		"web/app.webmanifest":  "application/manifest+json",
		"web/guia.pdf":         "application/pdf", // fora da tabela: vem do mime
		"web/dados.extensaox9": "application/octet-stream",
		"web/LEIA-ME":          "application/octet-stream",
	} {
		if got := contentType(p); got != want {
			t.Errorf("contentType(%q) = %q, esperava %q", p, got, want)
		}
	}
}
