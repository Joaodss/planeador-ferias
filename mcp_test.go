package main

import (
	"net/http"
	"strings"
	"testing"
)

/* ---------- transporte e autenticação ---------- */

func TestMCPOffWithoutToken(t *testing.T) {
	t.Parallel()
	s := newTestServer(t)
	for _, m := range []string{"POST", "GET"} {
		w := call(s, m, "/mcp", `{"jsonrpc":"2.0","id":1,"method":"ping"}`, withHeader("Authorization", "Bearer "+testMCPToken))
		if w.Code != http.StatusNotFound {
			t.Errorf("%s /mcp sem PLANNER_MCP_TOKEN: código %d, esperava 404", m, w.Code)
		}
	}
}

func TestMCPAuth(t *testing.T) {
	t.Parallel()
	s, _ := newMCPServer(t)
	ping := `{"jsonrpc":"2.0","id":1,"method":"ping"}`
	for name, h := range map[string]string{"sem token": "", "token errado": "Bearer " + strings.Repeat("e", minMCPTokenLen), "sem Bearer": testMCPToken} {
		w := call(s, "POST", "/mcp", ping, withoutCSRF, withIP("10.0.0.1"), withHeader("Authorization", h))
		if w.Code != http.StatusUnauthorized || !strings.HasPrefix(w.Header().Get("WWW-Authenticate"), "Bearer") {
			t.Errorf("%s: código %d, WWW-Authenticate %q", name, w.Code, w.Header().Get("WWW-Authenticate"))
		}
	}
	// as falhas contam para o mesmo limite do login: quem tenta adivinhar o token fica bloqueado
	for i := 3; i < maxFailuresPerIP; i++ {
		call(s, "POST", "/mcp", ping, withoutCSRF, withIP("10.0.0.1"))
	}
	if w := mcpPost(s, ping, withIP("10.0.0.1")); w.Code != http.StatusTooManyRequests {
		t.Errorf("depois de %d falhas: código %d, esperava 429 mesmo com o token certo", maxFailuresPerIP, w.Code)
	}
	if w := mcpPost(s, ping, withIP("10.0.0.2")); w.Code != 200 {
		t.Errorf("outro endereço com o token certo: código %d", w.Code)
	}
	// o /mcp não precisa do X-Requested-With (mcpPost tira-o): o token já não é uma credencial automática do browser
}

func TestMCPOrigin(t *testing.T) {
	t.Parallel()
	s, _ := newMCPServer(t)
	ping := `{"jsonrpc":"2.0","id":1,"method":"ping"}`
	if w := mcpPost(s, ping, withHeader("Origin", "https://outro.site")); w.Code != http.StatusForbidden {
		t.Errorf("Origin de outro site: código %d, esperava 403", w.Code)
	}
	if w := mcpPost(s, ping, withHeader("Origin", "http://example.com")); w.Code != 200 { // httptest usa Host example.com
		t.Errorf("Origin do próprio servidor: código %d", w.Code)
	}
}

