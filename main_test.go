package main

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"testing/iotest"
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
		{"id com barra codificada", "PUT", "/api/trips/a%2Fb", tripBody("a/b", 0, "A"), http.StatusBadRequest},
		{"JSON inválido", "PUT", "/api/trips/x", "{", http.StatusBadRequest},
		{"lixo depois do JSON", "PUT", "/api/trips/x", tripBody("x", 0, "A") + "x", http.StatusBadRequest},
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

// Uma ligação cortada a meio do corpo é um pedido inválido, não uma viagem demasiado grande.
func TestPutTripReadError(t *testing.T) {
	s := newTestServer(t)
	body := io.MultiReader(strings.NewReader(`{"baseRev":0,"trip":{"id":"x"`), iotest.ErrReader(io.ErrUnexpectedEOF))
	r := httptest.NewRequest("PUT", "/api/trips/x", body)
	r.Header.Set("X-Requested-With", "planner")
	r.AddCookie(&http.Cookie{Name: cookieName, Value: s.newToken()})
	w := httptest.NewRecorder()
	s.ServeHTTP(w, r)
	if w.Code != http.StatusBadRequest {
		t.Fatalf("código %d, esperava 400 (%s)", w.Code, w.Body)
	}
}

func TestRoutes(t *testing.T) {
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

func withHeader(k, v string) reqOpt { return func(r *http.Request) { r.Header.Set(k, v) } }

func TestTripListETag(t *testing.T) {
	s := newTestServer(t)
	tok := s.newToken()
	list := func(inm string) *httptest.ResponseRecorder {
		return call(s, "GET", "/api/trips", "", withCookie(tok), withHeader("If-None-Match", inm))
	}
	authedCall(s, "PUT", "/api/trips/x", tripBody("x", 0, "A"))

	w := list("")
	etag := w.Header().Get("ETag")
	if w.Code != http.StatusOK || etag == "" {
		t.Fatalf("primeira lista: código %d, ETag %q", w.Code, etag)
	}
	if got := decode[struct{ Trips []*record }](t, w).Trips; len(got) != 1 || got[0].Rev != 1 {
		t.Fatalf("lista inesperada: %s", w.Body)
	}
	// Ao voltar ao separador sem nada mudado: 304, sem corpo. Também com o ETag como um proxy o deixa.
	for _, inm := range []string{etag, "W/" + etag, `"` + strings.Trim(etag, `"`) + `-gzip"`, `"outro", ` + etag} {
		if w := list(inm); w.Code != http.StatusNotModified || w.Body.Len() != 0 || w.Header().Get("ETag") != etag {
			t.Errorf("If-None-Match %s: código %d, %d bytes, ETag %q", inm, w.Code, w.Body.Len(), w.Header().Get("ETag"))
		}
	}

	// Cada gravação e cada apagar mudam o ETag.
	authedCall(s, "PUT", "/api/trips/x", tripBody("x", 1, "B"))
	w = list(etag)
	if w.Code != http.StatusOK || w.Header().Get("ETag") == etag {
		t.Fatalf("depois de gravar: código %d, ETag %q igual ao anterior", w.Code, w.Header().Get("ETag"))
	}
	if !strings.Contains(w.Body.String(), `"name":"B"`) {
		t.Errorf("a lista devia ter a versão B: %s", w.Body)
	}
	etag = w.Header().Get("ETag")
	authedCall(s, "DELETE", "/api/trips/x", "")
	w = list(etag)
	if w.Code != http.StatusOK || len(decode[struct{ Trips []*record }](t, w).Trips) != 0 {
		t.Fatalf("depois de apagar: código %d, %s", w.Code, w.Body)
	}
}

func TestTripListSeesHandEdits(t *testing.T) {
	s := newTestServer(t)
	authedCall(s, "PUT", "/api/trips/x", tripBody("x", 0, "A"))
	w := authedCall(s, "GET", "/api/trips", "") // a viagem fica na cache
	etag := w.Header().Get("ETag")

	// Alguém repõe uma cópia à mão: a lista mostra o ficheiro novo e o ETag muda.
	p := s.tripPath("x")
	if err := os.WriteFile(p, []byte(`{"rev":7,"updatedAt":"","trip":{"id":"x","name":"À mão"}}`), 0o600); err != nil {
		t.Fatal(err)
	}
	later := time.Now().Add(time.Minute)
	os.Chtimes(p, later, later)
	w = call(s, "GET", "/api/trips", "", withCookie(s.newToken()), withHeader("If-None-Match", etag))
	if w.Code != http.StatusOK || !strings.Contains(w.Body.String(), "À mão") {
		t.Fatalf("a lista devia mostrar a cópia reposta: código %d, %s", w.Code, w.Body)
	}
	// e a próxima gravação parte da revisão desse ficheiro
	if w := authedCall(s, "PUT", "/api/trips/x", tripBody("x", 1, "B")); w.Code != http.StatusConflict || decode[record](t, w).Rev != 7 {
		t.Errorf("gravar sobre a revisão antiga: código %d, %s", w.Code, w.Body)
	}
	if w := authedCall(s, "PUT", "/api/trips/x", tripBody("x", 7, "B")); w.Code != http.StatusOK || decode[record](t, w).Rev != 8 {
		t.Errorf("gravar sobre a revisão 7: código %d, %s", w.Code, w.Body)
	}

	// Tirado à mão: desaparece da lista e da cache.
	os.Remove(p)
	if n := len(decode[struct{ Trips []*record }](t, authedCall(s, "GET", "/api/trips", "")).Trips); n != 0 {
		t.Errorf("a viagem tirada à mão ainda aparece (%d)", n)
	}
	if len(s.cache) != 0 || s.cacheBytes != 0 {
		t.Errorf("a cache devia ficar vazia: %d viagens, %d bytes", len(s.cache), s.cacheBytes)
	}
}

func TestTripListWithFullCache(t *testing.T) {
	old := maxCache
	maxCache = 100 // só cabe a primeira viagem: as outras vêm do disco
	defer func() { maxCache = old }()
	s := newTestServer(t)
	for _, id := range []string{"a", "b", "c"} {
		authedCall(s, "PUT", "/api/trips/"+id, tripBody(id, 0, "Viagem "+id))
	}
	w := authedCall(s, "GET", "/api/trips", "")
	got := decode[struct{ Trips []*record }](t, w).Trips
	if w.Code != http.StatusOK || len(got) != 3 {
		t.Fatalf("esperava 3 viagens, veio %d (código %d)", len(got), w.Code)
	}
	for _, rec := range got {
		var tn tripName
		json.Unmarshal(rec.Trip, &tn)
		if rec.Rev != 1 || tn.Name != "Viagem "+tn.ID {
			t.Errorf("registo errado: rev %d, %+v", rec.Rev, tn)
		}
	}
	if s.cacheBytes > maxCache {
		t.Errorf("a cache passou do limite: %d bytes", s.cacheBytes)
	}
	// Conflito com a viagem que não coube na cache: devolve o registo lido do disco.
	if w := authedCall(s, "PUT", "/api/trips/c", tripBody("c", 0, "x")); w.Code != http.StatusConflict || decode[record](t, w).Rev != 1 {
		t.Errorf("conflito: código %d, %s", w.Code, w.Body)
	}
}

func TestTripListSkipsTripsThatAreNotObjects(t *testing.T) {
	s := newTestServer(t)
	authedCall(s, "PUT", "/api/trips/ok", tripBody("ok", 0, "Boa"))
	for name, body := range map[string]string{"nula": `{"rev":1,"trip":null}`, "sem": `{"rev":1}`, "lista": `[1]`} {
		os.WriteFile(filepath.Join(s.cfg.dataDir, "trips", name+".json"), []byte(body), 0o600)
	}
	w := authedCall(s, "GET", "/api/trips", "")
	if n := len(decode[struct{ Trips []*record }](t, w).Trips); w.Code != http.StatusOK || n != 1 {
		t.Fatalf("esperava só a viagem que a página consegue abrir, veio %d: %s", n, w.Body)
	}
}

func TestEtagMatch(t *testing.T) {
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

/* ---------- página ---------- */

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

/* ---------- medições: go test -run '^$' -bench . -benchmem ---------- */

// benchTrip devolve uma viagem com n atividades (~170 bytes cada).
func benchTrip(id string, n int) string {
	var sb strings.Builder
	fmt.Fprintf(&sb, `{"id":%q,"name":"Viagem de teste","start":"2027-03-01","end":"2027-04-29","dayStart":7,"dayEnd":1,"people":3,"currency":"€","places":[],"dayPlaces":{},"tray":[],"costs":[],"blocks":[`, id)
	for i := 0; i < n; i++ {
		if i > 0 {
			sb.WriteByte(',')
		}
		fmt.Fprintf(&sb, `{"id":"a%d","date":"2027-03-%02d","start":%d,"len":90,"title":"Atividade %d no sítio","cat":"tour","status":"reservado","pp":12.5,"note":"Nota com acentuação e €"}`, i, 1+i%28, 420+i%60*15, i)
	}
	sb.WriteString("]}")
	return sb.String()
}

// GET /api/trips com 10 viagens de ~38 KB ou uma de ~1,2 MB; "304" é o refresh sem alterações.
func BenchmarkListTrips(b *testing.B) {
	for _, tc := range []struct {
		name     string
		trips, n int
		same     bool
	}{{"10x38KB", 10, 200, false}, {"1x1.2MB", 1, 7000, false}, {"10x38KB/304", 10, 200, true}} {
		b.Run(tc.name, func(b *testing.B) {
			s := newTestServer(b)
			for i := 0; i < tc.trips; i++ {
				id := fmt.Sprintf("t%d", i)
				if w := authedCall(s, "PUT", "/api/trips/"+id, `{"baseRev":0,"trip":`+benchTrip(id, tc.n)+`}`); w.Code != http.StatusOK {
					b.Fatalf("PUT: %d %s", w.Code, w.Body)
				}
			}
			tok := s.newToken()
			inm := ""
			if tc.same {
				inm = authedCall(s, "GET", "/api/trips", "").Header().Get("ETag")
			}
			b.ReportAllocs()
			b.ResetTimer()
			for i := 0; i < b.N; i++ {
				if w := call(s, "GET", "/api/trips", "", withCookie(tok), withHeader("If-None-Match", inm)); w.Code >= 400 {
					b.Fatal(w.Code)
				}
			}
		})
	}
}

// PUT de uma viagem de ~1,2 MB, com a escrita em disco (fsync incluído).
func BenchmarkPutTrip(b *testing.B) {
	s := newTestServer(b)
	trip := benchTrip("x", 7000)
	tok := s.newToken()
	b.SetBytes(int64(len(trip)))
	b.ReportAllocs()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		body := io.MultiReader(strings.NewReader(fmt.Sprintf(`{"baseRev":%d,"trip":`, i)), strings.NewReader(trip), strings.NewReader("}"))
		r := httptest.NewRequest("PUT", "/api/trips/x", body)
		r.Header.Set("X-Requested-With", "planner")
		r.AddCookie(&http.Cookie{Name: cookieName, Value: tok})
		w := httptest.NewRecorder()
		s.ServeHTTP(w, r)
		if w.Code != http.StatusOK {
			b.Fatalf("PUT %d: %d %s", i, w.Code, w.Body)
		}
	}
}
