package main

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"testing"
	"time"
)

func TestLogin(t *testing.T) {
	t.Parallel()
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
	t.Parallel()
	s := newTestServer(t)
	w := call(s, "POST", "/api/login", loginBody(testUser, testPass), func(r *http.Request) {
		r.Header.Set("X-Forwarded-Proto", "https")
	})
	if c := sessionCookie(w); c == nil || !c.Secure {
		t.Fatalf("atrás de HTTPS o cookie tem de ser Secure: %+v", c)
	}
}

func TestLoginBadRequest(t *testing.T) {
	t.Parallel()
	s := newTestServer(t)
	for _, tc := range []struct {
		name, body string
		want       int
	}{
		{"não é JSON", "isto não é JSON", http.StatusBadRequest},
		{"corpo acima de maxLoginBytes", loginBody(testUser, strings.Repeat("a", maxLoginBytes)), http.StatusBadRequest},
		{"campos em falta", `{}`, http.StatusUnauthorized},
		{"só o utilizador", `{"user":"` + testUser + `"}`, http.StatusUnauthorized},
	} {
		w := call(s, "POST", "/api/login", tc.body)
		if w.Code != tc.want || sessionCookie(w) != nil {
			t.Errorf("%s: código %d, esperava %d sem cookie", tc.name, w.Code, tc.want)
		}
	}
}

func TestLoginRateLimit(t *testing.T) {
	t.Parallel()
	s := newTestServer(t)
	clk := withClock(s, time.Date(2027, 7, 5, 12, 0, 0, 0, time.UTC))
	login := func(ip, pass string) int {
		return call(s, "POST", "/api/login", loginBody(testUser, pass), withIP(ip)).Code
	}
	for i := 0; i < maxFailuresPerIP; i++ {
		if code := login("192.0.2.1", "errada-errada"); code != http.StatusUnauthorized {
			t.Fatalf("falha %d: código %d, esperava 401", i+1, code)
		}
	}
	if code := login("192.0.2.1", testPass); code != http.StatusTooManyRequests {
		t.Fatalf("depois de %d falhas, mesmo com a palavra-passe certa: código %d, esperava 429", maxFailuresPerIP, code)
	}
	if code := login("198.51.100.7", testPass); code != http.StatusOK {
		t.Fatalf("outro endereço não deve ficar bloqueado: código %d", code)
	}

	// A janela é failureWindow (10 minutos), contada desde cada falha.
	clk.add(failureWindow - time.Second)
	if code := login("192.0.2.1", testPass); code != http.StatusTooManyRequests {
		t.Errorf("9:59 depois: código %d, esperava 429", code)
	}
	clk.add(time.Second)
	if code := login("192.0.2.1", testPass); code != http.StatusOK {
		t.Errorf("10 minutos depois: código %d, esperava 200", code)
	}
	if _, ok := s.failures["192.0.2.1"]; ok {
		t.Error("as falhas antigas deviam ser limpas")
	}

	// Limite global: maxFailuresTotal falhas no total, de endereços diferentes, bloqueiam todos.
	for i := 0; i < maxFailuresTotal; i++ {
		login(fmt.Sprintf("203.0.113.%d", i), "errada-errada")
	}
	if code := login("198.51.100.8", testPass); code != http.StatusTooManyRequests {
		t.Fatalf("limite global: código %d, esperava 429", code)
	}
}

// A espera de failDelay só acontece nos logins falhados.
func TestLoginFailDelay(t *testing.T) {
	t.Parallel()
	s := newTestServer(t)
	s.failDelay = 100 * time.Millisecond
	start := time.Now()
	if w := call(s, "POST", "/api/login", loginBody(testUser, "errada-errada")); w.Code != http.StatusUnauthorized {
		t.Fatalf("código %d, esperava 401", w.Code)
	}
	if d := time.Since(start); d < s.failDelay {
		t.Errorf("o login falhado só esperou %v, esperava pelo menos %v", d, s.failDelay)
	}
	start = time.Now()
	if w := call(s, "POST", "/api/login", loginBody(testUser, testPass)); w.Code != http.StatusOK {
		t.Fatalf("código %d, esperava 200", w.Code)
	}
	if d := time.Since(start); d >= s.failDelay {
		t.Errorf("o login certo esperou %v", d)
	}
}

func TestLogout(t *testing.T) {
	t.Parallel()
	s := newTestServer(t)
	w := authedCall(s, "POST", "/api/logout", "")
	c := sessionCookie(w)
	if w.Code != http.StatusOK || c == nil || c.MaxAge >= 0 {
		t.Fatalf("logout devia apagar o cookie: código %d, cookie %+v", w.Code, c)
	}
	if c.Secure {
		t.Error("sem HTTPS o cookie não pode ser Secure (o browser ignorava-o)")
	}
	w = call(s, "POST", "/api/logout", "", withHeader("X-Forwarded-Proto", "https"))
	if c := sessionCookie(w); c == nil || !c.Secure || c.MaxAge >= 0 {
		t.Errorf("atrás de HTTPS o cookie apagado também tem de ser Secure: %+v", c)
	}
}

