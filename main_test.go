package main

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"
)

const (
	testUser = "beatriz"
	testPass = "uma-palavra-passe"
)

func newTestServer(t *testing.T) *server {
	t.Helper()
	return newTestServerAt(t, t.TempDir(), testPass)
}

func newTestServerAt(t *testing.T, dir, password string) *server {
	t.Helper()
	for _, d := range []string{"trips", "backups"} {
		if err := os.MkdirAll(filepath.Join(dir, d), 0o700); err != nil {
			t.Fatal(err)
		}
	}
	s := &server{cfg: config{user: testUser, password: password, dataDir: dir}, failures: map[string][]time.Time{}}
	if err := s.loadKey(); err != nil {
		t.Fatal(err)
	}
	if err := s.loadStatic(); err != nil {
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

/* ---------- login e sessões ---------- */

func TestLogin(t *testing.T) {
	s := newTestServer(t)

	w := call(s, "POST", "/api/login", loginBody(testUser, "errada-errada"))
	if w.Code != http.StatusUnauthorized {
		t.Fatalf("palavra-passe errada: código %d, esperava 401", w.Code)
	}
	if sessionCookie(w) != nil {
		t.Fatal("palavra-passe errada não pode criar sessão")
	}

	w = call(s, "POST", "/api/login", loginBody(" "+testUser+" ", testPass))
	if w.Code != http.StatusOK {
		t.Fatalf("login certo: código %d, esperava 200", w.Code)
	}
	c := sessionCookie(w)
	if c == nil {
		t.Fatal("login certo não criou cookie de sessão")
	}
	if !c.HttpOnly || c.SameSite != http.SameSiteStrictMode || c.Path != "/" {
		t.Errorf("cookie com atributos inseguros: %+v", c)
	}
	if c.MaxAge != int(sessionTTL.Seconds()) {
		t.Errorf("MaxAge = %d, esperava %d", c.MaxAge, int(sessionTTL.Seconds()))
	}
	if w := call(s, "GET", "/api/trips", "", withCookie(c.Value)); w.Code != http.StatusOK {
		t.Errorf("a sessão do login não abre as viagens: código %d", w.Code)
	}
}

func TestLoginSecureCookieBehindHTTPS(t *testing.T) {
	s := newTestServer(t)
	w := call(s, "POST", "/api/login", loginBody(testUser, testPass), func(r *http.Request) {
		r.Header.Set("X-Forwarded-Proto", "https")
	})
	if c := sessionCookie(w); c == nil || !c.Secure {
		t.Fatalf("atrás de HTTPS o cookie tem de ser Secure: %+v", c)
	}
}

func TestLoginBadRequest(t *testing.T) {
	s := newTestServer(t)
	if w := call(s, "POST", "/api/login", "isto não é JSON"); w.Code != http.StatusBadRequest {
		t.Fatalf("código %d, esperava 400", w.Code)
	}
}

func TestLoginRateLimit(t *testing.T) {
	s := newTestServer(t)
	for i := 0; i < 8; i++ {
		s.noteFailure("192.0.2.1")
	}
	if w := call(s, "POST", "/api/login", loginBody(testUser, testPass), withIP("192.0.2.1")); w.Code != http.StatusTooManyRequests {
		t.Fatalf("depois de 8 falhas: código %d, esperava 429", w.Code)
	}
	if w := call(s, "POST", "/api/login", loginBody(testUser, testPass), withIP("198.51.100.7")); w.Code != http.StatusOK {
		t.Fatalf("outro endereço não deve ficar bloqueado: código %d", w.Code)
	}

	// Limite global: 40 falhas no total bloqueiam todos.
	for i := 0; i < 40; i++ {
		s.noteFailure(fmt.Sprintf("203.0.113.%d", i))
	}
	if w := call(s, "POST", "/api/login", loginBody(testUser, testPass), withIP("198.51.100.8")); w.Code != http.StatusTooManyRequests {
		t.Fatalf("limite global: código %d, esperava 429", w.Code)
	}
}

func TestLoginFailuresExpire(t *testing.T) {
	s := newTestServer(t)
	old := time.Now().Add(-11 * time.Minute)
	for i := 0; i < 8; i++ {
		s.failures["192.0.2.1"] = append(s.failures["192.0.2.1"], old)
	}
	if s.tooManyFailures("192.0.2.1") {
		t.Fatal("falhas com mais de 10 minutos não devem contar")
	}
	if _, ok := s.failures["192.0.2.1"]; ok {
		t.Error("falhas antigas deviam ser limpas")
	}
}

func TestLogout(t *testing.T) {
	s := newTestServer(t)
	w := authedCall(s, "POST", "/api/logout", "")
	c := sessionCookie(w)
	if w.Code != http.StatusOK || c == nil || c.MaxAge >= 0 {
		t.Fatalf("logout devia apagar o cookie: código %d, cookie %+v", w.Code, c)
	}
}

func TestCSRFHeaderRequired(t *testing.T) {
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
	if w := call(s, "GET", "/api/trips", "", withCookie(tok), withoutCSRF); w.Code != http.StatusOK {
		t.Errorf("GET sem cabeçalho: código %d, esperava 200", w.Code)
	}
}

func TestSessionValidation(t *testing.T) {
	s := newTestServer(t)
	valid := tokenUntil(s, time.Now().Add(time.Hour))
	payload, _, _ := strings.Cut(valid, ".")
	cases := map[string]string{
		"sem ponto":        "abc",
		"assinatura falsa": payload + ".AAAA",
		"data alterada":    strconv.FormatInt(time.Now().Add(1000*time.Hour).Unix(), 10) + "." + strings.SplitN(valid, ".", 2)[1],
		"expirada":         tokenUntil(s, time.Now().Add(-time.Minute)),
		"payload inválido": "abc." + s.sign("abc"),
	}
	for name, tok := range cases {
		if w := call(s, "GET", "/api/trips", "", withCookie(tok)); w.Code != http.StatusUnauthorized {
			t.Errorf("%s: código %d, esperava 401", name, w.Code)
		}
	}
	if w := call(s, "GET", "/api/trips", ""); w.Code != http.StatusUnauthorized {
		t.Errorf("sem cookie: código %d, esperava 401", w.Code)
	}
	if w := call(s, "GET", "/api/trips", "", withCookie(valid)); w.Code != http.StatusOK {
		t.Errorf("sessão válida: código %d, esperava 200", w.Code)
	}
}

func TestSessionSlidingRenewal(t *testing.T) {
	s := newTestServer(t)

	// Sessão com 10 dias de validade: é renovada para 30.
	w := call(s, "GET", "/api/trips", "", withCookie(tokenUntil(s, time.Now().Add(10*24*time.Hour))))
	c := sessionCookie(w)
	if w.Code != http.StatusOK || c == nil {
		t.Fatalf("sessão antiga devia ser renovada: código %d, cookie %+v", w.Code, c)
	}
	exp, ok := s.session(&http.Request{Header: http.Header{"Cookie": {cookieName + "=" + c.Value}}})
	if !ok {
		t.Fatal("cookie renovado não é válido")
	}
	if left := time.Until(exp); left < sessionTTL-time.Minute {
		t.Errorf("cookie renovado só vale mais %v, esperava ~%v", left, sessionTTL)
	}

	// Sessão acabada de criar: não é preciso renovar.
	if c := sessionCookie(authedCall(s, "GET", "/api/trips", "")); c != nil {
		t.Errorf("sessão recente não devia ser renovada: %+v", c)
	}
}

func TestSessionSurvivesRestartButNotPasswordChange(t *testing.T) {
	dir := t.TempDir()
	s1 := newTestServerAt(t, dir, testPass)
	tok := s1.newToken()

	s2 := newTestServerAt(t, dir, testPass)
	if w := call(s2, "GET", "/api/trips", "", withCookie(tok)); w.Code != http.StatusOK {
		t.Errorf("a sessão devia sobreviver a um reinício: código %d", w.Code)
	}
	s3 := newTestServerAt(t, dir, "outra-palavra-passe")
	if w := call(s3, "GET", "/api/trips", "", withCookie(tok)); w.Code != http.StatusUnauthorized {
		t.Errorf("mudar a palavra-passe devia terminar as sessões: código %d", w.Code)
	}
}

func TestClientIP(t *testing.T) {
	r := httptest.NewRequest("GET", "/", nil)
	r.RemoteAddr = "10.0.0.1:5555"
	if got := clientIP(r); got != "10.0.0.1" {
		t.Errorf("clientIP = %q, esperava 10.0.0.1", got)
	}
	r.Header.Set("X-Forwarded-For", " 203.0.113.9 , 10.0.0.1")
	if got := clientIP(r); got != "203.0.113.9" {
		t.Errorf("clientIP com X-Forwarded-For = %q, esperava 203.0.113.9", got)
	}
}

/* ---------- viagens ---------- */

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

func TestTripLifecycle(t *testing.T) {
	s := newTestServer(t)
	dir := s.cfg.dataDir

	w := authedCall(s, "PUT", "/api/trips/x", tripBody("x", 0, "A"))
	if w.Code != http.StatusOK || decode[record](t, w).Rev != 1 {
		t.Fatalf("criar: código %d, %s", w.Code, w.Body)
	}

	// Outro dispositivo grava com base antiga: conflito com a versão atual.
	w = authedCall(s, "PUT", "/api/trips/x", tripBody("x", 0, "conflito"))
	if w.Code != http.StatusConflict {
		t.Fatalf("conflito: código %d, esperava 409", w.Code)
	}
	cur := decode[record](t, w)
	var tn tripName
	json.Unmarshal(cur.Trip, &tn)
	if cur.Rev != 1 || tn.Name != "A" {
		t.Errorf("o conflito devia devolver a rev 1 com nome A, veio rev %d nome %q", cur.Rev, tn.Name)
	}

	w = authedCall(s, "PUT", "/api/trips/x", tripBody("x", 1, "B"))
	if w.Code != http.StatusOK || decode[record](t, w).Rev != 2 {
		t.Fatalf("atualizar: código %d, %s", w.Code, w.Body)
	}
	backup := filepath.Join(dir, "backups", "x", time.Now().UTC().Format("2006-01-02")+".json")
	if b, err := os.ReadFile(backup); err != nil || !strings.Contains(string(b), `"name":"A"`) {
		t.Errorf("devia existir uma cópia do dia com a versão A: %v %s", err, b)
	}

	w = authedCall(s, "GET", "/api/trips", "")
	list := decode[struct {
		User  string    `json:"user"`
		Trips []*record `json:"trips"`
	}](t, w)
	if list.User != testUser || len(list.Trips) != 1 || list.Trips[0].Rev != 2 {
		t.Fatalf("lista inesperada: %s", w.Body)
	}

	// Apagar move o ficheiro para as cópias, não o elimina.
	if w := authedCall(s, "DELETE", "/api/trips/x", ""); w.Code != http.StatusOK {
		t.Fatalf("apagar: código %d", w.Code)
	}
	if _, err := os.Stat(s.tripPath("x")); !os.IsNotExist(err) {
		t.Error("a viagem apagada ainda está em trips/")
	}
	entries, _ := os.ReadDir(filepath.Join(dir, "backups", "x"))
	found := false
	for _, e := range entries {
		found = found || strings.HasPrefix(e.Name(), "apagada-")
	}
	if !found {
		t.Error("a viagem apagada devia ficar em backups/x/apagada-*.json")
	}

	// Gravar uma viagem que foi apagada noutro dispositivo.
	w = authedCall(s, "PUT", "/api/trips/x", tripBody("x", 2, "C"))
	if w.Code != http.StatusConflict || !decode[struct{ Deleted bool }](t, w).Deleted {
		t.Errorf("gravar viagem apagada: código %d, %s", w.Code, w.Body)
	}

	// Apagar duas vezes não é erro.
	if w := authedCall(s, "DELETE", "/api/trips/x", ""); w.Code != http.StatusOK {
		t.Errorf("apagar de novo: código %d", w.Code)
	}
}

func TestTripListSkipsUnreadableFiles(t *testing.T) {
	s := newTestServer(t)
	authedCall(s, "PUT", "/api/trips/ok", tripBody("ok", 0, "Boa"))
	os.WriteFile(filepath.Join(s.cfg.dataDir, "trips", "estragada.json"), []byte("{"), 0o600)
	os.WriteFile(filepath.Join(s.cfg.dataDir, "trips", "notas.txt"), []byte("x"), 0o600)
	w := authedCall(s, "GET", "/api/trips", "")
	if n := len(decode[struct{ Trips []*record }](t, w).Trips); w.Code != http.StatusOK || n != 1 {
		t.Fatalf("esperava 1 viagem legível, veio %d (código %d)", n, w.Code)
	}
}

func TestTripValidation(t *testing.T) {
	s := newTestServer(t)
	huge := `{"baseRev":0,"trip":{"id":"x","note":"` + strings.Repeat("a", maxBody) + `"}}`
	for _, tc := range []struct {
		name, method, path, body string
		want                     int
	}{
		{"id diferente do caminho", "PUT", "/api/trips/x", tripBody("y", 0, "A"), http.StatusBadRequest},
		{"id com caracteres proibidos", "PUT", "/api/trips/a.b", tripBody("a.b", 0, "A"), http.StatusBadRequest},
		{"id demasiado longo", "PUT", "/api/trips/" + strings.Repeat("a", 65), "{}", http.StatusBadRequest},
		{"JSON inválido", "PUT", "/api/trips/x", "{", http.StatusBadRequest},
		{"viagem sem objeto", "PUT", "/api/trips/x", `{"baseRev":0}`, http.StatusBadRequest},
		{"demasiado grande", "PUT", "/api/trips/x", huge, http.StatusRequestEntityTooLarge},
		{"método errado", "POST", "/api/trips/x", "{}", http.StatusMethodNotAllowed},
		{"caminho desconhecido", "GET", "/api/nada", "", http.StatusNotFound},
	} {
		if w := authedCall(s, tc.method, tc.path, tc.body); w.Code != tc.want {
			t.Errorf("%s: código %d, esperava %d (%s)", tc.name, w.Code, tc.want, w.Body)
		}
	}
	if entries, _ := os.ReadDir(filepath.Join(s.cfg.dataDir, "trips")); len(entries) != 0 {
		t.Errorf("pedidos inválidos não podem gravar nada, encontrei %d ficheiros", len(entries))
	}
}

func TestBackupRetention(t *testing.T) {
	s := newTestServer(t)
	dir := filepath.Join(s.cfg.dataDir, "backups", "x")
	os.MkdirAll(dir, 0o700)
	start := time.Date(2020, 1, 1, 0, 0, 0, 0, time.UTC)
	for i := 0; i < backupsKept+5; i++ {
		os.WriteFile(filepath.Join(dir, start.AddDate(0, 0, i).Format("2006-01-02")+".json"), []byte("{}"), 0o600)
	}
	os.WriteFile(filepath.Join(dir, "apagada-2019-01-01T000000Z.json"), []byte("{}"), 0o600)
	src := filepath.Join(s.cfg.dataDir, "trips", "x.json")
	os.WriteFile(src, []byte(`{"rev":1}`), 0o600)

	s.backup("x", src)

	entries, _ := os.ReadDir(dir)
	daily, deleted := 0, 0
	for _, e := range entries {
		if strings.HasPrefix(e.Name(), "apagada-") {
			deleted++
		} else {
			daily++
		}
	}
	if daily != backupsKept {
		t.Errorf("ficaram %d cópias diárias, esperava %d", daily, backupsKept)
	}
	if deleted != 1 {
		t.Error("as viagens apagadas nunca podem ser removidas pela limpeza")
	}
	if _, err := os.Stat(filepath.Join(dir, start.Format("2006-01-02")+".json")); !os.IsNotExist(err) {
		t.Error("a cópia mais antiga devia ter sido removida")
	}
}

/* ---------- página ---------- */

func TestStaticFiles(t *testing.T) {
	s := newTestServer(t)

	w := call(s, "GET", "/", "")
	if w.Code != http.StatusOK || !strings.HasPrefix(w.Header().Get("Content-Type"), "text/html") {
		t.Fatalf("/: código %d, tipo %q", w.Code, w.Header().Get("Content-Type"))
	}
	if !strings.Contains(w.Body.String(), `src="i18n.js"`) {
		t.Error("index.html devia carregar i18n.js")
	}
	etag := w.Header().Get("ETag")
	if etag == "" {
		t.Fatal("falta ETag")
	}
	if w := call(s, "GET", "/", "", func(r *http.Request) { r.Header.Set("If-None-Match", etag) }); w.Code != http.StatusNotModified {
		t.Errorf("If-None-Match: código %d, esperava 304", w.Code)
	}

	for _, p := range []string{"/app.js", "/i18n.js", "/app.css"} {
		if w := call(s, "GET", p, ""); w.Code != http.StatusOK || w.Body.Len() == 0 {
			t.Errorf("%s: código %d", p, w.Code)
		}
	}
	if w := call(s, "HEAD", "/app.js", ""); w.Code != http.StatusOK || w.Body.Len() != 0 {
		t.Errorf("HEAD: código %d, corpo com %d bytes", w.Code, w.Body.Len())
	}
	if w := call(s, "GET", "/nao-existe.js", ""); w.Code != http.StatusNotFound {
		t.Errorf("ficheiro inexistente: código %d", w.Code)
	}
	if w := call(s, "POST", "/", ""); w.Code != http.StatusMethodNotAllowed {
		t.Errorf("POST /: código %d", w.Code)
	}
}

func TestSecurityHeaders(t *testing.T) {
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
	s := newTestServer(t)
	if w := call(s, "GET", "/healthz", ""); w.Code != http.StatusOK || w.Body.String() != "ok" {
		t.Fatalf("healthz: código %d, corpo %q", w.Code, w.Body)
	}
}

func TestSessionSecretPersisted(t *testing.T) {
	dir := t.TempDir()
	newTestServerAt(t, dir, testPass)
	info, err := os.Stat(filepath.Join(dir, ".session-secret"))
	if err != nil {
		t.Fatal(err)
	}
	if info.Size() < 32 {
		t.Errorf("segredo das sessões curto demais: %d bytes", info.Size())
	}
}