func TestMCPProtocol(t *testing.T) {
	t.Parallel()
	s, _ := newMCPServer(t)

	r := rpc(t, s, "initialize", `{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"teste","version":"1"}}`)
	if r.Result["protocolVersion"] != "2025-06-18" || string(r.ID) != "7" {
		t.Errorf("initialize com uma versão conhecida: %v (id %s)", r.Result, r.ID)
	}
	if caps, _ := r.Result["capabilities"].(map[string]any); caps["tools"] == nil {
		t.Errorf("initialize sem capabilities.tools: %v", r.Result)
	}
	if r := rpc(t, s, "initialize", `{"protocolVersion":"1999-01-01"}`); r.Result["protocolVersion"] != mcpProtocolVersions[0] {
		t.Errorf("versão desconhecida: devia propor a mais recente, veio %v", r.Result["protocolVersion"])
	}
	if r := rpc(t, s, "ping", ""); r.Error != nil || r.Result == nil {
		t.Errorf("ping: %+v", r)
	}
	if r := rpc(t, s, "resources/list", ""); r.Error == nil || r.Error.Code != rpcMethodNotFound {
		t.Errorf("método desconhecido: %+v", r.Error)
	}
	if r := rpc(t, s, "tools/call", `{"name":"apagar_tudo"}`); r.Error == nil || r.Error.Code != rpcInvalidParams {
		t.Errorf("ferramenta desconhecida: %+v", r.Error)
	}
	if r := rpc(t, s, "tools/call", `[1]`); r.Error == nil || r.Error.Code != rpcInvalidParams {
		t.Errorf("parâmetros que não são um objeto: %+v", r.Error)
	}

	// uma notificação não tem resposta
	if w := mcpPost(s, `{"jsonrpc":"2.0","method":"notifications/initialized"}`); w.Code != http.StatusAccepted || w.Body.Len() != 0 {
		t.Errorf("notificação: código %d, corpo %q", w.Code, w.Body.String())
	}
	for name, tc := range map[string]struct {
		body string
		code int
	}{
		"JSON partido":    {`{"jsonrpc":`, rpcParseError},
		"lote (array)":    {`[{"jsonrpc":"2.0","id":1,"method":"ping"}]`, rpcParseError},
		"sem jsonrpc 2.0": {`{"jsonrpc":"1.0","id":1,"method":"ping"}`, rpcInvalidRequest},
		"sem método":      {`{"jsonrpc":"2.0","id":1}`, rpcInvalidRequest},
	} {
		got := decode[rpcReply](t, mcpPost(s, tc.body))
		if got.Error == nil || got.Error.Code != tc.code {
			t.Errorf("%s: erro %+v, esperava o código %d", name, got.Error, tc.code)
		}
	}

	if w := mcpPost(s, `{"jsonrpc":"2.0","id":1,"method":"ping","params":"`+strings.Repeat("x", maxTripBytes)+`"}`); w.Code != http.StatusRequestEntityTooLarge {
		t.Errorf("pedido acima de maxTripBytes: código %d", w.Code)
	}
	w := call(s, "GET", "/mcp", "", withHeader("Authorization", "Bearer "+testMCPToken))
	if w.Code != http.StatusMethodNotAllowed || w.Header().Get("Allow") != "POST" {
		t.Errorf("GET /mcp (sem SSE): código %d, Allow %q", w.Code, w.Header().Get("Allow"))
	}
	if w.Header().Get("Content-Security-Policy") == "" {
		t.Error("o /mcp também leva os cabeçalhos de segurança")
	}
}

func TestMCPToolsList(t *testing.T) {
	t.Parallel()
	s, _ := newMCPServer(t)
	names := func() []string {
		var out []string
		for _, x := range rpc(t, s, "tools/list", "").Result["tools"].([]any) {
			tl := x.(map[string]any)
			schema, _ := tl["inputSchema"].(map[string]any)
			if tl["description"] == "" || schema["type"] != "object" || tl["annotations"] == nil {
				t.Errorf("%v: falta a descrição, o esquema ou as anotações", tl["name"])
			}
			out = append(out, tl["name"].(string))
		}
		return out
	}
	all := names()
	if len(all) != len(mcpTools) {
		t.Errorf("tools/list tem %d ferramentas, esperava %d", len(all), len(mcpTools))
	}
	for _, n := range all {
		if strings.Contains(n, "delete") || strings.Contains(n, "remove") {
			t.Errorf("a IA não pode ter ferramentas para apagar: %s", n)
		}
	}

	s.cfg.mcpReadOnly = true
	ro := names()
	for _, n := range ro {
		if s.findTool(n).write {
			t.Errorf("em modo só de leitura a lista não devia ter %s", n)
		}
	}
	if len(ro) == 0 || len(ro) == len(all) {
		t.Errorf("modo só de leitura: %v", ro)
	}
	if r := tool(t, s, "create_trip", `{"name":"x","start":"2026-01-01","end":"2026-01-02"}`); !strings.Contains(r.errMsg, "só de leitura") {
		t.Errorf("uma ferramenta que escreve em modo só de leitura: %q", r.errMsg)
	}
}

func TestMCPState(t *testing.T) {
	t.Parallel()
	for want, cfg := range map[string]config{
		"desligado":         {},
		"só leitura":        {mcpToken: "x", mcpReadOnly: true},
		"leitura e escrita": {mcpToken: "x"},
	} {
		if got := mcpState(cfg); got != want {
			t.Errorf("mcpState(%+v) = %q, esperava %q", cfg, got, want)
		}
	}
}
