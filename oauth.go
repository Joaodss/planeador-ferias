package main

// Autorização OAuth 2.1 do /mcp, para ligar o planeador como conector no claude.ai (que também aparece na app
// do Claude no telemóvel). Os conectores do claude.ai não mandam um cabeçalho fixo: só falam OAuth, como pede a
// especificação de autorização do MCP (PKCE, registo dinâmico de clientes e metadados do recurso protegido).
//
// Tudo sem estado em disco: o client_id e os tokens são assinados com a chave das sessões (s.sign, ver loadKey),
// por isso mudar a palavra-passe revoga todas as ligações. Só os códigos de autorização, que duram um minuto,
// ficam em memória (s.codes). Liga-se com PLANNER_PUBLIC_URL; sem ela todos estes caminhos respondem 404.

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"html/template"
	"net/http"
	"net/url"
	"regexp"
	"slices"
	"strings"
	"time"
	"unicode/utf8"
)

const (
	// oauthScope é o único âmbito: as viagens (o que a IA pode fazer com elas depende de PLANNER_MCP_MODE).
	oauthScope = "trips"
	// accessTokenTTL: um token de acesso roubado só serve durante pouco tempo; o claude.ai renova-o sozinho.
	accessTokenTTL = time.Hour
	// refreshTokenTTL: quem não usar o conector durante um mês tem de o voltar a autorizar, como as sessões.
	refreshTokenTTL = 30 * 24 * time.Hour
	// oauthCodeTTL: o código só vai do browser para o cliente, que o troca logo.
	oauthCodeTTL = 60 * time.Second
	// maxRedirectURIs e maxClientNameLen: um client_id leva tudo isto dentro, e tem de caber num URL.
	maxRedirectURIs  = 5
	maxClientNameLen = 100
	// minVerifierLen e maxVerifierLen: os limites do code_verifier (e do code_challenge) do PKCE (RFC 7636).
	minVerifierLen = 43
	maxVerifierLen = 128
	// maxOAuthBytes: os pedidos do OAuth são formulários e JSON pequenos.
	maxOAuthBytes = 16 << 10
	// oauthCodeBytes: 32 bytes aleatórios não se adivinham.
	oauthCodeBytes = 32
)

// oauthCode é um código de autorização à espera de ser trocado por tokens (ver oauthToken).
type oauthCode struct {
	clientID, redirectURI, challenge string
	exp                              time.Time
}

// oauthClient é o que o client_id traz dentro (ver oauthRegister): o nome e os endereços de volta.
type oauthClient struct {
	Name      string   `json:"n"`
	Redirects []string `json:"r"`
}

// isLoopback diz se host é este computador: só aí se aceita http:// em vez de https://.
func isLoopback(host string) bool {
	return host == "localhost" || host == "127.0.0.1" || host == "::1"
}

// validPublicURL confirma PLANNER_PUBLIC_URL: https://servidor[:porta] (ou http:// só para localhost),
// sem caminho, pesquisa, fragmento nem / no fim.
func validPublicURL(raw string) bool {
	u, err := url.Parse(raw)
	if err != nil || u.Host == "" || u.Path != "" || u.RawQuery != "" || u.Fragment != "" || u.User != nil || strings.ContainsAny(raw, "?#") {
		return false
	}
	return u.Scheme == "https" || (u.Scheme == "http" && isLoopback(u.Hostname()))
}

// validRedirectURI confirma um endereço de volta de um cliente: https:// com servidor, ou http:// só para
// localhost, e sem fragmento (RFC 6749 §3.1.2).
func validRedirectURI(raw string) bool {
	u, err := url.Parse(raw)
	if err != nil || u.Host == "" || u.User != nil || strings.Contains(raw, "#") {
		return false
	}
	return u.Scheme == "https" || (u.Scheme == "http" && isLoopback(u.Hostname()))
}

// originRe: a origem de um redirect_uri que pode ir para a CSP (ver consentCSP). Só letras, dígitos, pontos,
// hífenes e uma porta, ou um IPv6 entre parênteses retos: nada que feche a diretiva ou junte outra.
var originRe = regexp.MustCompile(`^https?://([A-Za-z0-9.-]+|\[[0-9A-Fa-f:]+\])(:[0-9]{1,5})?$`)

/* ---------- clientes e tokens ---------- */

