package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

/* ---------- arranque ---------- */

func TestNewServerErrors(t *testing.T) {
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
