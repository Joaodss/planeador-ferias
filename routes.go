package main

import (
	"encoding/json"
	"io"
	"net/http"
	"regexp"
	"strings"
	"time"
)

var idRe = regexp.MustCompile(`^[A-Za-z0-9_-]{1,64}$`)

func (s *server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	h := w.Header()
	h.Set("X-Content-Type-Options", "nosniff")
	h.Set("Referrer-Policy", "no-referrer")
	h.Set("X-Frame-Options", "DENY")
	h.Set("Content-Security-Policy", "default-src 'self'; script-src 'self' https://cdnjs.cloudflare.com; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'")

	p := r.URL.Path
	switch {
	case p == "/healthz":
		io.WriteString(w, "ok")
	case strings.HasPrefix(p, "/api/"):
		s.api(w, r, strings.TrimPrefix(p, "/api/"))
	default:
		s.serveStatic(w, r)
	}
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(v)
}

func fail(w http.ResponseWriter, status int, msg string) {
	writeJSON(w, status, map[string]string{"error": msg})
}

func (s *server) api(w http.ResponseWriter, r *http.Request, path string) {
	// Pedidos que alteram dados têm de vir da própria página (defesa extra contra CSRF,
	// além do cookie SameSite=Strict).
	if r.Method != http.MethodGet && r.Header.Get("X-Requested-With") != "planner" {
		fail(w, http.StatusForbidden, "pedido recusado")
		return
	}

	switch {
	case path == "login" && r.Method == http.MethodPost:
		s.login(w, r)
		return
	case path == "logout" && r.Method == http.MethodPost:
		s.setCookie(w, r, "", -1)
		writeJSON(w, 200, map[string]bool{"ok": true})
		return
	}

	exp, ok := s.session(r)
	if !ok {
		fail(w, http.StatusUnauthorized, "sessão em falta")
		return
	}
	// Sessão deslizante: enquanto a página for usada, a validade volta aos 30 dias
	// (no máximo uma renovação por dia). Só pede login quem não abrir a página durante um mês.
	if time.Until(exp) < sessionTTL-24*time.Hour {
		s.setCookie(w, r, s.newToken(), int(sessionTTL.Seconds()))
	}

	switch {
	case path == "trips" && r.Method == http.MethodGet:
		s.listTrips(w)
	case strings.HasPrefix(path, "trips/"):
		id := strings.TrimPrefix(path, "trips/")
		if !idRe.MatchString(id) {
			fail(w, http.StatusBadRequest, "identificador inválido")
			return
		}
		switch r.Method {
		case http.MethodPut:
			s.putTrip(w, r, id)
		case http.MethodDelete:
			s.deleteTrip(w, id)
		default:
			fail(w, http.StatusMethodNotAllowed, "método não suportado")
		}
	default:
		fail(w, http.StatusNotFound, "não existe")
	}
}
