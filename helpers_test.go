package main

// Funções de apoio partilhadas pelos testes do servidor (um *_test.go por ficheiro do servidor).

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"strconv"
	"strings"
	"sync"
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

// newTestServerAt cria um servidor com os dados em dir, sem a espera dos logins falhados e com os
// avisos descartados (os testes que os querem ver usam captureLog). O relógio é o verdadeiro: os
// testes que dependem da data usam withClock.
func newTestServerAt(t testing.TB, dir, password string) *server {
	t.Helper()
	s, err := newServer(config{user: testUser, password: password, dataDir: dir})
	if err != nil {
		t.Fatal(err)
	}
	s.failDelay = 0
	s.log = log.New(io.Discard, "", 0)
	return s
}

// clock é um relógio de teste: fica parado até alguém o adiantar.
type clock struct {
	mu sync.Mutex
	t  time.Time
}

func (c *clock) now() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.t
}

func (c *clock) add(d time.Duration) {
	c.mu.Lock()
	c.t = c.t.Add(d)
	c.mu.Unlock()
}

// withClock põe o servidor num relógio parado em t.
func withClock(s *server, t time.Time) *clock {
	c := &clock{t: t}
	s.now = c.now
	return c
}

// syncBuffer é um bytes.Buffer que aguenta escritas de vários pedidos ao mesmo tempo.
type syncBuffer struct {
	mu sync.Mutex
	b  bytes.Buffer
}

func (b *syncBuffer) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.b.Write(p)
}

func (b *syncBuffer) String() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.b.String()
}

