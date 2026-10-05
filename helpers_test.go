package main

// Funções de apoio partilhadas pelos testes do servidor (um *_test.go por ficheiro do servidor).

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
	"time"
)

const (
	testUser = "beatriz"
	testPass = "uma-palavra-passe"
)

func newTestServer(t testing.TB) *server {
	t.Helper()
	return newTestServerAt(t, t.TempDir(), testPass)
}

func newTestServerAt(t testing.TB, dir, password string) *server {
	t.Helper()
	s, err := newServer(config{user: testUser, password: password, dataDir: dir})
	if err != nil {
		t.Fatal(err)
	}
	return s
}

// tokenUntil cria um cookie de sessão válido até exp.
func tokenUntil(s *server, exp time.Time) string {
	p := strconv.FormatInt(exp.Unix(), 10)
	return p + "." + s.sign(p)
}

type reqOpt func(*http.Request)

func withCookie(v string) reqOpt {
	return func(r *http.Request) { r.AddCookie(&http.Cookie{Name: cookieName, Value: v}) }
}

func withoutCSRF(r *http.Request) { r.Header.Del("X-Requested-With") }

func withIP(ip string) reqOpt { return func(r *http.Request) { r.RemoteAddr = ip + ":1234" } }

func call(s *server, method, path, body string, opts ...reqOpt) *httptest.ResponseRecorder {
	r := httptest.NewRequest(method, path, strings.NewReader(body))
	r.Header.Set("X-Requested-With", "planner")
	if body != "" {
		r.Header.Set("Content-Type", "application/json")
	}
	for _, o := range opts {
		o(r)
	}
	w := httptest.NewRecorder()
	s.ServeHTTP(w, r)
	return w
}

// authedCall faz um pedido com uma sessão acabada de criar.
func authedCall(s *server, method, path, body string) *httptest.ResponseRecorder {
	return call(s, method, path, body, withCookie(s.newToken()))
}

func sessionCookie(w *httptest.ResponseRecorder) *http.Cookie {
	for _, c := range w.Result().Cookies() {
		if c.Name == cookieName {
			return c
		}
	}
	return nil
}

func loginBody(user, pass string) string {
	b, _ := json.Marshal(map[string]string{"user": user, "password": pass})
	return string(b)
}

func withHeader(k, v string) reqOpt { return func(r *http.Request) { r.Header.Set(k, v) } }

func tripBody(id string, baseRev int64, name string) string {
	return fmt.Sprintf(`{"baseRev":%d,"trip":{"id":%q,"name":%q}}`, baseRev, id, name)
}

func decode[T any](t *testing.T, w *httptest.ResponseRecorder) T {
	t.Helper()
	var v T
	if err := json.Unmarshal(w.Body.Bytes(), &v); err != nil {
		t.Fatalf("resposta não é JSON (%v): %s", err, w.Body.String())
	}
	return v
}

type tripName struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}
