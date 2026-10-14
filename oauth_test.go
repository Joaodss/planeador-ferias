package main

import (
	"net/http"
	"net/url"
	"strings"
	"testing"
	"time"
)

const ping = `{"jsonrpc":"2.0","id":1,"method":"ping"}`

func TestOAuthOff(t *testing.T) {
	t.Parallel()
	s := newTestServer(t)
	for _, c := range []struct{ method, path string }{
		{"GET", "/.well-known/oauth-protected-resource"}, {"GET", "/.well-known/oauth-protected-resource/mcp"},
		{"GET", "/.well-known/oauth-authorization-server"}, {"POST", "/oauth/register"},
		{"GET", "/oauth/authorize"}, {"POST", "/oauth/authorize"}, {"POST", "/oauth/token"},
	} {
		if w := call(s, c.method, c.path, "", withoutCSRF); w.Code != http.StatusNotFound {
			t.Errorf("%s %s sem PLANNER_PUBLIC_URL: código %d, esperava 404", c.method, c.path, w.Code)
		}
	}
}

func TestOAuthMetadata(t *testing.T) {
	t.Parallel()
	s, _ := newOAuthServer(t)
	for _, p := range []string{"/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/mcp"} {
		w := call(s, "GET", p, "")
		m := decode[map[string]any](t, w)
		if w.Code != 200 || m["resource"] != testPublicURL+"/mcp" || m["authorization_servers"].([]any)[0] != testPublicURL {
			t.Errorf("%s: %d %v", p, w.Code, m)
		}
	}
	m := decode[map[string]any](t, call(s, "GET", "/.well-known/oauth-authorization-server", ""))
	if m["issuer"] != testPublicURL || m["token_endpoint"] != testPublicURL+"/oauth/token" ||
		m["registration_endpoint"] != testPublicURL+"/oauth/register" || m["authorization_endpoint"] != testPublicURL+"/oauth/authorize" ||
		m["code_challenge_methods_supported"].([]any)[0] != "S256" {
		t.Errorf("metadados do servidor de autorização: %v", m)
	}
}

func TestOAuthRegister(t *testing.T) {
	t.Parallel()
	s, _ := newOAuthServer(t)
	w := call(s, "POST", "/oauth/register", `{"client_name":"Claude","redirect_uris":["https://claude.ai/cb","http://localhost:3000/cb"]}`, withoutCSRF)
	m := decode[map[string]any](t, w)
	if w.Code != http.StatusCreated || m["token_endpoint_auth_method"] != "none" || m["client_name"] != "Claude" || len(m["redirect_uris"].([]any)) != 2 {
		t.Fatalf("registo válido: %d %v", w.Code, m)
	}
	c, ok := s.parseClient(m["client_id"].(string))
	if !ok || c.Name != "Claude" || c.Redirects[1] != "http://localhost:3000/cb" {
		t.Errorf("o client_id não traz o cliente: %+v %v", c, ok)
	}
	long := strings.Repeat("x", maxClientNameLen+1)
	for name, tc := range map[string]struct{ body, err string }{
		"JSON inválido":          {`{`, "invalid_client_metadata"},
		"nome comprido":          {`{"client_name":"` + long + `","redirect_uris":["https://a.b/cb"]}`, "invalid_client_metadata"},
		"cliente confidencial":   {`{"redirect_uris":["https://a.b/cb"],"token_endpoint_auth_method":"client_secret_basic"}`, "invalid_client_metadata"},
		"sem redirects":          {`{"redirect_uris":[]}`, "invalid_redirect_uri"},
		"redirects a mais":       {`{"redirect_uris":["https://a/1","https://a/2","https://a/3","https://a/4","https://a/5","https://a/6"]}`, "invalid_redirect_uri"},
		"http fora do localhost": {`{"redirect_uris":["http://a.b/cb"]}`, "invalid_redirect_uri"},
		"com fragmento":          {`{"redirect_uris":["https://a.b/cb#x"]}`, "invalid_redirect_uri"},
		"sem servidor":           {`{"redirect_uris":["https:///cb"]}`, "invalid_redirect_uri"},
		"outro esquema":          {`{"redirect_uris":["javascript://a.b/x"]}`, "invalid_redirect_uri"},
	} {
		w := call(s, "POST", "/oauth/register", tc.body, withoutCSRF)
		if m := decode[map[string]any](t, w); w.Code != 400 || m["error"] != tc.err {
			t.Errorf("%s: %d %v, esperava 400 %s", name, w.Code, m, tc.err)
		}
	}
}

