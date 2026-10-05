package main

import (
	"log"
	"math"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
)

func TestCSRFHeaderRequired(t *testing.T) {
	t.Parallel()
	s := newTestServer(t)
	tok := s.newToken()
	for _, tc := range []struct{ method, path, body string }{
		{"POST", "/api/login", loginBody(testUser, testPass)},
		{"POST", "/api/logout", ""},
		{"PUT", "/api/trips/x", `{"baseRev":0,"trip":{"id":"x"}}`},
		{"DELETE", "/api/trips/x", ""},
	} {
		w := call(s, tc.method, tc.path, tc.body, withCookie(tok), withoutCSRF)
		if w.Code != http.StatusForbidden {
			t.Errorf("%s %s sem X-Requested-With: código %d, esperava 403", tc.method, tc.path, w.Code)
		}
	}
	// Leituras não precisam do cabeçalho.
	for _, m := range []string{"GET", "HEAD"} {
		if w := call(s, m, "/api/trips", "", withCookie(tok), withoutCSRF); w.Code != http.StatusOK {
			t.Errorf("%s sem cabeçalho: código %d, esperava 200", m, w.Code)
		}
	}
}

func TestTripIDValidation(t *testing.T) {
	t.Parallel()
	s := newTestServer(t)
	for _, tc := range []struct {
		id   string
		want int
	}{
		{strings.Repeat("a", 64), http.StatusOK},
		{strings.Repeat("b", 65), http.StatusBadRequest},
		{"A-z_09", http.StatusOK},
		{"a.b", http.StatusBadRequest},
		{"á", http.StatusBadRequest},
	} {
		if w := authedCall(s, "PUT", "/api/trips/"+tc.id, tripBody(tc.id, 0, "A")); w.Code != tc.want {
			t.Errorf("id %q (%d caracteres): código %d, esperava %d", tc.id, len(tc.id), w.Code, tc.want)
		}
	}
}

// Um valor que não dá JSON fica registado no log e não rebenta o servidor.
// Sem t.Parallel: o writeJSON escreve no log global, que este teste troca por um buffer.
func TestWriteJSONEncodeError(t *testing.T) {
	var logs strings.Builder
	log.SetOutput(&logs)
	defer log.SetOutput(os.Stderr)
	w := httptest.NewRecorder()
	writeJSON(w, http.StatusOK, map[string]float64{"x": math.Inf(1)})
	if w.Code != http.StatusOK || !strings.Contains(logs.String(), "resposta JSON por enviar") {
		t.Errorf("código %d, log %q", w.Code, logs.String())
	}
}

func TestRoutes(t *testing.T) {
	t.Parallel()
	s := newTestServer(t)
	for _, tc := range []struct {
		method, path string
		want         int
		allow        []string // métodos que têm de vir em Allow num 405
	}{
		{"PATCH", "/api/trips/x", http.StatusMethodNotAllowed, []string{"PUT", "DELETE"}},
		{"POST", "/api/trips", http.StatusMethodNotAllowed, []string{"GET"}},
		{"PUT", "/api/login", http.StatusMethodNotAllowed, []string{"POST"}},
		{"DELETE", "/healthz", http.StatusMethodNotAllowed, []string{"GET", "HEAD"}},
		{"HEAD", "/healthz", http.StatusOK, nil},
		{"GET", "/api/nada", http.StatusNotFound, nil},
	} {
		w := authedCall(s, tc.method, tc.path, "")
		if w.Code != tc.want {
			t.Errorf("%s %s: código %d, esperava %d", tc.method, tc.path, w.Code, tc.want)
		}
		for _, m := range tc.allow {
			if allow := w.Header().Get("Allow"); !strings.Contains(allow, m) {
				t.Errorf("%s %s: Allow %q sem %s", tc.method, tc.path, allow, m)
			}
		}
		// as respostas do próprio mux também levam os cabeçalhos de segurança
		if h := w.Header(); h.Get("X-Frame-Options") != "DENY" || h.Get("Content-Security-Policy") == "" {
			t.Errorf("%s %s: faltam cabeçalhos de segurança", tc.method, tc.path)
		}
	}
}

func TestEtagMatch(t *testing.T) {
	t.Parallel()
	for inm, want := range map[string]bool{
		`"abc"`:            true,
		`W/"abc"`:          true,
		`"abc-zstd"`:       true,
		`"x", W/"abc"`:     true,
		``:                 false,
		`"abcd"`:           false,
		`"ab"`:             false,
		`"zz-abc"`:         false,
		`*`:                false,
		`"abc"junk, "def"`: false,
	} {
		if got := etagMatch(inm, `"abc"`); got != want {
			t.Errorf("etagMatch(%q) = %v, esperava %v", inm, got, want)
		}
	}
}

func TestSecurityHeaders(t *testing.T) {
	t.Parallel()
	s := newTestServer(t)
	for _, p := range []string{"/", "/api/trips", "/healthz"} {
		h := call(s, "GET", p, "").Header()
		for k, want := range map[string]string{
			"X-Content-Type-Options": "nosniff",
			"X-Frame-Options":        "DENY",
			"Referrer-Policy":        "no-referrer",
		} {
			if h.Get(k) != want {
				t.Errorf("%s: %s = %q, esperava %q", p, k, h.Get(k), want)
			}
		}
		if csp := h.Get("Content-Security-Policy"); !strings.Contains(csp, "default-src 'self'") || !strings.Contains(csp, "frame-ancestors 'none'") {
			t.Errorf("%s: CSP fraca: %q", p, csp)
		}
	}
	if cc := authedCall(s, "GET", "/api/trips", "").Header().Get("Cache-Control"); cc != "no-store" {
		t.Errorf("respostas da API não podem ficar em cache: %q", cc)
	}
}

func TestHealthz(t *testing.T) {
	t.Parallel()
	s := newTestServer(t)
	if w := call(s, "GET", "/healthz", ""); w.Code != http.StatusOK || w.Body.String() != "ok" {
		t.Fatalf("healthz: código %d, corpo %q", w.Code, w.Body)
	}
}
