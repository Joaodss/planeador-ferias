package main

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

/* ---------- arranque ---------- */

func TestNewServerErrors(t *testing.T) {
	t.Parallel()
	t.Run("DATA_DIR é um ficheiro", func(t *testing.T) {
		p := filepath.Join(t.TempDir(), "dados")
		os.WriteFile(p, []byte("x"), 0o600)
		_, err := newServer(config{user: testUser, password: testPass, dataDir: p})
		if err == nil || !strings.Contains(err.Error(), "pasta de dados") {
			t.Fatalf("esperava um erro da pasta de dados, veio %v", err)
		}
	})
	t.Run(".session-secret é uma pasta", func(t *testing.T) {
		dir := t.TempDir()
		os.Mkdir(filepath.Join(dir, ".session-secret"), 0o700)
		_, err := newServer(config{user: testUser, password: testPass, dataDir: dir})
		if err == nil || !strings.Contains(err.Error(), "chave das sessões") {
			t.Fatalf("esperava um erro da chave das sessões, veio %v", err)
		}
	})
}

func TestLoadConfig(t *testing.T) {
	t.Parallel()
	// as palavras-passe vêm de testPass e de strings.Repeat: nada parecido com um segredo escrito no código
	env := func(m map[string]string) func(string) string { return func(k string) string { return m[k] } }
	ok := map[string]string{"PLANNER_USER": "eu", "PLANNER_PASSWORD": testPass}

	cfg, err := loadConfig(env(ok))
	if err != nil {
		t.Fatal(err)
	}
	if want := (config{user: "eu", password: testPass, dataDir: "./data", addr: ":8080"}); cfg != want {
		t.Errorf("valores por omissão: %+v, esperava %+v", cfg, want)
	}

	cfg, err = loadConfig(env(map[string]string{
		"PLANNER_USER": "eu", "PLANNER_PASSWORD": testPass,
		"DATA_DIR": "/data", "PORT": "9000", "PLANNER_HOME_TZ": "  Europe/Lisbon ",
	}))
	if err != nil || cfg.dataDir != "/data" || cfg.addr != ":9000" || cfg.homeTz != "Europe/Lisbon" {
		t.Errorf("com todas as variáveis: %+v, %v", cfg, err)
	}

	for name, m := range map[string]map[string]string{
		"sem nada":            {},
		"sem utilizador":      {"PLANNER_PASSWORD": testPass},
		"sem palavra-passe":   {"PLANNER_USER": "eu"},
		"palavra-passe curta": {"PLANNER_USER": "eu", "PLANNER_PASSWORD": strings.Repeat("x", minPasswordLen-1)},
		"palavra-passe vazia": {"PLANNER_USER": "eu", "PLANNER_PASSWORD": ""},
	} {
		if _, err := loadConfig(env(m)); err == nil {
			t.Errorf("%s: devia dar erro", name)
		}
	}
	if _, err := loadConfig(env(map[string]string{"PLANNER_USER": "eu", "PLANNER_PASSWORD": strings.Repeat("x", minPasswordLen)})); err != nil {
		t.Errorf("palavra-passe com %d caracteres: %v", minPasswordLen, err)
	}
}

func TestHealthcheck(t *testing.T) {
	t.Parallel()
	s := newTestServer(t)
	ok := httptest.NewServer(s)
	defer ok.Close()
	if err := healthcheck(ok.URL + "/healthz"); err != nil {
		t.Errorf("servidor a responder: %v", err)
	}
	if err := healthcheck(ok.URL + "/nao-existe"); err == nil || !strings.Contains(err.Error(), "404") {
		t.Errorf("um 404 devia dar erro com o código: %v", err)
	}
	down := httptest.NewServer(http.NotFoundHandler())
	down.Close()
	if err := healthcheck(down.URL + "/healthz"); err == nil {
		t.Error("sem servidor devia dar erro")
	}
}