func TestOAuthAuthorizeValidation(t *testing.T) {
	t.Parallel()
	s, _ := newOAuthServer(t)
	id := registerClient(t, s, testRedirect)
	payload, _, _ := strings.Cut(id, ".")
	two := registerClient(t, s, testRedirect, "https://outro.example/cb")

	// erros que só aparecem numa página: não se sabe para onde voltar com segurança
	for name, change := range map[string]func(url.Values){
		"client_id forjado":     func(v url.Values) { v.Set("client_id", payload+".assinatura") },
		"client_id sem ponto":   func(v url.Values) { v.Set("client_id", "abc") },
		"client_id ilegível":    func(v url.Values) { v.Set("client_id", "!!."+s.sign("oauth-client:!!")) },
		"redirect desconhecido": func(v url.Values) { v.Set("redirect_uri", "https://mau.example/cb") },
		"sem redirect com dois": func(v url.Values) { v.Set("client_id", two); v.Del("redirect_uri") },
	} {
		v := authParams(id)
		change(v)
		w := call(s, "GET", "/oauth/authorize?"+v.Encode(), "")
		if w.Code != 400 || w.Header().Get("Location") != "" || !strings.Contains(w.Body.String(), "inválido") {
			t.Errorf("%s: código %d, Location %q", name, w.Code, w.Header().Get("Location"))
		}
	}

	// erros que voltam ao cliente
	for name, tc := range map[string]struct {
		change func(url.Values)
		err    string
	}{
		"response_type token": {func(v url.Values) { v.Set("response_type", "token") }, "unsupported_response_type"},
		"sem PKCE":            {func(v url.Values) { v.Del("code_challenge") }, "invalid_request"},
		"PKCE plain":          {func(v url.Values) { v.Set("code_challenge_method", "plain") }, "invalid_request"},
		"challenge curto":     {func(v url.Values) { v.Set("code_challenge", "abc") }, "invalid_request"},
		"outro recurso":       {func(v url.Values) { v.Set("resource", "https://outro.example/mcp") }, "invalid_target"},
	} {
		v := authParams(id)
		tc.change(v)
		w := call(s, "GET", "/oauth/authorize?"+v.Encode(), "")
		loc, _ := url.Parse(w.Header().Get("Location"))
		if w.Code != http.StatusSeeOther || loc.Query().Get("error") != tc.err || loc.Query().Get("state") != "xyz" {
			t.Errorf("%s: código %d, Location %q", name, w.Code, w.Header().Get("Location"))
		}
	}

	// sem redirect_uri e com um só registado, usa esse
	v := authParams(id)
	v.Del("redirect_uri")
	v.Del("resource")
	if w := call(s, "GET", "/oauth/authorize?"+v.Encode(), ""); w.Code != 200 {
		t.Errorf("sem redirect_uri com um só: código %d", w.Code)
	}
}

