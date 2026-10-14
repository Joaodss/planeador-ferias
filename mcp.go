package main

// Servidor MCP (Model Context Protocol) em POST /mcp, para um assistente de IA ler e editar as viagens.
//
// Só a parte do transporte "Streamable HTTP" que um servidor sem estado precisa: cada POST traz uma mensagem
// JSON-RPC 2.0 e recebe uma resposta em application/json. Não há SSE nem Mcp-Session-Id. As ferramentas estão
// em mcptools.go e as regras do que a IA pode mudar em tripedit.go.

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/url"
	"slices"
	"strings"
)

// mcpProtocolVersions: as versões do protocolo que este servidor fala, da mais recente para a mais antiga.
// O initialize devolve a que o cliente pedir, se estiver aqui; senão a primeira.
var mcpProtocolVersions = []string{"2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"}

// Códigos de erro do JSON-RPC 2.0.
const (
	rpcParseError     = -32700
	rpcInvalidRequest = -32600
	rpcMethodNotFound = -32601
	rpcInvalidParams  = -32602
)

// mcpInstructions vai no initialize: o que o assistente deve saber antes de usar as ferramentas.
const mcpInstructions = `Planeador de Férias: viagens com atividades num quadro de horas.
Datas em AAAA-MM-DD e horas em "HH:MM", sempre na hora local da viagem. Durações em minutos.
A IA não apaga nada: para tirar uma atividade do plano, manda-a para "por agendar" (move_activity com to_tray).
Atividades fixas (locked), reservadas ou pagas, custos pagos e viagens só de leitura ou arquivadas não podem ser mudados.
Tudo o que a IA muda fica marcado na página para o utilizador ver; undo_last_ai_change desfaz a última alteração.`

// rpcRequest é uma mensagem JSON-RPC recebida. Sem id é uma notificação, que não tem resposta.
type rpcRequest struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id"`
	Method  string          `json:"method"`
	Params  json.RawMessage `json:"params"`
}

type rpcError struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
}

type rpcResponse struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id"`
	Result  any             `json:"result,omitempty"`
	Error   *rpcError       `json:"error,omitempty"`
}

// mcpState descreve no log de arranque se o MCP está ligado e em que modo.
func mcpState(cfg config) string {
	switch {
	case cfg.mcpToken == "":
		return "desligado"
	case cfg.mcpReadOnly:
		return "só leitura"
	default:
		return "leitura e escrita"
	}
}

// sameOrigin diz se o cabeçalho Origin (quando existe) é o próprio servidor. O protocolo pede esta verificação
// contra DNS rebinding: uma página noutro site não pode falar com o /mcp através do browser de quem a abre.
func sameOrigin(r *http.Request) bool {
	o := r.Header.Get("Origin")
	if o == "" {
		return true
	}
	u, err := url.Parse(o)
	return err == nil && strings.EqualFold(u.Host, r.Host)
}

// mcpAuthorized confirma o token em Authorization: Bearer, com o mesmo limite de tentativas do login.
// Responde ele próprio quando recusa.
func (s *server) mcpAuthorized(w http.ResponseWriter, r *http.Request) bool {
	ip := clientIP(r)
	if s.tooManyFailures(ip) {
		writeError(w, http.StatusTooManyRequests, "demasiadas tentativas")
		return false
	}
	tok, ok := strings.CutPrefix(r.Header.Get("Authorization"), "Bearer ")
	if !ok || !constantTimeEqual(strings.TrimSpace(tok), s.cfg.mcpToken) {
		s.noteFailure(ip)
		w.Header().Set("WWW-Authenticate", `Bearer realm="planeador-ferias"`)
		writeError(w, http.StatusUnauthorized, "token em falta ou errado")
		return false
	}
	return true
}

// mcpGet responde ao GET /mcp: este servidor não abre um canal SSE (o protocolo aceita um 405).
func (s *server) mcpGet(w http.ResponseWriter, _ *http.Request) {
	if s.cfg.mcpToken == "" {
		http.NotFound(w, nil)
		return
	}
	w.Header().Set("Allow", http.MethodPost)
	writeError(w, http.StatusMethodNotAllowed, "só POST")
}