func TestSessionValidation(t *testing.T) {
	t.Parallel()
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

// A sessão vale até ao segundo anterior a exp, e o login dá sessões de 30 dias.
func TestSessionExpiry(t *testing.T) {
	t.Parallel()
	s := newTestServer(t)
	t0 := time.Date(2027, 7, 5, 12, 0, 0, 0, time.UTC)
	clk := withClock(s, t0)
	c := sessionCookie(call(s, "POST", "/api/login", loginBody(testUser, testPass)))
	exp, ok := s.session(&http.Request{Header: http.Header{"Cookie": {cookieName + "=" + c.Value}}})
	if !ok || !exp.Equal(t0.Add(sessionTTL)) {
		t.Fatalf("a sessão do login devia valer até %v, vale até %v (%v)", t0.Add(sessionTTL), exp, ok)
	}

	tok := tokenUntil(s, t0.Add(time.Hour))
	clk.add(time.Hour - time.Second)
	if w := call(s, "GET", "/api/trips", "", withCookie(tok)); w.Code != http.StatusOK {
		t.Errorf("um segundo antes de expirar: código %d, esperava 200", w.Code)
	}
	clk.add(time.Second)
	if w := call(s, "GET", "/api/trips", "", withCookie(tok)); w.Code != http.StatusUnauthorized {
		t.Errorf("no instante em que expira: código %d, esperava 401", w.Code)
	}
}

func TestSessionSlidingRenewal(t *testing.T) {
	t.Parallel()
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

	// Fronteira: com exatamente sessionTTL-sessionRenewEvery ainda não renova; um segundo abaixo já renova.
	t0 := time.Date(2027, 7, 5, 12, 0, 0, 0, time.UTC)
	withClock(s, t0)
	limit := t0.Add(sessionTTL - sessionRenewEvery)
	if c := sessionCookie(call(s, "GET", "/api/trips", "", withCookie(tokenUntil(s, limit)))); c != nil {
		t.Errorf("com sessionTTL-sessionRenewEvery não devia renovar: %+v", c)
	}
	c = sessionCookie(call(s, "GET", "/api/trips", "", withCookie(tokenUntil(s, limit.Add(-time.Second)))))
	if c == nil {
		t.Fatal("um segundo abaixo de sessionTTL-sessionRenewEvery devia renovar")
	}
	if exp, _ := s.session(&http.Request{Header: http.Header{"Cookie": {cookieName + "=" + c.Value}}}); !exp.Equal(t0.Add(sessionTTL)) {
		t.Errorf("a sessão renovada devia valer até %v, vale até %v", t0.Add(sessionTTL), exp)
	}
}

func TestSessionSurvivesRestartButNotPasswordChange(t *testing.T) {
	t.Parallel()
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
	t.Parallel()
	r := httptest.NewRequest("GET", "/", nil)
	r.RemoteAddr = "10.0.0.1:5555"
	if got := clientIP(r); got != "10.0.0.1" {
		t.Errorf("clientIP = %q, esperava 10.0.0.1", got)
	}
	r.Header.Set("X-Forwarded-For", " 203.0.113.9 , 10.0.0.1")
	if got := clientIP(r); got != "203.0.113.9" {
		t.Errorf("clientIP com X-Forwarded-For = %q, esperava 203.0.113.9", got)
	}
	// Um RemoteAddr sem porta (por exemplo, um socket Unix) fica tal como vem.
	r = httptest.NewRequest("GET", "/", nil)
	r.RemoteAddr = "@"
	if got := clientIP(r); got != "@" {
		t.Errorf("clientIP sem porta = %q, esperava @", got)
	}
}

func TestEqualStr(t *testing.T) {
	t.Parallel()
	for _, tc := range []struct {
		a, b string
		want bool
	}{
		{"beatriz", "beatriz", true},
		{"", "", true},
		{"beatriz", "Beatriz", false},
		{"beatriz", "beatriz ", false},
		{"curta", "uma-bem-mais-comprida", false},
		{"", "x", false},
	} {
		if got := constantTimeEqual(tc.a, tc.b); got != tc.want {
			t.Errorf("constantTimeEqual(%q, %q) = %v, esperava %v", tc.a, tc.b, got, tc.want)
		}
	}
}

func TestLoadKey(t *testing.T) {
	t.Parallel()
	dir := t.TempDir()
	p := filepath.Join(dir, ".session-secret")
	s := newTestServerAt(t, dir, testPass)
	secret, err := os.ReadFile(p)
	if err != nil || len(secret) != 32 {
		t.Fatalf("esperava um segredo de 32 bytes: %v, %d bytes", err, len(secret))
	}
	if fi, _ := os.Stat(p); runtime.GOOS != "windows" && fi.Mode().Perm() != 0o600 {
		t.Errorf("permissões do segredo %v, esperava 0600", fi.Mode().Perm())
	}

	// Um reinício reutiliza o segredo: a chave é a mesma.
	if s2 := newTestServerAt(t, dir, testPass); string(s2.key) != string(s.key) {
		t.Error("um reinício não pode mudar a chave das sessões")
	}
	if again, _ := os.ReadFile(p); string(again) != string(secret) {
		t.Error("um reinício não pode reescrever o segredo")
	}

	// Um segredo curto demais (ficheiro truncado) é refeito.
	os.WriteFile(p, []byte("curto"), 0o600)
	s3 := newTestServerAt(t, dir, testPass)
	if again, _ := os.ReadFile(p); len(again) != 32 || string(again) == string(secret) {
		t.Errorf("o segredo curto devia ser refeito com 32 bytes novos, tem %d", len(again))
	}
	if string(s3.key) == string(s.key) {
		t.Error("um segredo novo tem de dar uma chave nova")
	}

	// Sem conseguir gravar o segredo, o servidor não arranca.
	os.Remove(p)
	os.Mkdir(p, 0o700)
	if err := s.loadKey(); err == nil {
		t.Error(".session-secret como pasta devia dar erro")
	}
}