func TestOAuthConsentPage(t *testing.T) {
	t.Parallel()
	s, _ := newOAuthServer(t)
	w := call(s, "POST", "/oauth/register", `{"client_name":"<b>Mau</b>","redirect_uris":["https://claude.ai:8443/cb?x=1"]}`, withoutCSRF)
	id := decode[map[string]any](t, w)["client_id"].(string)
	v := authParams(id)
	v.Set("redirect_uri", "https://claude.ai:8443/cb?x=1")

	w = call(s, "GET", "/oauth/authorize?"+v.Encode(), "")
	body := w.Body.String()
	if w.Code != 200 || strings.Contains(body, "<b>Mau</b>") || !strings.Contains(body, "&lt;b&gt;Mau&lt;/b&gt;") {
		t.Errorf("o nome do cliente devia vir escapado: %d %s", w.Code, body)
	}
	if !strings.Contains(body, "Permitir") || !strings.Contains(body, "claude.ai:8443") || !strings.Contains(body, "✨") {
		t.Errorf("página em português com o servidor de volta e o que a IA pode fazer: %s", body)
	}
	if c := w.Header().Get("Content-Security-Policy"); !strings.Contains(c, "form-action 'self' https://claude.ai:8443") {
		t.Errorf("CSP sem a origem do redirect no form-action: %s", c)
	}
	if w.Header().Get("Cache-Control") != "no-store" {
		t.Error("a página de consentimento não pode ficar em cache")
	}

	// inglês pelo Accept-Language, e mantido no POST pelo campo lang
	w = call(s, "GET", "/oauth/authorize?"+v.Encode(), "", withHeader("Accept-Language", "en-GB,en;q=0.9"))
	if !strings.Contains(w.Body.String(), "Allow") || !strings.Contains(w.Body.String(), `name="lang" value="en"`) {
		t.Errorf("página em inglês: %s", w.Body.String())
	}
	v.Set("lang", "en")
	if w := consent(s, v, testUser, "errada", "allow", withIP("10.0.0.9")); !strings.Contains(w.Body.String(), "Wrong user name") {
		t.Errorf("a língua devia manter-se no POST: %s", w.Body.String())
	}

	// em modo só de leitura diz que só pode ver
	s.cfg.mcpReadOnly = true
	if w := call(s, "GET", "/oauth/authorize?"+authParams(registerClient(t, s, testRedirect)).Encode(), ""); !strings.Contains(w.Body.String(), "Só vai poder ver") {
		t.Errorf("modo só de leitura: %s", w.Body.String())
	}
}

func TestConsentCSP(t *testing.T) {
	t.Parallel()
	for in, want := range map[string]string{
		"https://claude.ai/cb":        "form-action 'self' https://claude.ai",
		"http://[::1]:8080/cb":        "form-action 'self' http://[::1]:8080",
		"https://a b/cb":              "form-action 'self'",
		"https://claude.ai;x/cb":      "form-action 'self'",
		"%zz":                         "form-action 'self'",
		"https://bad'host.example/cb": "form-action 'self'",
	} {
		if got := consentCSP(in); !strings.HasSuffix(got, want) {
			t.Errorf("consentCSP(%q) = %q, esperava o fim %q", in, got, want)
		}
	}
}

func TestOAuthConsentSubmit(t *testing.T) {
	t.Parallel()
	s, _ := newOAuthServer(t)
	id := registerClient(t, s, testRedirect)

	// palavra-passe errada: 401, a página outra vez e uma falha contada
	w := consent(s, authParams(id), testUser, "errada-errada", "allow", withIP("10.0.0.1"))
	if w.Code != http.StatusUnauthorized || !strings.Contains(w.Body.String(), "errados") || len(s.failures["10.0.0.1"]) != 1 {
		t.Errorf("palavra-passe errada: %d, falhas %v", w.Code, s.failures)
	}
	for range maxFailuresPerIP {
		consent(s, authParams(id), "outro", testPass, "allow", withIP("10.0.0.1"))
	}
	if w := consent(s, authParams(id), testUser, testPass, "allow", withIP("10.0.0.1")); w.Code != http.StatusTooManyRequests || !strings.Contains(w.Body.String(), "Demasiadas") {
		t.Errorf("depois de muitas falhas: código %d", w.Code)
	}

	// recusar volta ao cliente com access_denied, sem pedir as credenciais
	w = consent(s, authParams(id), "", "", "deny")
	if loc := w.Header().Get("Location"); w.Code != http.StatusSeeOther || !strings.HasPrefix(loc, testRedirect+"?") || !strings.Contains(loc, "error=access_denied") || !strings.Contains(loc, "state=xyz") {
		t.Errorf("recusar: %d %q", w.Code, loc)
	}

	// permitir: 303 com code, state e iss; num redirect com pesquisa junta-se a ela
	id2 := registerClient(t, s, testRedirect+"?a=1")
	v := authParams(id2)
	v.Set("redirect_uri", testRedirect+"?a=1")
	w = consent(s, v, " "+testUser+" ", testPass, "allow")
	loc, _ := url.Parse(w.Header().Get("Location"))
	q := loc.Query()
	if w.Code != http.StatusSeeOther || q.Get("a") != "1" || len(q.Get("code")) < 40 || q.Get("state") != "xyz" || q.Get("iss") != testPublicURL {
		t.Errorf("permitir: %d %q", w.Code, w.Header().Get("Location"))
	}

	// o POST também revalida: um client_id forjado dá a página de erro
	v = authParams(id)
	v.Set("client_id", "x."+s.sign("x"))
	if w := consent(s, v, testUser, testPass, "allow"); w.Code != 400 {
		t.Errorf("POST com client_id forjado: código %d", w.Code)
	}
	if w := formCall(s, "/oauth/authorize", url.Values{}, withHeader("Content-Type", "application/x-www-form-urlencoded; charset=%")); w.Code != 400 {
		t.Errorf("formulário ilegível: código %d", w.Code)
	}
}