// newClientID cria o client_id de um cliente: o próprio cliente em JSON (base64url), um ponto e a assinatura.
// O servidor não guarda nada: parseClient confirma a assinatura e lê o cliente de volta.
func (s *server) newClientID(c oauthClient) string {
	b, _ := json.Marshal(c)
	payload := base64.RawURLEncoding.EncodeToString(b)
	return payload + "." + s.sign("oauth-client:"+payload)
}

// parseClient lê um client_id criado por newClientID (ok=false se for forjado ou estiver estragado).
func (s *server) parseClient(id string) (c oauthClient, ok bool) {
	payload, sig, found := strings.Cut(id, ".")
	if !found || !hmac.Equal([]byte(sig), []byte(s.sign("oauth-client:"+payload))) {
		return c, false
	}
	b, err := base64.RawURLEncoding.DecodeString(payload)
	if err != nil || json.Unmarshal(b, &c) != nil || len(c.Redirects) == 0 {
		return c, false
	}
	return c, true
}

// clientHash: os primeiros 16 dígitos hexadecimais do sha256 do client_id, que é o que um token guarda dele.
func clientHash(clientID string) string {
	h := sha256.Sum256([]byte(clientID))
	return hex.EncodeToString(h[:])[:16]
}

// tokenClaims é o que um token traz: o cliente (clientHash) e o fim da validade (segundos Unix).
type tokenClaims struct {
	C string `json:"c"`
	E int64  `json:"e"`
}

// newOAuthToken cria um token "<tipo>.<base64url(JSON)>.<assinatura>", em que tipo é "at" (acesso) ou "rt"
// (renovação). O prefixo "oauth:" da assinatura separa-os dos cookies das sessões: um não serve pelo outro.
func (s *server) newOAuthToken(kind, clientID string, ttl time.Duration) string {
	b, _ := json.Marshal(tokenClaims{C: clientHash(clientID), E: s.now().Add(ttl).Unix()})
	payload := base64.RawURLEncoding.EncodeToString(b)
	return kind + "." + payload + "." + s.sign("oauth:"+kind+":"+payload)
}

// checkOAuthToken confirma um token de newOAuthToken. signed diz se a assinatura é deste servidor (seja qual for
// o tipo ou a validade); valid, se além disso é do tipo kind, não expirou e (com clientID) é desse cliente.
func (s *server) checkOAuthToken(tok, kind, clientID string) (signed, valid bool) {
	parts := strings.Split(tok, ".")
	if len(parts) != 3 || !hmac.Equal([]byte(parts[2]), []byte(s.sign("oauth:"+parts[0]+":"+parts[1]))) {
		return false, false
	}
	var cl tokenClaims
	b, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil || json.Unmarshal(b, &cl) != nil {
		return true, false
	}
	return true, parts[0] == kind && s.now().Unix() < cl.E && (clientID == "" || cl.C == clientHash(clientID))
}

// randomCode devolve um código de autorização novo (oauthCodeBytes aleatórios em base64url).
func randomCode() string {
	b := make([]byte, oauthCodeBytes)
	rand.Read(b)
	return base64.RawURLEncoding.EncodeToString(b)
}

// storeCode guarda um código novo e esquece os que já expiraram.
func (s *server) storeCode(code string, c oauthCode) {
	s.codesMu.Lock()
	defer s.codesMu.Unlock()
	now := s.now()
	for k, v := range s.codes {
		if !now.Before(v.exp) {
			delete(s.codes, k)
		}
	}
	s.codes[code] = c
}

// takeCode tira o código da memória (só se usa uma vez, mesmo que o pedido falhe) e devolve-o.
func (s *server) takeCode(code string) (oauthCode, bool) {
	s.codesMu.Lock()
	defer s.codesMu.Unlock()
	c, ok := s.codes[code]
	delete(s.codes, code)
	return c, ok
}

/* ---------- metadados e registo ---------- */

// oauthOff responde 404 quando o OAuth está desligado (sem PLANNER_PUBLIC_URL), como se o caminho não existisse.
func (s *server) oauthOff(w http.ResponseWriter, r *http.Request) bool {
	if s.cfg.publicURL == "" {
		http.NotFound(w, r)
		return true
	}
	return false
}