// captureLog passa os avisos do servidor para um buffer.
func captureLog(s *server) *syncBuffer {
	b := &syncBuffer{}
	s.log = log.New(b, "", 0)
	return b
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

/* ---------- MCP ---------- */

// testMCPToken vem de strings.Repeat, como as palavras-passe: nada parecido com um segredo escrito no código.
var testMCPToken = strings.Repeat("t", minMCPTokenLen)

// newMCPServer é um servidor de teste com o /mcp ligado, num relógio parado e com ids previsíveis.
func newMCPServer(t testing.TB) (*server, *clock) {
	t.Helper()
	s := newTestServer(t)
	s.cfg.mcpToken = testMCPToken
	s.idRand = func() int64 { return 0 }
	return s, withClock(s, time.Date(2026, 10, 13, 9, 0, 0, 0, time.UTC))
}

// mcpPost manda body para o /mcp com o token certo.
func mcpPost(s *server, body string, opts ...reqOpt) *httptest.ResponseRecorder {
	return call(s, "POST", "/mcp", body, append([]reqOpt{withoutCSRF, withHeader("Authorization", "Bearer "+testMCPToken)}, opts...)...)
}

// rpcReply é uma resposta JSON-RPC já interpretada.
type rpcReply struct {
	ID     json.RawMessage `json:"id"`
	Result map[string]any  `json:"result"`
	Error  *rpcError       `json:"error"`
}

// rpc chama method com params (JSON) e devolve a resposta, que tem de ser um 200.
func rpc(t *testing.T, s *server, method, params string) rpcReply {
	t.Helper()
	if params == "" {
		params = "{}"
	}
	w := mcpPost(s, fmt.Sprintf(`{"jsonrpc":"2.0","id":7,"method":%q,"params":%s}`, method, params))
	if w.Code != 200 {
		t.Fatalf("%s: código %d: %s", method, w.Code, w.Body.String())
	}
	return decode[rpcReply](t, w)
}

// toolResult é o que uma ferramenta devolveu: o structuredContent, ou o texto do erro.
type toolResult struct {
	out    map[string]any
	errMsg string // vazio quando correu bem
}

// tool corre a ferramenta name com args (JSON). Confirma que o texto traz o mesmo JSON do structuredContent.
func tool(t *testing.T, s *server, name, args string) toolResult {
	t.Helper()
	r := rpc(t, s, "tools/call", fmt.Sprintf(`{"name":%q,"arguments":%s}`, name, args))
	if r.Error != nil {
		t.Fatalf("%s: erro do protocolo %+v", name, r.Error)
	}
	content, _ := r.Result["content"].([]any)
	if len(content) != 1 {
		t.Fatalf("%s: content devia ter um bloco: %v", name, r.Result)
	}
	txt, _ := content[0].(map[string]any)["text"].(string)
	if r.Result["isError"] == true {
		return toolResult{errMsg: txt}
	}
	out, _ := r.Result["structuredContent"].(map[string]any)
	var again map[string]any
	if err := json.Unmarshal([]byte(txt), &again); err != nil || fmt.Sprint(again) != fmt.Sprint(out) {
		t.Errorf("%s: o texto não é o JSON do structuredContent: %s", name, txt)
	}
	return toolResult{out: out}
}

// mustTool corre a ferramenta e falha o teste se ela devolver um erro.
func mustTool(t *testing.T, s *server, name, args string) map[string]any {
	t.Helper()
	r := tool(t, s, name, args)
	if r.errMsg != "" {
		t.Fatalf("%s %s: %s", name, args, r.errMsg)
	}
	return r.out
}

// storedTrip lê do disco a viagem id, tal como a página a recebe.
func storedTrip(t *testing.T, s *server, id string) (map[string]any, int64) {
	t.Helper()
	b, err := os.ReadFile(s.tripPath(id))
	if err != nil {
		t.Fatal(err)
	}
	var rec struct {
		Rev  int64          `json:"rev"`
		Trip map[string]any `json:"trip"`
	}
	if err := json.Unmarshal(b, &rec); err != nil {
		t.Fatal(err)
	}
	return rec.Trip, rec.Rev
}

/* ---------- OAuth ---------- */

// testPublicURL é o PLANNER_PUBLIC_URL dos testes do OAuth.
const testPublicURL = "https://ferias.example.com"

// testRedirect é o endereço de volta do cliente dos testes.
const testRedirect = "https://claude.ai/api/mcp/auth_callback"

// testVerifier é o code_verifier do PKCE dos testes (43 caracteres, o mínimo).
var testVerifier = strings.Repeat("v", minVerifierLen)

// newOAuthServer é um servidor de teste com o OAuth ligado (sem token fixo), num relógio parado.
func newOAuthServer(t testing.TB) (*server, *clock) {
	t.Helper()
	s := newTestServer(t)
	s.cfg.publicURL = testPublicURL
	return s, withClock(s, time.Date(2026, 10, 13, 9, 0, 0, 0, time.UTC))
}

// registerClient regista um cliente com os redirects dados e devolve o client_id.
func registerClient(t *testing.T, s *server, redirects ...string) string {
	t.Helper()
	b, _ := json.Marshal(map[string]any{"client_name": "Claude", "redirect_uris": redirects})
	w := call(s, "POST", "/oauth/register", string(b), withoutCSRF)
	if w.Code != http.StatusCreated {
		t.Fatalf("registo: código %d: %s", w.Code, w.Body.String())
	}
	return decode[map[string]any](t, w)["client_id"].(string)
}

// authParams são os parâmetros de um pedido de autorização válido para clientID.
func authParams(clientID string) url.Values {
	return url.Values{
		"client_id": {clientID}, "redirect_uri": {testRedirect}, "response_type": {"code"}, "state": {"xyz"},
		"code_challenge": {pkceChallenge(testVerifier)}, "code_challenge_method": {"S256"}, "resource": {testPublicURL + "/mcp"},
	}
}

// formCall manda um formulário (application/x-www-form-urlencoded), sem o X-Requested-With.
func formCall(s *server, path string, v url.Values, opts ...reqOpt) *httptest.ResponseRecorder {
	return call(s, "POST", path, v.Encode(), append([]reqOpt{withoutCSRF, withHeader("Content-Type", "application/x-www-form-urlencoded")}, opts...)...)
}

// consent responde à página de consentimento com user, password e action (allow ou deny).
func consent(s *server, v url.Values, user, password, action string, opts ...reqOpt) *httptest.ResponseRecorder {
	f := url.Values{}
	for k, vs := range v {
		f[k] = vs
	}
	f.Set("user", user)
	f.Set("password", password)
	f.Set("action", action)
	return formCall(s, "/oauth/authorize", f, opts...)
}

// authCode autoriza clientID com as credenciais certas e devolve o código do redirect.
func authCode(t *testing.T, s *server, clientID string) string {
	t.Helper()
	w := consent(s, authParams(clientID), testUser, testPass, "allow")
	if w.Code != http.StatusSeeOther {
		t.Fatalf("autorizar: código %d: %s", w.Code, w.Body.String())
	}
	u, _ := url.Parse(w.Header().Get("Location"))
	return u.Query().Get("code")
}

// exchangeCode troca code por tokens com o verifier certo.
func exchangeCode(s *server, clientID, code string) *httptest.ResponseRecorder {
	return formCall(s, "/oauth/token", url.Values{
		"grant_type": {"authorization_code"}, "code": {code}, "redirect_uri": {testRedirect},
		"client_id": {clientID}, "code_verifier": {testVerifier},
	})
}

// oauthTokens faz o fluxo todo (registo, consentimento e troca) e devolve o client_id e os tokens.
func oauthTokens(t *testing.T, s *server) (clientID, access, refresh string) {
	t.Helper()
	clientID = registerClient(t, s, testRedirect)
	w := exchangeCode(s, clientID, authCode(t, s, clientID))
	if w.Code != 200 {
		t.Fatalf("troca do código: código %d: %s", w.Code, w.Body.String())
	}
	r := decode[map[string]any](t, w)
	return clientID, r["access_token"].(string), r["refresh_token"].(string)
}
