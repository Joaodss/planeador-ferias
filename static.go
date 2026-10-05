package main

import (
	"bytes"
	"crypto/sha256"
	"embed"
	"encoding/hex"
	"fmt"
	"io/fs"
	"mime"
	"net/http"
	"path/filepath"
	"slices"
	"strings"
)

//go:embed web
var webFS embed.FS

// Tipos fixos para as extensões que a página usa. mime.TypeByExtension lê o
// registo no Windows (e /etc/mime.types no Linux), que pode dar, por exemplo,
// "application/javascript" para .js; assim a resposta é igual em qualquer SO.
var staticTypes = map[string]string{
	".html":        "text/html; charset=utf-8",
	".css":         "text/css; charset=utf-8",
	".js":          "text/javascript; charset=utf-8",
	".json":        "application/json",
	".webmanifest": "application/manifest+json",
	".svg":         "image/svg+xml",
	".png":         "image/png",
	".ico":         "image/x-icon",
	".txt":         "text/plain; charset=utf-8",
}

func contentType(p string) string {
	ext := strings.ToLower(filepath.Ext(p))
	if ct, ok := staticTypes[ext]; ok {
		return ct
	}
	if ct := mime.TypeByExtension(ext); ct != "" {
		return ct
	}
	return "application/octet-stream"
}

type staticFile struct {
	body  []byte
	ctype string
	etag  string
}

func newStaticFile(b []byte, ctype string) staticFile {
	sum := sha256.Sum256(b)
	return staticFile{b, ctype, `"` + hex.EncodeToString(sum[:8]) + `"`}
}

func (s *server) loadStatic() error {
	s.static = map[string]staticFile{}
	err := fs.WalkDir(webFS, "web", func(p string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() {
			return err
		}
		b, err := webFS.ReadFile(p)
		if err != nil {
			return err
		}
		s.static[strings.TrimPrefix(p, "web")] = newStaticFile(b, contentType(p))
		return nil
	})
	if err != nil {
		return err
	}
	s.preloadModules()
	return nil
}

// preloadModules junta ao index.html um <link rel="modulepreload"> por cada módulo .js.
// Sem bundler, o browser só descobre cada import depois de receber o módulo que o contém
// (index.html → main.js → ui/*.js → trip.js → span.js: ~4 idas e voltas seguidas); assim pede-os todos
// logo. A lista sai dos ficheiros embutidos, por isso nunca fica desatualizada. Os caminhos são
// relativos, como o de js/main.js, para funcionar também atrás de um proxy com prefixo.
func (s *server) preloadModules() {
	idx, ok := s.static["/index.html"]
	if !ok {
		return
	}
	var mods []string
	for p := range s.static {
		if strings.HasSuffix(p, ".js") {
			mods = append(mods, p)
		}
	}
	slices.Sort(mods) // ordem fixa: o ETag do index.html fica igual entre arranques
	var links strings.Builder
	for _, p := range mods {
		fmt.Fprintf(&links, "<link rel=\"modulepreload\" href=\"%s\">\n", strings.TrimPrefix(p, "/"))
	}
	body := bytes.Replace(idx.body, []byte("</head>"), []byte(links.String()+"</head>"), 1)
	s.static["/index.html"] = newStaticFile(body, idx.ctype)
}

// serveStatic responde aos GET e HEAD que não são da API (o mux trata dos outros métodos).
func (s *server) serveStatic(w http.ResponseWriter, r *http.Request) {
	p := r.URL.Path
	if p == "/" {
		p = "/index.html"
	}
	f, ok := s.static[p]
	if !ok {
		http.NotFound(w, r)
		return
	}
	w.Header().Set("Content-Type", f.ctype)
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("ETag", f.etag)
	if etagMatch(r.Header.Get("If-None-Match"), f.etag) {
		w.WriteHeader(http.StatusNotModified)
		return
	}
	w.Header().Set("Content-Length", fmt.Sprint(len(f.body)))
	if r.Method == http.MethodHead {
		return
	}
	w.Write(f.body)
}
