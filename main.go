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
	"time"
)

type config struct {
	user, password, dataDir, addr string
	homeTz                        string // segundo fuso mostrado na grelha (opcional)
}

type server struct {
	cfg     config
	key     []byte // chave de assinatura das sessões
	mu      sync.Mutex
	static  map[string]staticFile
	handler http.Handler // as rotas (ver routes)

	// viagens já lidas do disco (protegidas por mu, ver loadRecord)
	cache      map[string]*cachedRec
	cacheBytes int64

	limMu    sync.Mutex
	failures map[string][]time.Time

	// Efeitos externos. newServer preenche-os com os valores reais; os testes trocam-nos
	// (relógio fixo, sem espera, cache pequena, disco que falha, log para um buffer).
	now       func() time.Time           // sessões, tentativas de login, updatedAt e nomes das cópias
	failDelay time.Duration              // espera depois de um login falhado
	maxCache  int64                      // bytes de viagens guardados em memória (ver remember)
	writeFile func(string, []byte) error // gravação das viagens e das cópias
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
		now:       time.Now,
		failDelay: 400 * time.Millisecond,
		maxCache:  16 << 20, // o contentor tem 64 MB
		writeFile: writeAtomic,
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

// loadConfig lê e valida a configuração do ambiente (getenv é os.Getenv; os testes passam um mapa).
func loadConfig(getenv func(string) string) (config, error) {
	env := func(k, def string) string {
		if v := getenv(k); v != "" {
			return v
		}
		return def
	}
	cfg := config{
		user:     getenv("PLANNER_USER"),
		password: getenv("PLANNER_PASSWORD"),
		dataDir:  env("DATA_DIR", "./data"),
		addr:     ":" + env("PORT", "8080"),
		homeTz:   strings.TrimSpace(getenv("PLANNER_HOME_TZ")),
	}
	if cfg.user == "" || cfg.password == "" {
		return cfg, errors.New("define PLANNER_USER e PLANNER_PASSWORD antes de arrancar (ver .env.example)")
	}
	if len(cfg.password) < 10 {
		return cfg, errors.New("PLANNER_PASSWORD tem de ter pelo menos 10 caracteres")
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
	log.Printf("Planeador de Férias a ouvir em %s · dados em %s · utilizador %q", cfg.addr, cfg.dataDir, cfg.user)
	log.Fatal(srv.ListenAndServe())
}
