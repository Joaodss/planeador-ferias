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
}

// newServer cria as pastas de dados, prepara a chave das sessões e a página e monta as rotas.
func newServer(cfg config) (*server, error) {
	for _, d := range []string{"trips", "backups"} {
		if err := os.MkdirAll(filepath.Join(cfg.dataDir, d), 0o700); err != nil {
			return nil, fmt.Errorf("pasta de dados: %w", err)
		}
	}
	s := &server{cfg: cfg, failures: map[string][]time.Time{}}
	if err := s.loadKey(); err != nil {
		return nil, fmt.Errorf("chave das sessões: %w", err)
	}
	if err := s.loadStatic(); err != nil {
		return nil, fmt.Errorf("página: %w", err)
	}
	s.handler = s.routes()
	return s, nil
}

func env(k, def string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return def
}

func main() {
	health := flag.Bool("healthcheck", false, "verifica se o servidor responde e sai")
	flag.Parse()

	port := env("PORT", "8080")
	if *health {
		c := http.Client{Timeout: 3 * time.Second}
		r, err := c.Get("http://127.0.0.1:" + port + "/healthz")
		if err != nil || r.StatusCode != 200 {
			os.Exit(1)
		}
		return
	}

	cfg := config{
		user:     env("PLANNER_USER", ""),
		password: env("PLANNER_PASSWORD", ""),
		dataDir:  env("DATA_DIR", "./data"),
		addr:     ":" + port,
		homeTz:   strings.TrimSpace(env("PLANNER_HOME_TZ", "")),
	}
	if cfg.user == "" || cfg.password == "" {
		log.Fatal("Define PLANNER_USER e PLANNER_PASSWORD antes de arrancar (ver .env.example).")
	}
	if len(cfg.password) < 10 {
		log.Fatal("PLANNER_PASSWORD tem de ter pelo menos 10 caracteres.")
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
