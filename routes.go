package main

import (
	"encoding/json"
	"io"
	"log"
	"net/http"
	"regexp"
	"strings"
)

// tripIDRe: os identificadores de viagem que o servidor aceita no caminho (e no nome do ficheiro).
// clean.js exporta a mesma expressão como ID.
var tripIDRe = regexp.MustCompile(`^[A-Za-z0-9_-]{1,64}$`)

const csp = "default-src 'self'; script-src 'self' https://cdnjs.cloudflare.com; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'"

// routes monta o encaminhamento com os padrões do http.ServeMux (método, caminho e {id}).
// O próprio mux responde 404 aos caminhos desconhecidos e 405 (com Allow) aos métodos que um caminho
// não tem. Um GET também aceita HEAD.
func (s *server) routes() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, _ *http.Request) { io.WriteString(w, "ok") })
	mux.HandleFunc("POST /api/login", s.login)
	mux.HandleFunc("POST /api/logout", s.logout)
	mux.Handle("GET /api/trips", s.requireSession(s.listTrips))
	mux.Handle("PUT /api/trips/{id}", s.requireSession(tripHandler(s.putTrip)))
	mux.Handle("DELETE /api/trips/{id}", s.requireSession(tripHandler(s.deleteTrip)))
	mux.HandleFunc("GET /", s.serveStatic)
	return secHeaders(csrfGuard(mux))
}

// ServeHTTP faz do server um http.Handler: main e os testes chamam-no diretamente, sem conhecer as rotas.
func (s *server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	s.handler.ServeHTTP(w, r)
}

// secHeaders junta os cabeçalhos de segurança a todas as respostas, também aos 404 e 405 do mux.
func secHeaders(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		h := w.Header()
		h.Set("X-Content-Type-Options", "nosniff")
		h.Set("Referrer-Policy", "no-referrer")
		h.Set("X-Frame-Options", "DENY")
		h.Set("Content-Security-Policy", csp)
		next.ServeHTTP(w, r)
	})
}

// csrfGuard recusa os pedidos que alteram dados sem o cabeçalho X-Requested-With da própria página
// (defesa extra contra CSRF, além do cookie SameSite=Strict): um formulário noutro site não o consegue enviar.
func csrfGuard(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet && r.Method != http.MethodHead && r.Header.Get("X-Requested-With") != "planner" {
			writeError(w, http.StatusForbidden, "pedido recusado")
			return
		}
		next.ServeHTTP(w, r)
	})
}

// requireSession só deixa passar pedidos com sessão válida. A sessão é deslizante: enquanto a página
// for usada, a validade volta a sessionTTL (no máximo uma renovação por sessionRenewEvery). Só pede login
// quem não abrir a página durante um mês.
func (s *server) requireSession(next http.HandlerFunc) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		exp, ok := s.session(r)
		if !ok {
			writeError(w, http.StatusUnauthorized, "sessão em falta")
			return
		}
		if exp.Sub(s.now()) < sessionTTL-sessionRenewEvery {
			s.setCookie(w, r, s.newToken(), int(sessionTTL.Seconds()))
		}
		next(w, r)
	})
}

// tripHandler confirma que o {id} do caminho é um identificador de viagem antes de chamar h.
func tripHandler(h func(http.ResponseWriter, *http.Request, string)) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id := r.PathValue("id")
		if !tripIDRe.MatchString(id) {
			writeError(w, http.StatusBadRequest, "identificador inválido")
			return
		}
		h(w, r, id)
	}
}

// writeJSON responde v em JSON com o código status, sem cache (as respostas da API mudam a cada gravação).
// Um erro ao codificar só fica no log: o código de estado já foi enviado e não há como avisar a página.
func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	if err := json.NewEncoder(w).Encode(v); err != nil {
		log.Printf("aviso: resposta JSON por enviar: %v", err)
	}
}

// writeError responde {"error": msg} com o código status. A página só mostra a mensagem em casos raros:
// quase sempre decide pelo código.
func writeError(w http.ResponseWriter, status int, msg string) {
	writeJSON(w, status, map[string]string{"error": msg})
}

// writeRawJSON responde com JSON que já está em bytes (um registo lido do disco).
func writeRawJSON(w http.ResponseWriter, status int, b []byte) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	w.Write(b)
}

// etagMatch diz se o If-None-Match do pedido inclui etag. A comparação é fraca (RFC 9110): ignora o W/
// e também o sufixo "-gzip"/"-zstd" que um proxy como o Caddy junta ao ETag quando comprime a resposta.
func etagMatch(inm, etag string) bool {
	want := strings.Trim(etag, `"`)
	for _, v := range strings.Split(inm, ",") {
		v = strings.Trim(strings.TrimPrefix(strings.TrimSpace(v), "W/"), `"`)
		if v, _, _ = strings.Cut(v, "-"); v == want {
			return true
		}
	}
	return false
}