func TestOAuthToken(t *testing.T) {
	t.Parallel()
	s, clk := newOAuthServer(t)
	id := registerClient(t, s, testRedirect)

	// troca válida, e o mesmo código uma segunda vez já não serve
	code := authCode(t, s, id)
	w := exchangeCode(s, id, code)
	r := decode[map[string]any](t, w)
	if w.Code != 200 || r["token_type"] != "Bearer" || r["scope"] != oauthScope || r["expires_in"] != float64(3600) || w.Header().Get("Cache-Control") != "no-store" {
		t.Fatalf("troca do código: %d %v", w.Code, r)
	}
	if !strings.HasPrefix(r["access_token"].(string), "at.") || !strings.HasPrefix(r["refresh_token"].(string), "rt.") {
		t.Errorf("tipos dos tokens: %v", r)
	}
	if w := exchangeCode(s, id, code); w.Code != 400 || decode[map[string]any](t, w)["error"] != "invalid_grant" {
		t.Errorf("código reutilizado: %d", w.Code)
	}

	tokenErr := func(name string, v url.Values, status int, want string) {
		t.Helper()
		w := formCall(s, "/oauth/token", v)
		if m := decode[map[string]any](t, w); w.Code != status || m["error"] != want {
			t.Errorf("%s: %d %v, esperava %d %s", name, w.Code, m, status, want)
		}
	}
	grant := func(change func(url.Values)) url.Values {
		v := url.Values{"grant_type": {"authorization_code"}, "code": {authCode(t, s, id)}, "redirect_uri": {testRedirect}, "client_id": {id}, "code_verifier": {testVerifier}}
		change(v)
		return v
	}
	tokenErr("verifier errado", grant(func(v url.Values) { v.Set("code_verifier", strings.Repeat("w", minVerifierLen)) }), 400, "invalid_grant")
	tokenErr("verifier curto", grant(func(v url.Values) { v.Set("code_verifier", "v") }), 400, "invalid_grant")
	tokenErr("outro redirect", grant(func(v url.Values) { v.Set("redirect_uri", "https://claude.ai/outro") }), 400, "invalid_grant")
	tokenErr("outro cliente", grant(func(v url.Values) { v.Set("client_id", registerClient(t, s, testRedirect, "https://outro.example/cb")) }), 400, "invalid_grant")
	tokenErr("cliente forjado", grant(func(v url.Values) { v.Set("client_id", "x.y") }), 401, "invalid_client")

	// o código verifier errado também o gastou: com o certo já não serve
	v := grant(func(v url.Values) { v.Set("code_verifier", strings.Repeat("w", minVerifierLen)) })
	formCall(s, "/oauth/token", v)
	v.Set("code_verifier", testVerifier)
	tokenErr("código já tentado", v, 400, "invalid_grant")

	expired := grant(func(url.Values) {})
	clk.add(oauthCodeTTL)
	tokenErr("código expirado", expired, 400, "invalid_grant")

	tokenErr("sem grant_type", url.Values{}, 400, "invalid_request")
	tokenErr("grant_type desconhecido", url.Values{"grant_type": {"password"}}, 400, "unsupported_grant_type")
	if w := formCall(s, "/oauth/token", url.Values{}, withHeader("Content-Type", "application/x-www-form-urlencoded; charset=%")); w.Code != 400 {
		t.Errorf("corpo ilegível: código %d", w.Code)
	}

	// renovação: tokens novos; com o token de acesso, de outro cliente ou expirado não serve
	refresh := r["refresh_token"].(string)
	w = formCall(s, "/oauth/token", url.Values{"grant_type": {"refresh_token"}, "refresh_token": {refresh}, "client_id": {id}})
	r2 := decode[map[string]any](t, w)
	if w.Code != 200 || r2["refresh_token"] == nil || r2["access_token"] == nil {
		t.Errorf("renovação: %d %v", w.Code, r2)
	}
	ref := func(tok, client string) url.Values {
		return url.Values{"grant_type": {"refresh_token"}, "refresh_token": {tok}, "client_id": {client}}
	}
	tokenErr("renovar com o token de acesso", ref(r["access_token"].(string), id), 400, "invalid_grant")
	tokenErr("renovar com outro cliente", ref(refresh, registerClient(t, s, testRedirect, "https://outro.example/cb")), 400, "invalid_grant")
	tokenErr("renovar com cliente forjado", ref(refresh, "x.y"), 401, "invalid_client")
	tokenErr("renovar com lixo", ref("rt.lixo.lixo", id), 400, "invalid_grant")
	tokenErr("renovar com conteúdo ilegível", ref("rt.!!."+s.sign("oauth:rt:!!"), id), 400, "invalid_grant")
	clk.add(refreshTokenTTL)
	tokenErr("renovação expirada", ref(refresh, id), 400, "invalid_grant")
}

