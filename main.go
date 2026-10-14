// Planeador de Férias — servidor.
//
// Um único binário sem dependências externas: serve a página, trata do login
// e guarda cada viagem num ficheiro JSON próprio dentro de DATA_DIR.
//
// O código está repartido por ficheiros do mesmo package:
//
//	main.go    configuração e arranque
//	routes.go  rotas, cabeçalhos de segurança, guarda CSRF e respostas JSON
//	auth.go    login, sessões e limite de tentativas
//	trips.go   leitura, gravação e cópias de segurança das viagens
//	static.go  ficheiros da página (embutidos no binário)
//	mcp.go     servidor MCP em /mcp (JSON-RPC), para um assistente de IA ler e editar as viagens
//	mcptools.go as ferramentas MCP: o que a IA pode ler e mudar
//	oauth.go   autorização OAuth 2.1 do /mcp, para ligar o planeador no claude.ai
//	tripedit.go regras das alterações feitas pela IA (o espelho de clean.js e trip.js de que precisam)
package main

import (
	"errors"
	"flag"
	"fmt"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

// config é a configuração lida do ambiente por loadConfig. addr já vem como ":<PORT>".
type config struct {
	user, password, dataDir, addr string
	homeTz                        string // segundo fuso mostrado na grelha (opcional)
	mcpToken                      string // PLANNER_MCP_TOKEN: sem ele o /mcp fica desligado
	mcpReadOnly                   bool   // PLANNER_MCP_MODE=read: a IA só pode ler
	publicURL                     string // PLANNER_PUBLIC_URL: liga o OAuth do /mcp (ver oauth.go)
}

// mcpOn diz se o /mcp está ligado: com o token fixo, com o OAuth, ou com os dois.
func (c config) mcpOn() bool { return c.mcpToken != "" || c.publicURL != "" }

// server guarda o estado do servidor. Os ficheiros, a cache e as falhas de login são partilhados por todos os
// pedidos, por isso têm o seu mutex; o resto é preenchido por newServer e depois só é lido.
type server struct {
	cfg     config
	key     []byte // chave de assinatura das sessões
	static  map[string]staticFile
	handler http.Handler // as rotas (ver routes)

	// tripsMu serializa as leituras e gravações dos ficheiros das viagens e protege a cache
	// das viagens já lidas do disco (ver loadRecord): cache e cacheBytes. Invariante, mantido por
	// remember e forget: cacheBytes é a soma de len(c.raw) de todas as entradas de cache (≤ maxCache).
	tripsMu    sync.Mutex
	cache      map[string]*cachedRec
	cacheBytes int64

	// failuresMu protege as horas dos logins falhados de cada endereço (ver tooManyFailures).
	failuresMu sync.Mutex
	failures   map[string][]time.Time

	// codesMu protege os códigos de autorização do OAuth ainda por trocar (ver oauthCode).
	codesMu sync.Mutex
	codes   map[string]oauthCode

	idSeq atomic.Uint64 // contador dos ids criados pela IA (ver newID)

	// Efeitos externos. newServer preenche-os com os valores reais; os testes trocam-nos
	// (relógio fixo, sem espera, cache pequena, disco que falha, log para um buffer).
	now       func() time.Time           // sessões, tentativas de login, updatedAt e nomes das cópias
	failDelay time.Duration              // espera depois de um login falhado
	maxCache  int64                      // bytes de viagens guardados em memória (ver remember)
	writeFile func(string, []byte) error // gravação das viagens e das cópias
	idRand    func() int64               // parte aleatória dos ids criados pela IA (ver newID)
	log       *log.Logger                // avisos de ficheiros ilegíveis e gravações falhadas
}

// newServer cria as pastas de dados, prepara a chave das sessões e a página e monta as rotas.
func newServer(cfg config) (*server, error) {
	for _, d := range []string{"trips", "backups"} {
		if err := os.MkdirAll(filepath.Join(cfg.dataDir, d), 0o700); err != nil {
			return nil, fmt.Errorf("pasta de dados: %w", err)
		}
	}
	s := &server{
		cfg:       cfg,
		failures:  map[string][]time.Time{},
		codes:     map[string]oauthCode{},
		now:       time.Now,
		failDelay: loginFailDelay,
		maxCache:  16 << 20, // o contentor tem 64 MB
		writeFile: writeAtomic,
		idRand:    randomID4,
		log:       log.Default(),
	}
	if err := s.loadKey(); err != nil {
		return nil, fmt.Errorf("chave das sessões: %w", err)
	}
	if err := s.loadStatic(webFS); err != nil {
		return nil, fmt.Errorf("página: %w", err)
	}
	s.handler = s.routes()
	return s, nil
}

// minPasswordLen: a palavra-passe é a única proteção de uma página aberta à internet e o limite de tentativas
// (ver tooManyFailures) só abranda quem a tenta adivinhar. Uma palavra-passe curta não aguentava muito tempo.
const minPasswordLen = 10

// minMCPTokenLen: o token do MCP dá acesso às viagens sem login e não passa pelo limite de tentativas
// por endereço de forma tão lenta como a palavra-passe (não há espera depois de uma falha), por isso tem de ser longo.
const minMCPTokenLen = 32

// loadConfig lê e valida a configuração do ambiente (getenv é os.Getenv; os testes passam um mapa).
func loadConfig(getenv func(string) string) (config, error) {
	// env: a variável k, ou def se estiver vazia ou não existir.
	env := func(k, def string) string {
		if v := getenv(k); v != "" {
			return v
		}
		return def
	}
	cfg := config{
		user:      getenv("PLANNER_USER"),
		password:  getenv("PLANNER_PASSWORD"),
		dataDir:   env("DATA_DIR", "./data"),
		addr:      ":" + env("PORT", "8080"),
		homeTz:    strings.TrimSpace(getenv("PLANNER_HOME_TZ")),
		mcpToken:  strings.TrimSpace(getenv("PLANNER_MCP_TOKEN")),
		publicURL: strings.TrimSpace(getenv("PLANNER_PUBLIC_URL")),
	}
	if cfg.user == "" || cfg.password == "" {
		return cfg, errors.New("define PLANNER_USER e PLANNER_PASSWORD antes de arrancar (ver .env.example)")
	}
	if len(cfg.password) < minPasswordLen {
		return cfg, fmt.Errorf("PLANNER_PASSWORD tem de ter pelo menos %d caracteres", minPasswordLen)
	}
	if cfg.mcpToken != "" && len(cfg.mcpToken) < minMCPTokenLen {
		return cfg, fmt.Errorf("PLANNER_MCP_TOKEN tem de ter pelo menos %d caracteres", minMCPTokenLen)
	}
	if cfg.publicURL != "" && !validPublicURL(cfg.publicURL) {
		return cfg, errors.New("PLANNER_PUBLIC_URL tem de ser https://servidor (ou http:// só para localhost), sem caminho nem / no fim")
	}
	switch getenv("PLANNER_MCP_MODE") {
	case "", "write":
	case "read":
		cfg.mcpReadOnly = true
	default:
		return cfg, errors.New("PLANNER_MCP_MODE tem de ser read ou write")
	}
	return cfg, nil
}

// healthcheck pede url (o /healthz do próprio servidor) e só aceita um 200.
// É a flag -healthcheck, usada pelo HEALTHCHECK do Docker: a imagem FROM scratch não tem curl.
func healthcheck(url string) error {
	c := http.Client{Timeout: 3 * time.Second}
	r, err := c.Get(url)
	if err != nil {
		return err
	}
	r.Body.Close()
	if r.StatusCode != http.StatusOK {
		return fmt.Errorf("%s respondeu %s", url, r.Status)
	}
	return nil
}

func main() {
	health := flag.Bool("healthcheck", false, "verifica se o servidor responde e sai")
	flag.Parse()

	if *health {
		port := os.Getenv("PORT")
		if port == "" {
			port = "8080"
		}
		if err := healthcheck("http://127.0.0.1:" + port + "/healthz"); err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
		return
	}

	cfg, err := loadConfig(os.Getenv)
	if err != nil {
		log.Fatalf("Não consigo arrancar: %v.", err)
	}
	s, err := newServer(cfg)
	if err != nil {
		log.Fatalf("Não consigo arrancar: %v", err)
	}

	srv := &http.Server{
		Addr:              cfg.addr,
		Handler:           s,
		ReadHeaderTimeout: 10 * time.Second,
		ReadTimeout:       30 * time.Second,
		WriteTimeout:      60 * time.Second,
		IdleTimeout:       120 * time.Second,
	}
	log.Printf("Planeador de Férias a ouvir em %s · dados em %s · utilizador %q · MCP %s", cfg.addr, cfg.dataDir, cfg.user, mcpState(cfg))
	log.Fatal(srv.ListenAndServe())
}
