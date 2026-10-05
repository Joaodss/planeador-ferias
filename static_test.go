package main

import (
	"errors"
	"io/fs"
	"net/http"
	"strings"
	"testing"
	"testing/fstest"
)

func TestStaticFiles(t *testing.T) {
	t.Parallel()
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
	t.Parallel()
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
	t.Parallel()
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

// fsComFalhas é um sistema de ficheiros em memória em que ler badFile ou listar badDir falha.
type fsComFalhas struct {
	fstest.MapFS
	badFile, badDir string
}

func (f fsComFalhas) ReadFile(name string) ([]byte, error) {
	if name == f.badFile {
		return nil, errors.New("erro de leitura")
	}
	return f.MapFS.ReadFile(name)
}

func (f fsComFalhas) ReadDir(name string) ([]fs.DirEntry, error) {
	if name == f.badDir {
		return nil, errors.New("erro a listar")
	}
	return f.MapFS.ReadDir(name)
}

func TestLoadStatic(t *testing.T) {
	t.Parallel()
	files := fstest.MapFS{
		"web/index.html":  {Data: []byte("<html><head></head><body></body></html>")},
		"web/js/main.js":  {Data: []byte("import './a.js';")},
		"web/js/a.js":     {Data: []byte("export {};")},
		"web/css/app.css": {Data: []byte("body{}")},
	}
	s := &server{}
	if err := s.loadStatic(files); err != nil {
		t.Fatal(err)
	}
	if len(s.static) != 4 || s.static["/css/app.css"].ctype != "text/css; charset=utf-8" {
		t.Errorf("ficheiros carregados: %v", s.static)
	}
	want := "<html><head><link rel=\"modulepreload\" href=\"js/a.js\">\n<link rel=\"modulepreload\" href=\"js/main.js\">\n</head><body></body></html>"
	if got := string(s.static["/index.html"].body); got != want {
		t.Errorf("index.html:\n%s\nesperava:\n%s", got, want)
	}

	// Sem index.html não há onde pôr os modulepreload: os outros ficheiros ficam como estão.
	delete(files, "web/index.html")
	if err := s.loadStatic(files); err != nil || len(s.static) != 3 || string(s.static["/js/a.js"].body) != "export {};" {
		t.Errorf("sem index.html: %v, %v", err, s.static)
	}

	// Um erro a ler um ficheiro ou a listar uma pasta não deixa arrancar com a página a meio.
	if err := s.loadStatic(fsComFalhas{MapFS: files, badFile: "web/js/a.js"}); err == nil {
		t.Error("um ficheiro ilegível devia dar erro")
	}
	if err := s.loadStatic(fsComFalhas{MapFS: files, badDir: "web/js"}); err == nil {
		t.Error("uma pasta ilegível devia dar erro")
	}
	if err := s.loadStatic(fstest.MapFS{}); err == nil {
		t.Error("sem a pasta web/ devia dar erro")
	}
}