func TestOAuthMCP(t *testing.T) {
	t.Parallel()
	s, clk := newOAuthServer(t)
	_, access, refresh := oauthTokens(t, s)

	w := call(s, "POST", "/mcp", `{"jsonrpc":"2.0","id":1,"method":"tools/list"}`, withoutCSRF, withHeader("Authorization", "Bearer "+access))
	if w.Code != 200 || !strings.Contains(w.Body.String(), "list_trips") {
		t.Fatalf("tools/list com o token de acesso: %d %s", w.Code, w.Body.String())
	}

	// sem token: 401 com resource_metadata, sem error, e sem contar como falha
	want := `Bearer resource_metadata="` + testPublicURL + `/.well-known/oauth-protected-resource"`
	w = call(s, "POST", "/mcp", ping, withoutCSRF, withIP("10.0.0.1"))
	if w.Code != 401 || w.Header().Get("WWW-Authenticate") != want {
		t.Errorf("sem token: %d %q", w.Code, w.Header().Get("WWW-Authenticate"))
	}
	// o token de renovação não serve de acesso, mas é deste servidor: também não conta
	w = call(s, "POST", "/mcp", ping, withoutCSRF, withIP("10.0.0.1"), withHeader("Authorization", "Bearer "+refresh))
	if w.Code != 401 || w.Header().Get("WWW-Authenticate") != want+`, error="invalid_token"` {
		t.Errorf("token de renovação: %d %q", w.Code, w.Header().Get("WWW-Authenticate"))
	}
	// expirado: 401 com error="invalid_token", sem contar como falha
	clk.add(accessTokenTTL)
	w = call(s, "POST", "/mcp", ping, withoutCSRF, withIP("10.0.0.1"), withHeader("Authorization", "Bearer "+access))
	if w.Code != 401 || w.Header().Get("WWW-Authenticate") != want+`, error="invalid_token"` {
		t.Errorf("token expirado: %d %q", w.Code, w.Header().Get("WWW-Authenticate"))
	}
	if n := len(s.failures["10.0.0.1"]); n != 0 {
		t.Errorf("sem token ou com um expirado não devia contar falhas: %d", n)
	}
	// lixo conta
	call(s, "POST", "/mcp", ping, withoutCSRF, withIP("10.0.0.1"), withHeader("Authorization", "Bearer at.lixo.lixo"))
	if n := len(s.failures["10.0.0.1"]); n != 1 {
		t.Errorf("um token forjado devia contar uma falha: %d", n)
	}
	// um cookie de sessão não serve de token, nem um token de cliente
	for _, tok := range []string{s.newToken(), registerClient(t, s, testRedirect)} {
		if w := call(s, "POST", "/mcp", ping, withoutCSRF, withHeader("Authorization", "Bearer "+tok)); w.Code != 401 {
			t.Errorf("%q como token: código %d", tok, w.Code)
		}
	}
	// o modo só de leitura vale também para o OAuth
	_, access, _ = oauthTokens(t, s)
	s.cfg.mcpReadOnly = true
	w = call(s, "POST", "/mcp", `{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"add_activities","arguments":{}}}`, withoutCSRF, withHeader("Authorization", "Bearer "+access))
	if !strings.Contains(w.Body.String(), "só de leitura") {
		t.Errorf("modo só de leitura com OAuth: %s", w.Body.String())
	}
}