// mcp trata um POST /mcp: autentica, lê uma mensagem JSON-RPC e responde-lhe.
// Sem PLANNER_MCP_TOKEN responde 404, como se o caminho não existisse.
func (s *server) mcp(w http.ResponseWriter, r *http.Request) {
	if s.cfg.mcpToken == "" {
		http.NotFound(w, r)
		return
	}
	if !sameOrigin(r) {
		writeError(w, http.StatusForbidden, "origem recusada")
		return
	}
	if !s.mcpAuthorized(w, r) {
		return
	}
	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, maxTripBytes))
	if errors.As(err, new(*http.MaxBytesError)) {
		writeError(w, http.StatusRequestEntityTooLarge, "pedido demasiado grande")
		return
	}
	var req rpcRequest
	if err != nil || json.Unmarshal(body, &req) != nil {
		writeJSON(w, 200, rpcResponse{JSONRPC: "2.0", ID: json.RawMessage("null"), Error: &rpcError{rpcParseError, "JSON inválido"}})
		return
	}
	if len(req.ID) == 0 { // notificação (notifications/initialized, notifications/cancelled, …): não tem resposta
		w.WriteHeader(http.StatusAccepted)
		return
	}
	resp := rpcResponse{JSONRPC: "2.0", ID: req.ID}
	if req.JSONRPC != "2.0" || req.Method == "" {
		resp.Error = &rpcError{rpcInvalidRequest, "pedido JSON-RPC inválido"}
	} else {
		resp.Result, resp.Error = s.mcpDispatch(req.Method, req.Params)
	}
	writeJSON(w, 200, resp)
}

// mcpDispatch responde a um método do protocolo.
func (s *server) mcpDispatch(method string, params json.RawMessage) (any, *rpcError) {
	switch method {
	case "initialize":
		var p struct {
			ProtocolVersion string `json:"protocolVersion"`
		}
		json.Unmarshal(params, &p) // sem versão (ou ilegível) fica a mais recente
		v := mcpProtocolVersions[0]
		if slices.Contains(mcpProtocolVersions, p.ProtocolVersion) {
			v = p.ProtocolVersion
		}
		return map[string]any{
			"protocolVersion": v,
			"capabilities":    map[string]any{"tools": map[string]any{"listChanged": false}},
			"serverInfo":      map[string]string{"name": "planeador-ferias", "title": "Planeador de Férias", "version": "1"},
			"instructions":    mcpInstructions,
		}, nil
	case "ping":
		return map[string]any{}, nil
	case "tools/list":
		return map[string]any{"tools": s.visibleTools()}, nil
	case "tools/call":
		var p struct {
			Name      string          `json:"name"`
			Arguments json.RawMessage `json:"arguments"`
		}
		if err := json.Unmarshal(params, &p); err != nil {
			return nil, &rpcError{rpcInvalidParams, "parâmetros inválidos"}
		}
		t := s.findTool(p.Name)
		if t == nil {
			return nil, &rpcError{rpcInvalidParams, "ferramenta desconhecida: " + p.Name}
		}
		return s.callTool(t, p.Arguments), nil
	}
	return nil, &rpcError{rpcMethodNotFound, "método desconhecido: " + method}
}

// toolError é um erro que a IA pode corrigir (uma atividade que não existe, uma hora mal escrita, uma regra):
// volta como resultado com isError, para o modelo o ler, e não como erro do protocolo.
type toolError struct{ msg string }

func (e *toolError) Error() string { return e.msg }

// callTool corre a ferramenta t e embrulha o resultado como o protocolo pede: o JSON em structuredContent e,
// para os clientes que só leem texto, o mesmo JSON num bloco de texto.
func (s *server) callTool(t *mcpTool, args json.RawMessage) map[string]any {
	fail := func(msg string) map[string]any {
		return map[string]any{"content": []map[string]string{{"type": "text", "text": msg}}, "isError": true}
	}
	if t.write && s.cfg.mcpReadOnly {
		return fail("o MCP está em modo só de leitura (PLANNER_MCP_MODE=read)")
	}
	if len(args) == 0 || string(args) == "null" {
		args = json.RawMessage("{}")
	}
	out, err := t.run(s, args)
	if err != nil {
		var te *toolError
		if errors.As(err, &te) {
			return fail(te.msg)
		}
		s.log.Printf("erro na ferramenta MCP %s: %v", t.Name, err)
		return fail("erro do servidor: não consegui ler ou gravar a viagem")
	}
	b, _ := json.Marshal(out)
	return map[string]any{"content": []map[string]string{{"type": "text", "text": string(b)}}, "structuredContent": out}
}
