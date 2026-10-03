package main

import (
	"crypto/sha256"
	"embed"
	"encoding/hex"
	"fmt"
	"io/fs"
	"mime"
	"net/http"
	"path/filepath"
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

func (s *server) loadStatic() error {
	s.static = map[string]staticFile{}
	return fs.WalkDir(webFS, "web", func(p string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() {
			return err
		}
		b, err := webFS.ReadFile(p)
		if err != nil {
			return err
		}
		sum := sha256.Sum256(b)
		s.static[strings.TrimPrefix(p, "web")] = staticFile{b, contentType(p), `"` + hex.EncodeToString(sum[:8]) + `"`}
		return nil
	})
}

func (s *server) serveStatic(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		http.Error(w, "método não suportado", http.StatusMethodNotAllowed)
		return
	}
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
	if r.Header.Get("If-None-Match") == f.etag {
		w.WriteHeader(http.StatusNotModified)
		return
	}
	w.Header().Set("Content-Length", fmt.Sprint(len(f.body)))
	if r.Method == http.MethodHead {
		return
	}
	w.Write(f.body)
}