// oauthResource responde aos metadados do recurso protegido (RFC 9728): onde está o servidor de autorização.
func (s *server) oauthResource(w http.ResponseWriter, r *http.Request) {
	if s.oauthOff(w, r) {
		return
	}
	writeJSON(w, 200, map[string]any{
		"resource":                 s.cfg.publicURL + "/mcp",
		"authorization_servers":    []string{s.cfg.publicURL},
		"bearer_methods_supported": []string{"header"},
		"scopes_supported":         []string{oauthScope},
	})
}

// oauthMetadata responde aos metadados do servidor de autorização (RFC 8414).
func (s *server) oauthMetadata(w http.ResponseWriter, r *http.Request) {
	if s.oauthOff(w, r) {
		return
	}
	u := s.cfg.publicURL
	writeJSON(w, 200, map[string]any{
		"issuer":                                u,
		"authorization_endpoint":                u + "/oauth/authorize",
		"token_endpoint":                        u + "/oauth/token",
		"registration_endpoint":                 u + "/oauth/register",
		"response_types_supported":              []string{"code"},
		"grant_types_supported":                 []string{"authorization_code", "refresh_token"},
		"code_challenge_methods_supported":      []string{"S256"},
		"token_endpoint_auth_methods_supported": []string{"none"},
		"scopes_supported":                      []string{oauthScope},
	})
}

// oauthError responde um erro do OAuth ({error, error_description}).
func oauthError(w http.ResponseWriter, status int, code, desc string) {
	writeJSON(w, status, map[string]string{"error": code, "error_description": desc})
}

