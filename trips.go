package main

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"net/http"
	"os"
	"path/filepath"
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

// cachedRec é um registo já lido e validado. Assim GET /api/trips não volta a ler e a interpretar
// todos os ficheiros em cada pedido, e PUT não lê o ficheiro inteiro só para saber a revisão.
type cachedRec struct {
	rev  int64
	raw  []byte    // o ficheiro tal como está em disco; nil quando já não coube em s.maxCache
	mod  time.Time // data e tamanho do ficheiro quando foi lido: se mudarem, alguém mexeu nele à mão
	size int64
}

func (s *server) tripPath(id string) string {
	return filepath.Join(s.cfg.dataDir, "trips", id+".json")
}

// validRecord confirma que raw é um registo que a página consegue abrir (JSON com a viagem num objeto)
// e devolve a revisão.
func validRecord(raw []byte) (int64, error) {
	var rec record
	if err := json.Unmarshal(raw, &rec); err != nil {
		return 0, err
	}
	if len(rec.Trip) == 0 || rec.Trip[0] != '{' {
		return 0, errors.New("a viagem não é um objeto")
	}
	return rec.Rev, nil
}

// loadRecord devolve o registo da viagem id e só volta a ler o disco se o ficheiro mudou.
// Chamar com s.mu trancado.
func (s *server) loadRecord(id string) (*cachedRec, error) {
	p := s.tripPath(id)
	fi, err := os.Stat(p)
	if err != nil {
		s.forget(id)
		return nil, err
	}
	if c := s.cache[id]; c != nil && c.size == fi.Size() && c.mod.Equal(fi.ModTime()) {
		return c, nil
	}
	raw, err := os.ReadFile(p)
	if err != nil {
		s.forget(id)
		return nil, err
	}
	rev, err := validRecord(raw)
	if err != nil {
		s.forget(id)
		return nil, err
	}
	c := &cachedRec{rev: rev, raw: raw, mod: fi.ModTime(), size: fi.Size()}
	s.remember(id, c)
	return c, nil
}

// remember guarda c na cache. Acima de s.maxCache fica só a revisão e os bytes voltam a ser lidos do disco.
func (s *server) remember(id string, c *cachedRec) {
	s.forget(id)
	if s.cacheBytes+int64(len(c.raw)) > s.maxCache {
		c.raw = nil
	}
	if s.cache == nil {
		s.cache = map[string]*cachedRec{}
	}
	s.cache[id] = c
	s.cacheBytes += int64(len(c.raw))
}

func (s *server) forget(id string) {
	if c := s.cache[id]; c != nil {
		s.cacheBytes -= int64(len(c.raw))
		delete(s.cache, id)
	}
}