func TestOAuthPasswordChangeRevokes(t *testing.T) {
	t.Parallel()
	dir := t.TempDir()
	s := newTestServerAt(t, dir, testPass)
	s.cfg.publicURL = testPublicURL
	_, access, refresh := oauthTokens(t, s)

	s2 := newTestServerAt(t, dir, testPass+"-nova")
	s2.cfg.publicURL = testPublicURL
	if w := call(s2, "POST", "/mcp", ping, withoutCSRF, withHeader("Authorization", "Bearer "+access)); w.Code != 401 {
		t.Errorf("token de acesso com outra palavra-passe: código %d", w.Code)
	}
	if signed, _ := s2.checkOAuthToken(refresh, "rt", ""); signed {
		t.Error("o token de renovação não devia valer com outra palavra-passe")
	}
}

func TestOAuthWithStaticToken(t *testing.T) {
	t.Parallel()
	s, _ := newMCPServer(t)
	s.cfg.publicURL = testPublicURL
	if w := mcpPost(s, ping); w.Code != 200 {
		t.Errorf("token fixo com OAuth ligado: código %d", w.Code)
	}
	_, access, _ := oauthTokens(t, s)
	if w := call(s, "POST", "/mcp", ping, withoutCSRF, withHeader("Authorization", "Bearer "+access)); w.Code != 200 {
		t.Errorf("token OAuth com token fixo também: código %d", w.Code)
	}
	if w := call(s, "GET", "/mcp", ""); w.Code != http.StatusMethodNotAllowed {
		t.Errorf("GET /mcp: código %d", w.Code)
	}
}

func TestOAuthCodesPruned(t *testing.T) {
	t.Parallel()
	s, clk := newOAuthServer(t)
	s.storeCode("velho", oauthCode{exp: s.now().Add(oauthCodeTTL)})
	clk.add(oauthCodeTTL + time.Second)
	s.storeCode("novo", oauthCode{exp: s.now().Add(oauthCodeTTL)})
	if _, ok := s.codes["velho"]; ok || len(s.codes) != 1 {
		t.Errorf("os códigos expirados deviam ser esquecidos: %v", s.codes)
	}
}

func TestValidPublicURL(t *testing.T) {
	t.Parallel()
	for u, want := range map[string]bool{
		"https://ferias.example.com":      true,
		"https://ferias.example.com:8443": true,
		"http://localhost:8080":           true,
		"http://127.0.0.1:8080":           true,
		"http://[::1]:8080":               true,
		"http://ferias.example.com":       false,
		"https://ferias.example.com/":     false,
		"https://ferias.example.com/x":    false,
		"https://ferias.example.com?x":    false,
		"https://ferias.example.com#x":    false,
		"https://u@ferias.example.com":    false,
		"ferias.example.com":              false,
		"https://":                        false,
		"%zz":                             false,
	} {
		if got := validPublicURL(u); got != want {
			t.Errorf("validPublicURL(%q) = %v", u, got)
		}
	}
}