// oauthRegister regista um cliente público (RFC 7591) sem guardar nada: o client_id leva o cliente dentro
// (ver newClientID).
func (s *server) oauthRegister(w http.ResponseWriter, r *http.Request) {
	if s.oauthOff(w, r) {
		return
	}
	var in struct {
		ClientName   string   `json:"client_name"`
		RedirectURIs []string `json:"redirect_uris"`
		AuthMethod   string   `json:"token_endpoint_auth_method"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, maxOAuthBytes)).Decode(&in); err != nil {
		oauthError(w, 400, "invalid_client_metadata", "JSON inválido")
		return
	}
	if in.AuthMethod != "" && in.AuthMethod != "none" {
		oauthError(w, 400, "invalid_client_metadata", "só há clientes públicos (token_endpoint_auth_method none)")
		return
	}
	if utf8.RuneCountInString(in.ClientName) > maxClientNameLen {
		oauthError(w, 400, "invalid_client_metadata", "client_name demasiado comprido")
		return
	}
	if len(in.RedirectURIs) == 0 || len(in.RedirectURIs) > maxRedirectURIs {
		oauthError(w, 400, "invalid_redirect_uri", "redirect_uris tem de ter entre 1 e 5 endereços")
		return
	}
	for _, u := range in.RedirectURIs {
		if !validRedirectURI(u) {
			oauthError(w, 400, "invalid_redirect_uri", "redirect_uri inválido: "+u)
			return
		}
	}
	id := s.newClientID(oauthClient{Name: in.ClientName, Redirects: in.RedirectURIs})
	writeJSON(w, http.StatusCreated, map[string]any{
		"client_id":                  id,
		"client_name":                in.ClientName,
		"redirect_uris":              in.RedirectURIs,
		"token_endpoint_auth_method": "none",
		"grant_types":                []string{"authorization_code", "refresh_token"},
		"response_types":             []string{"code"},
		"client_id_issued_at":        s.now().Unix(),
	})
}

/* ---------- autorização (página de consentimento) ---------- */

// authFields: os parâmetros do pedido de autorização que o formulário de consentimento leva escondidos.
var authFields = []string{"client_id", "redirect_uri", "response_type", "state", "code_challenge", "code_challenge_method", "resource", "scope"}

// authRequest é um pedido de autorização já validado por parseAuthorize.
type authRequest struct {
	client      oauthClient
	clientID    string
	redirectURI string
	state       string
	challenge   string
}

// parseAuthorize valida um pedido de autorização. pageErr: o erro não pode voltar ao cliente (client_id ou
// redirect_uri errados) e só se mostra numa página. redirErr: o código de erro que volta no redirect_uri.
func (s *server) parseAuthorize(v url.Values) (req authRequest, pageErr bool, redirErr string) {
	req.clientID = v.Get("client_id")
	c, ok := s.parseClient(req.clientID)
	if !ok {
		return req, true, ""
	}
	req.client = c
	req.redirectURI = v.Get("redirect_uri")
	if req.redirectURI == "" && len(c.Redirects) == 1 {
		req.redirectURI = c.Redirects[0]
	}
	if !slices.Contains(c.Redirects, req.redirectURI) {
		return req, true, ""
	}
	req.state = v.Get("state")
	req.challenge = v.Get("code_challenge")
	switch {
	case v.Get("response_type") != "code":
		return req, false, "unsupported_response_type"
	case v.Get("code_challenge_method") != "S256" || len(req.challenge) < minVerifierLen || len(req.challenge) > maxVerifierLen:
		return req, false, "invalid_request"
	case v.Get("resource") != "" && v.Get("resource") != s.cfg.publicURL+"/mcp":
		return req, false, "invalid_target"
	}
	return req, false, ""
}

// withParams junta params à pesquisa de uri, mantendo a que já lá estiver.
func withParams(uri string, params url.Values) string {
	sep := "?"
	if strings.Contains(uri, "?") {
		sep = "&"
	}
	return uri + sep + params.Encode()
}

// redirectBack manda o browser de volta ao cliente com params (e o state, se o pedido o trouxe).
func redirectBack(w http.ResponseWriter, r *http.Request, req authRequest, params url.Values) {
	if req.state != "" {
		params.Set("state", req.state)
	}
	http.Redirect(w, r, withParams(req.redirectURI, params), http.StatusSeeOther)
}

// consentTexts: os textos da página de consentimento, que não passa pelo i18n.js da página (não tem JavaScript).
var consentTexts = map[string]map[string]string{
	"pt": {
		"title":      "Ligar ao Planeador de Férias",
		"asks":       "quer ligar-se às tuas viagens.",
		"back":       "Depois voltas para",
		"canWrite":   "Vai poder ver as viagens e juntar e mudar atividades, sítios e custos. Não pode apagar nada nem mudar o que está fixo, reservado, pago, só de leitura ou arquivado, e tudo o que mudar fica marcado com ✨.",
		"canRead":    "Só vai poder ver as viagens.",
		"user":       "Utilizador",
		"password":   "Palavra-passe",
		"allow":      "Permitir",
		"deny":       "Recusar",
		"errCreds":   "Utilizador ou palavra-passe errados.",
		"errTooMany": "Demasiadas tentativas. Tenta daqui a uns minutos.",
		"errInvalid": "Pedido de autorização inválido. Volta à aplicação e tenta ligar outra vez.",
	},
	"en": {
		"title":      "Connect to Planeador de Férias",
		"asks":       "wants to connect to your trips.",
		"back":       "Afterwards you go back to",
		"canWrite":   "It will be able to see the trips and add and change activities, places and costs. It can't delete anything or change what is fixed, booked, paid, read-only or archived, and everything it changes is marked with ✨.",
		"canRead":    "It will only be able to see the trips.",
		"user":       "User name",
		"password":   "Password",
		"allow":      "Allow",
		"deny":       "Deny",
		"errCreds":   "Wrong user name or password.",
		"errTooMany": "Too many attempts. Try again in a few minutes.",
		"errInvalid": "Invalid authorization request. Go back to the app and try connecting again.",
	},
}

// consentLang escolhe a língua da página: o campo lang do formulário (para manter a de antes) ou o
// Accept-Language (en… dá inglês, o resto português).
func consentLang(r *http.Request, form url.Values) string {
	if l := form.Get("lang"); l == "en" || l == "pt" {
		return l
	}
	if strings.HasPrefix(strings.ToLower(strings.TrimSpace(r.Header.Get("Accept-Language"))), "en") {
		return "en"
	}
	return "pt"
}

var consentTmpl = template.Must(template.New("consent").Parse(`<!doctype html>
<html lang="{{.Lang}}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>{{.T.title}}</title>
<style>
:root{color-scheme:light dark;--bg:#f6f4ef;--card:#fff;--ink:#222;--muted:#666;--line:#ddd;--accent:#2f6f5e;--err:#b3261e}
@media (prefers-color-scheme:dark){:root{--bg:#1b1b1b;--card:#262626;--ink:#eee;--muted:#aaa;--line:#444;--accent:#6fc2a8;--err:#f2b8b5}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.5 system-ui,sans-serif;display:flex;justify-content:center;padding:24px 16px}
main{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:24px;width:100%;max-width:420px}
h1{font-size:1.3rem;margin:0 0 12px}
p{margin:0 0 12px}
.muted{color:var(--muted);font-size:.9rem}
.err{color:var(--err);font-weight:600}
label{display:block;margin:12px 0 4px;font-weight:600}
input{width:100%;padding:10px;font:inherit;border:1px solid var(--line);border-radius:8px;background:var(--bg);color:var(--ink)}
.row{display:flex;gap:12px;margin-top:20px}
button{flex:1;padding:12px;font:inherit;font-weight:600;border-radius:8px;border:1px solid var(--accent);cursor:pointer}
.allow{background:var(--accent);color:var(--card)}
.deny{background:transparent;color:var(--ink);border-color:var(--line)}
</style>
</head>
<body>
<main>
<h1>{{.T.title}}</h1>
{{if .Error}}<p class="err" role="alert">{{.Error}}</p>{{end}}
{{if .Form}}
<p><strong>{{.ClientName}}</strong> {{.T.asks}}</p>
<p>{{if .ReadOnly}}{{.T.canRead}}{{else}}{{.T.canWrite}}{{end}}</p>
<p class="muted">{{.T.back}} {{.RedirectHost}}</p>
<form method="post" action="/oauth/authorize">
{{range .Hidden}}<input type="hidden" name="{{.Name}}" value="{{.Value}}">
{{end}}<input type="hidden" name="lang" value="{{.Lang}}">
<label for="user">{{.T.user}}</label>
<input id="user" name="user" autocomplete="username" autocapitalize="none" required>
<label for="password">{{.T.password}}</label>
<input id="password" name="password" type="password" autocomplete="current-password" required>
<div class="row">
<button class="deny" name="action" value="deny" formnovalidate>{{.T.deny}}</button>
<button class="allow" name="action" value="allow">{{.T.allow}}</button>
</div>
</form>
{{end}}
</main>
</body>
</html>
`))

// hiddenField é um campo escondido do formulário de consentimento.
type hiddenField struct{ Name, Value string }

// consentCSP é a CSP da página de consentimento: a global, com a origem do redirect_uri no form-action.
// O Chrome aplica o form-action também ao redirect que vem depois do POST, e sem isto bloqueava a volta ao cliente.
func consentCSP(redirectURI string) string {
	u, err := url.Parse(redirectURI)
	if err != nil {
		return csp
	}
	origin := u.Scheme + "://" + u.Host
	if !originRe.MatchString(origin) {
		return csp
	}
	return strings.Replace(csp, "form-action 'self'", "form-action 'self' "+origin, 1)
}

// renderConsent mostra a página de consentimento (form=false: só o erro, sem formulário).
func (s *server) renderConsent(w http.ResponseWriter, status int, lang string, req authRequest, form url.Values, errKey string, showForm bool) {
	t := consentTexts[lang]
	data := map[string]any{"Lang": lang, "T": t, "Form": showForm, "ReadOnly": s.cfg.mcpReadOnly, "ClientName": req.client.Name}
	if errKey != "" {
		data["Error"] = t[errKey]
	}
	h := w.Header()
	if showForm {
		u, _ := url.Parse(req.redirectURI)
		data["RedirectHost"] = u.Host
		if req.client.Name == "" {
			data["ClientName"] = u.Host
		}
		var hidden []hiddenField
		for _, k := range authFields {
			if v := form.Get(k); v != "" {
				hidden = append(hidden, hiddenField{k, v})
			}
		}
		data["Hidden"] = hidden
		h.Set("Content-Security-Policy", consentCSP(req.redirectURI))
	}
	h.Set("Content-Type", "text/html; charset=utf-8")
	h.Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	consentTmpl.Execute(w, data)
}

// oauthAuthorize trata do pedido de autorização: o GET mostra a página de consentimento e o POST recebe-a.
// A página pede o utilizador e a palavra-passe: o cookie da sessão é SameSite=Strict e não vem na navegação a
// partir do claude.ai. Os erros do POST contam para o mesmo limite de tentativas do login.
func (s *server) oauthAuthorize(w http.ResponseWriter, r *http.Request) {
	if s.oauthOff(w, r) {
		return
	}
	form := r.URL.Query()
	if r.Method == http.MethodPost {
		r.Body = http.MaxBytesReader(w, r.Body, maxOAuthBytes)
		if err := r.ParseForm(); err != nil {
			s.renderConsent(w, 400, consentLang(r, nil), authRequest{}, nil, "errInvalid", false)
			return
		}
		form = r.PostForm
	}
	lang := consentLang(r, form)
	req, pageErr, redirErr := s.parseAuthorize(form)
	if pageErr {
		s.renderConsent(w, 400, lang, req, form, "errInvalid", false)
		return
	}
	if redirErr != "" {
		redirectBack(w, r, req, url.Values{"error": {redirErr}})
		return
	}
	if r.Method != http.MethodPost {
		s.renderConsent(w, 200, lang, req, form, "", true)
		return
	}
	if form.Get("action") != "allow" {
		redirectBack(w, r, req, url.Values{"error": {"access_denied"}})
		return
	}
	ip := clientIP(r)
	if s.tooManyFailures(ip) {
		s.renderConsent(w, http.StatusTooManyRequests, lang, req, form, "errTooMany", true)
		return
	}
	okUser := constantTimeEqual(strings.TrimSpace(form.Get("user")), s.cfg.user)
	okPass := constantTimeEqual(form.Get("password"), s.cfg.password)
	if !okUser || !okPass {
		s.noteFailure(ip)
		time.Sleep(s.failDelay)
		s.renderConsent(w, http.StatusUnauthorized, lang, req, form, "errCreds", true)
		return
	}
	code := randomCode()
	s.storeCode(code, oauthCode{clientID: req.clientID, redirectURI: req.redirectURI, challenge: req.challenge, exp: s.now().Add(oauthCodeTTL)})
	redirectBack(w, r, req, url.Values{"code": {code}, "iss": {s.cfg.publicURL}})
}

/* ---------- tokens ---------- */

// pkceChallenge é o code_challenge S256 de um code_verifier: base64url(sha256(verifier)).
func pkceChallenge(verifier string) string {
	h := sha256.Sum256([]byte(verifier))
	return base64.RawURLEncoding.EncodeToString(h[:])
}

// oauthToken troca um código de autorização (com o PKCE) ou um token de renovação por tokens novos.
// Cada troca devolve também um token de renovação novo.
func (s *server) oauthToken(w http.ResponseWriter, r *http.Request) {
	if s.oauthOff(w, r) {
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, maxOAuthBytes)
	if err := r.ParseForm(); err != nil {
		oauthError(w, 400, "invalid_request", "corpo inválido")
		return
	}
	f := r.PostForm
	clientID := f.Get("client_id")
	switch f.Get("grant_type") {
	case "authorization_code":
		c, found := s.takeCode(f.Get("code")) // sai da memória antes de tudo: um código só se tenta uma vez
		if _, ok := s.parseClient(clientID); !ok {
			oauthError(w, http.StatusUnauthorized, "invalid_client", "client_id inválido")
			return
		}
		v := f.Get("code_verifier")
		switch {
		case !found || !s.now().Before(c.exp):
			oauthError(w, 400, "invalid_grant", "código inválido ou expirado")
			return
		case c.clientID != clientID || c.redirectURI != f.Get("redirect_uri"):
			oauthError(w, 400, "invalid_grant", "o código é de outro cliente ou redirect_uri")
			return
		case len(v) < minVerifierLen || len(v) > maxVerifierLen || !constantTimeEqual(pkceChallenge(v), c.challenge):
			oauthError(w, 400, "invalid_grant", "code_verifier errado")
			return
		}
	case "refresh_token":
		if _, ok := s.parseClient(clientID); !ok {
			oauthError(w, http.StatusUnauthorized, "invalid_client", "client_id inválido")
			return
		}
		if _, valid := s.checkOAuthToken(f.Get("refresh_token"), "rt", clientID); !valid {
			oauthError(w, 400, "invalid_grant", "refresh_token inválido ou expirado")
			return
		}
	case "":
		oauthError(w, 400, "invalid_request", "falta grant_type")
		return
	default:
		oauthError(w, 400, "unsupported_grant_type", "grant_type desconhecido")
		return
	}
	writeJSON(w, 200, map[string]any{
		"access_token":  s.newOAuthToken("at", clientID, accessTokenTTL),
		"token_type":    "Bearer",
		"expires_in":    int(accessTokenTTL.Seconds()),
		"refresh_token": s.newOAuthToken("rt", clientID, refreshTokenTTL),
		"scope":         oauthScope,
	})
}
