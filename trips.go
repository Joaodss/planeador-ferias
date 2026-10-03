package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"io/fs"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

const (
	maxBody     = 2 << 20 // 2 MB por viagem
	backupsKept = 30
)

// record é o que fica em disco para cada viagem.
type record struct {
	Rev       int64           `json:"rev"`
	UpdatedAt string          `json:"updatedAt"`
	Trip      json.RawMessage `json:"trip"`
}

func (s *server) tripPath(id string) string {
	return filepath.Join(s.cfg.dataDir, "trips", id+".json")
}

func readRecord(p string) (*record, error) {
	b, err := os.ReadFile(p)
	if err != nil {
		return nil, err
	}
	var rec record
	if err := json.Unmarshal(b, &rec); err != nil {
		return nil, err
	}
	return &rec, nil
}

// writeAtomic escreve para um ficheiro temporário e só depois o troca pelo final,
// para nunca deixar uma viagem a meio se o servidor for abaixo.
func writeAtomic(p string, data []byte) error {
	tmp, err := os.CreateTemp(filepath.Dir(p), ".tmp-*")
	if err != nil {
		return err
	}
	defer os.Remove(tmp.Name())
	if _, err := tmp.Write(data); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Sync(); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	if err := os.Chmod(tmp.Name(), 0o600); err != nil {
		return err
	}
	return os.Rename(tmp.Name(), p)
}

func (s *server) listTrips(w http.ResponseWriter) {
	s.mu.Lock()
	defer s.mu.Unlock()
	entries, err := os.ReadDir(filepath.Join(s.cfg.dataDir, "trips"))
	if err != nil {
		fail(w, 500, "não consigo ler os dados")
		return
	}
	trips := []*record{}
	for _, e := range entries {
		if e.IsDir() || !strings.HasSuffix(e.Name(), ".json") {
			continue
		}
		rec, err := readRecord(filepath.Join(s.cfg.dataDir, "trips", e.Name()))
		if err != nil {
			log.Printf("aviso: %s ilegível: %v", e.Name(), err)
			continue
		}
		trips = append(trips, rec)
	}
	writeJSON(w, 200, map[string]any{"user": s.cfg.user, "trips": trips, "homeTz": s.cfg.homeTz})
}

func (s *server) putTrip(w http.ResponseWriter, r *http.Request, id string) {
	var in struct {
		BaseRev int64           `json:"baseRev"`
		Trip    json.RawMessage `json:"trip"`
	}
	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, maxBody))
	if err != nil {
		fail(w, http.StatusRequestEntityTooLarge, "viagem demasiado grande")
		return
	}
	if err := json.Unmarshal(body, &in); err != nil {
		fail(w, http.StatusBadRequest, "JSON inválido")
		return
	}
	var head struct {
		ID string `json:"id"`
	}
	if err := json.Unmarshal(in.Trip, &head); err != nil || head.ID != id {
		fail(w, http.StatusBadRequest, "a viagem não corresponde ao identificador")
		return
	}

	s.mu.Lock()
	defer s.mu.Unlock()
	p := s.tripPath(id)
	cur, err := readRecord(p)
	switch {
	case errors.Is(err, fs.ErrNotExist):
		if in.BaseRev != 0 { // foi apagada noutro dispositivo
			writeJSON(w, http.StatusConflict, map[string]any{"deleted": true})
			return
		}
		cur = &record{}
	case err != nil:
		fail(w, 500, "não consigo ler a viagem")
		return
	default:
		if cur.Rev != in.BaseRev { // alguém gravou entretanto
			writeJSON(w, http.StatusConflict, cur)
			return
		}
		s.backup(id, p)
	}

	var compact bytes.Buffer
	if err := json.Compact(&compact, in.Trip); err != nil {
		fail(w, http.StatusBadRequest, "JSON inválido")
		return
	}
	next := record{Rev: cur.Rev + 1, UpdatedAt: time.Now().UTC().Format(time.RFC3339), Trip: compact.Bytes()}
	out, _ := json.Marshal(next)
	if err := writeAtomic(p, out); err != nil {
		log.Printf("erro a gravar %s: %v", id, err)
		fail(w, 500, "não consegui gravar")
		return
	}
	writeJSON(w, 200, map[string]any{"rev": next.Rev, "updatedAt": next.UpdatedAt})
}

// deleteTrip não apaga nada: move o ficheiro para a pasta de cópias.
func (s *server) deleteTrip(w http.ResponseWriter, id string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	p := s.tripPath(id)
	if _, err := os.Stat(p); errors.Is(err, fs.ErrNotExist) {
		writeJSON(w, 200, map[string]bool{"ok": true})
		return
	}
	dir := filepath.Join(s.cfg.dataDir, "backups", id)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		fail(w, 500, "não consegui apagar")
		return
	}
	dst := filepath.Join(dir, "apagada-"+time.Now().UTC().Format("2006-01-02T150405Z")+".json")
	if err := os.Rename(p, dst); err != nil {
		fail(w, 500, "não consegui apagar")
		return
	}
	writeJSON(w, 200, map[string]bool{"ok": true})
}

// backup guarda uma cópia por dia de cada viagem (a versão que existia antes da
// primeira alteração desse dia) e mantém as últimas backupsKept.
func (s *server) backup(id, src string) {
	dir := filepath.Join(s.cfg.dataDir, "backups", id)
	dst := filepath.Join(dir, time.Now().UTC().Format("2006-01-02")+".json")
	if _, err := os.Stat(dst); err == nil {
		return
	}
	b, err := os.ReadFile(src)
	if err != nil {
		return
	}
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return
	}
	if err := os.WriteFile(dst, b, 0o600); err != nil {
		log.Printf("aviso: cópia de %s falhou: %v", id, err)
		return
	}
	entries, _ := os.ReadDir(dir)
	var daily []string
	for _, e := range entries {
		if !strings.HasPrefix(e.Name(), "apagada-") {
			daily = append(daily, e.Name())
		}
	}
	sort.Strings(daily)
	for len(daily) > backupsKept {
		os.Remove(filepath.Join(dir, daily[0]))
		daily = daily[1:]
	}
}