// recordBytes devolve o registo tal como está em disco: da cache ou, se não coube lá, do ficheiro.
func (s *server) recordBytes(id string, c *cachedRec) ([]byte, error) {
	if c.raw != nil {
		return c.raw, nil
	}
	raw, err := os.ReadFile(s.tripPath(id))
	if err == nil {
		_, err = validRecord(raw)
	}
	return raw, err
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

// listTrips responde com {user, homeTz, trips}, montado com os registos tal como estão em disco.
// A página volta a pedir a lista sempre que o separador fica visível: com If-None-Match igual ao
// ETag (nada mudou), a resposta é um 304 sem corpo.
func (s *server) listTrips(w http.ResponseWriter, r *http.Request) {
	raws, etag, err := s.readTripRecords()
	if err != nil {
		fail(w, 500, "não consigo ler os dados")
		return
	}
	h := w.Header()
	h.Set("ETag", etag)
	h.Set("Cache-Control", "no-store")
	if etagMatch(r.Header.Get("If-None-Match"), etag) {
		w.WriteHeader(http.StatusNotModified)
		return
	}
	user, _ := json.Marshal(s.cfg.user)
	tz, _ := json.Marshal(s.cfg.homeTz)
	h.Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(http.StatusOK)
	// os bytes da cache nunca mudam (cada gravação guarda outros), por isso escrevem-se já sem s.mu
	io.WriteString(w, `{"user":`)
	w.Write(user)
	io.WriteString(w, `,"homeTz":`)
	w.Write(tz)
	io.WriteString(w, `,"trips":[`)
	for i, b := range raws {
		if i > 0 {
			io.WriteString(w, ",")
		}
		w.Write(b)
	}
	io.WriteString(w, "]}\n")
}

// readTripRecords devolve os registos das viagens legíveis e o ETag da lista, que muda quando muda alguma
// viagem (revisão, tamanho ou data do ficheiro), o utilizador ou o fuso.
func (s *server) readTripRecords() ([][]byte, string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	entries, err := os.ReadDir(filepath.Join(s.cfg.dataDir, "trips"))
	if err != nil {
		return nil, "", err
	}
	raws := [][]byte{}
	seen := map[string]bool{}
	h := sha256.New()
	fmt.Fprintf(h, "%q %q\n", s.cfg.user, s.cfg.homeTz)
	for _, e := range entries {
		id, ok := strings.CutSuffix(e.Name(), ".json")
		if e.IsDir() || !ok {
			continue
		}
		c, err := s.loadRecord(id)
		var b []byte
		if err == nil {
			b, err = s.recordBytes(id, c)
		}
		if err != nil {
			s.log.Printf("aviso: %s ilegível: %v", e.Name(), err)
			continue
		}
		seen[id] = true
		raws = append(raws, b)
		fmt.Fprintf(h, "%s %d %d %d\n", id, c.rev, c.size, c.mod.UnixNano())
	}
	for id := range s.cache { // ficheiros que desapareceram (por exemplo, tirados à mão)
		if !seen[id] {
			s.forget(id)
		}
	}
	return raws, `"` + hex.EncodeToString(h.Sum(nil)[:8]) + `"`, nil
}

func (s *server) putTrip(w http.ResponseWriter, r *http.Request, id string) {
	var in struct {
		BaseRev int64           `json:"baseRev"`
		Trip    json.RawMessage `json:"trip"`
	}
	// Só um corpo acima de maxBody é "demasiado grande"; qualquer outra falha (ligação cortada a meio,
	// JSON partido, lixo depois do objeto) é um pedido inválido. io.ReadAll + Unmarshal em vez de um
	// json.Decoder: o buffer do Decoder cresce para o dobro de cada vez e uma viagem de 1,2 MB
	// alocava mais 1,3 MB (BenchmarkPutTrip); Unmarshal também já recusa o que vem depois do objeto.
	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, maxBody))
	if errors.As(err, new(*http.MaxBytesError)) {
		fail(w, http.StatusRequestEntityTooLarge, "viagem demasiado grande")
		return
	}
	if err != nil || json.Unmarshal(body, &in) != nil {
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
	var rev int64
	cur, err := s.loadRecord(id) // com a cache, quase sempre só um Stat
	switch {
	case errors.Is(err, fs.ErrNotExist):
		if in.BaseRev != 0 { // foi apagada noutro dispositivo
			writeJSON(w, http.StatusConflict, map[string]any{"deleted": true})
			return
		}
	case err != nil:
		fail(w, 500, "não consigo ler a viagem")
		return
	default:
		if cur.rev != in.BaseRev { // alguém gravou entretanto
			b, err := s.recordBytes(id, cur)
			if err != nil {
				fail(w, 500, "não consigo ler a viagem")
				return
			}
			writeRawJSON(w, http.StatusConflict, b)
			return
		}
		rev = cur.rev
		s.backup(id, p)
	}

	// O registo monta-se à mão: a viagem já foi interpretada acima e aqui só é compactada.
	var out bytes.Buffer
	out.Grow(len(in.Trip) + 64)
	now := s.now().UTC().Format(time.RFC3339)
	fmt.Fprintf(&out, `{"rev":%d,"updatedAt":%q,"trip":`, rev+1, now)
	json.Compact(&out, in.Trip) // não falha: o json.Unmarshal acima já validou in.Trip
	out.WriteByte('}')
	if err := s.writeFile(p, out.Bytes()); err != nil {
		s.log.Printf("erro a gravar %s: %v", id, err)
		fail(w, 500, "não consegui gravar")
		return
	}
	if fi, err := os.Stat(p); err == nil {
		s.remember(id, &cachedRec{rev: rev + 1, raw: out.Bytes(), mod: fi.ModTime(), size: fi.Size()})
	} else {
		s.forget(id)
	}
	writeJSON(w, 200, map[string]any{"rev": rev + 1, "updatedAt": now})
}

// deleteTrip não apaga nada: move o ficheiro para a pasta de cópias.
func (s *server) deleteTrip(w http.ResponseWriter, _ *http.Request, id string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	p := s.tripPath(id)
	if _, err := os.Stat(p); errors.Is(err, fs.ErrNotExist) {
		s.forget(id)
		writeJSON(w, 200, map[string]bool{"ok": true})
		return
	}
	dir := filepath.Join(s.cfg.dataDir, "backups", id)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		fail(w, 500, "não consegui apagar")
		return
	}
	dst := filepath.Join(dir, "apagada-"+s.now().UTC().Format("2006-01-02T150405Z")+".json")
	if err := os.Rename(p, dst); err != nil {
		fail(w, 500, "não consegui apagar")
		return
	}
	s.forget(id)
	writeJSON(w, 200, map[string]bool{"ok": true})
}

// backup guarda uma cópia por dia de cada viagem (a versão que existia antes da
// primeira alteração desse dia) e mantém as últimas backupsKept.
func (s *server) backup(id, src string) {
	dir := filepath.Join(s.cfg.dataDir, "backups", id)
	dst := filepath.Join(dir, s.now().UTC().Format("2006-01-02")+".json")
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
	if err := s.writeFile(dst, b); err != nil {
		s.log.Printf("aviso: cópia de %s falhou: %v", id, err)
		return
	}
	entries, _ := os.ReadDir(dir) // já vêm por ordem do nome, ou seja, da data
	var daily []string
	for _, e := range entries {
		if !strings.HasPrefix(e.Name(), "apagada-") {
			daily = append(daily, e.Name())
		}
	}
	for _, name := range daily[:max(len(daily)-backupsKept, 0)] {
		os.Remove(filepath.Join(dir, name))
	}
}
