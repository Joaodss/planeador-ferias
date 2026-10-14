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
	"strconv"
	"strings"
	"time"
)

const (
	// maxTripBytes: o maior corpo de um PUT de viagem (2 MB). Acima dele a resposta é 413 e a página deixa
	// de tentar gravar essa viagem (applyPutResponse em sync.js). O login tem o seu limite, maxLoginBytes.
	maxTripBytes = 2 << 20
	backupsKept  = 30 // cópias diárias guardadas de cada viagem (ver backup)
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

// tripPath é o caminho do ficheiro da viagem id. Não limpa o id: só é seguro porque tripHandler (routes.go)
// já confirmou que id cumpre tripIDRe (sem "/", "\" nem ".."), e readTripRecords só passa nomes que leu da pasta.
func (s *server) tripPath(id string) string {
	return filepath.Join(s.cfg.dataDir, "trips", id+".json")
}

// parseRecordRev devolve a revisão do registo raw e confirma que a página o consegue abrir
// (JSON com a viagem num objeto).
func parseRecordRev(raw []byte) (int64, error) {
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
// Chamar com s.tripsMu trancado.
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
	rev, err := parseRecordRev(raw)
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

// forget tira a viagem id da cache e desconta os seus bytes de cacheBytes. Chamar com s.tripsMu trancado.
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
		_, err = parseRecordRev(raw)
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
		writeError(w, 500, "não consigo ler os dados")
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
	// os bytes da cache nunca mudam (cada gravação guarda outros), por isso escrevem-se já sem s.tripsMu
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
	s.tripsMu.Lock()
	defer s.tripsMu.Unlock()
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

// putTrip grava a viagem id: recebe {baseRev, trip} e responde {rev, updatedAt}. baseRev é a revisão em que a página se baseou:
// se não for a que está em disco, responde 409 com o registo atual (ou {deleted:true} se a viagem foi apagada).
// trip tem de ser um objeto com o mesmo id do caminho; o resto do esquema é com a página (clean.js).
func (s *server) putTrip(w http.ResponseWriter, r *http.Request, id string) {
	var in struct {
		BaseRev int64           `json:"baseRev"`
		Trip    json.RawMessage `json:"trip"`
	}
	// Só um corpo acima de maxTripBytes é "demasiado grande"; qualquer outra falha (ligação cortada a meio,
	// JSON partido, lixo depois do objeto) é um pedido inválido. io.ReadAll + Unmarshal em vez de um
	// json.Decoder: o buffer do Decoder cresce para o dobro de cada vez e uma viagem de 1,2 MB
	// alocava mais 1,3 MB (BenchmarkPutTrip); Unmarshal também já recusa o que vem depois do objeto.
	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, maxTripBytes))
	if errors.As(err, new(*http.MaxBytesError)) {
		writeError(w, http.StatusRequestEntityTooLarge, "viagem demasiado grande")
		return
	}
	if err != nil || json.Unmarshal(body, &in) != nil {
		writeError(w, http.StatusBadRequest, "JSON inválido")
		return
	}
	var head struct {
		ID string `json:"id"`
	}
	if err := json.Unmarshal(in.Trip, &head); err != nil || head.ID != id {
		writeError(w, http.StatusBadRequest, "a viagem não corresponde ao identificador")
		return
	}

	s.tripsMu.Lock()
	defer s.tripsMu.Unlock()
	var rev int64
	cur, err := s.loadRecord(id) // com a cache, quase sempre só um Stat
	switch {
	case errors.Is(err, fs.ErrNotExist):
		if in.BaseRev != 0 { // foi apagada noutro dispositivo
			writeJSON(w, http.StatusConflict, map[string]any{"deleted": true})
			return
		}
	case err != nil:
		writeError(w, 500, "não consigo ler a viagem")
		return
	default:
		if cur.rev != in.BaseRev { // alguém gravou entretanto
			b, err := s.recordBytes(id, cur)
			if err != nil {
				writeError(w, 500, "não consigo ler a viagem")
				return
			}
			writeRawJSON(w, http.StatusConflict, b)
			return
		}
		rev = cur.rev
		s.backup(id, s.tripPath(id))
	}

	newRev, now, err := s.storeTrip(id, rev, in.Trip)
	if err != nil {
		writeError(w, 500, "não consegui gravar")
		return
	}
	writeJSON(w, 200, map[string]any{"rev": newRev, "updatedAt": now})
}

// storeTrip grava trip (JSON já validado) como a revisão rev+1 da viagem id e atualiza a cache.
// Devolve a revisão nova e o updatedAt. Chamar com s.tripsMu trancado e depois da cópia do dia (backup).
func (s *server) storeTrip(id string, rev int64, trip []byte) (int64, string, error) {
	p := s.tripPath(id)
	// O registo monta-se à mão: a viagem já foi interpretada por quem chama e aqui só é compactada.
	var out bytes.Buffer
	out.Grow(len(trip) + 64)
	now := s.now().UTC().Format(time.RFC3339)
	fmt.Fprintf(&out, `{"rev":%d,"updatedAt":%q,"trip":`, rev+1, now)
	if err := json.Compact(&out, trip); err != nil {
		return 0, "", err
	}
	out.WriteByte('}')
	if err := s.writeFile(p, out.Bytes()); err != nil {
		s.log.Printf("erro a gravar %s: %v", id, err)
		return 0, "", err
	}
	if fi, err := os.Stat(p); err == nil {
		s.remember(id, &cachedRec{rev: rev + 1, raw: out.Bytes(), mod: fi.ModTime(), size: fi.Size()})
	} else {
		s.forget(id)
	}
	return rev + 1, now, nil
}

// deleteTrip não apaga nada: move o ficheiro para a pasta de cópias.
func (s *server) deleteTrip(w http.ResponseWriter, _ *http.Request, id string) {
	s.tripsMu.Lock()
	defer s.tripsMu.Unlock()
	p := s.tripPath(id)
	if _, err := os.Stat(p); errors.Is(err, fs.ErrNotExist) {
		s.forget(id)
		writeJSON(w, 200, map[string]bool{"ok": true})
		return
	}
	dir := filepath.Join(s.cfg.dataDir, "backups", id)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		writeError(w, 500, "não consegui apagar")
		return
	}
	dst := filepath.Join(dir, "apagada-"+s.now().UTC().Format("2006-01-02T150405Z")+".json")
	if err := os.Rename(p, dst); err != nil {
		writeError(w, 500, "não consegui apagar")
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
		// as viagens apagadas e as cópias de antes de cada alteração da IA (aiSnapshotPrefix) não são diárias
		if !strings.HasPrefix(e.Name(), "apagada-") && !strings.HasPrefix(e.Name(), aiSnapshotPrefix) {
			daily = append(daily, e.Name())
		}
	}
	for _, name := range daily[:max(len(daily)-backupsKept, 0)] {
		os.Remove(filepath.Join(dir, name))
	}
}

/* ---------- alterações da IA (mcptools.go) ---------- */

const (
	// aiSnapshotPrefix: cópia da viagem antes de cada alteração da IA, em backups/<id>/ia-<data>-r<rev>.json,
	// onde rev é a revisão que a IA gravou. undoAI só repõe a cópia enquanto a viagem estiver nessa revisão.
	aiSnapshotPrefix = "ia-"
	aiSnapshotsKept  = 20 // cópias de antes da IA guardadas por viagem: chega para desfazer uma conversa inteira
)

// loadTrip lê a viagem id do disco (pela cache) como um mapa. Chamar com s.tripsMu trancado.
func (s *server) loadTrip(id string) (*cachedRec, []byte, jsonObj, error) {
	cur, err := s.loadRecord(id)
	if errors.Is(err, fs.ErrNotExist) {
		return nil, nil, nil, &toolError{fmt.Sprintf("a viagem %s não existe", id)}
	}
	if err != nil {
		return nil, nil, nil, err
	}
	raw, err := s.recordBytes(id, cur)
	if err != nil {
		return nil, nil, nil, err
	}
	var rec struct {
		Trip jsonObj `json:"trip"`
	}
	if err := json.Unmarshal(raw, &rec); err != nil {
		return nil, nil, nil, err
	}
	return cur, raw, rec.Trip, nil
}

// readTrip devolve a viagem id e a sua revisão, sem a mudar.
func (s *server) readTrip(id string) (jsonObj, int64, error) {
	if !tripIDRe.MatchString(id) {
		return nil, 0, &toolError{fmt.Sprintf("identificador de viagem inválido: %q", id)}
	}
	s.tripsMu.Lock()
	defer s.tripsMu.Unlock()
	cur, _, t, err := s.loadTrip(id)
	if err != nil {
		return nil, 0, err
	}
	return t, cur.rev, nil
}

// editTrip aplica fn à viagem id e grava, tudo com s.tripsMu trancado: duas ferramentas ao mesmo tempo
// não perdem as alterações uma da outra. Antes de gravar guarda a versão anterior (aiSnapshot), para o
// undo_last_ai_change. Recusa as viagens só de leitura e arquivadas.
func (s *server) editTrip(id string, fn func(t jsonObj) (any, error)) (any, int64, error) {
	if !tripIDRe.MatchString(id) {
		return nil, 0, &toolError{fmt.Sprintf("identificador de viagem inválido: %q", id)}
	}
	s.tripsMu.Lock()
	defer s.tripsMu.Unlock()
	cur, raw, t, err := s.loadTrip(id)
	if err != nil {
		return nil, 0, err
	}
	if err := checkWritable(t); err != nil {
		return nil, 0, err
	}
	out, err := fn(t)
	if err != nil {
		return nil, 0, err
	}
	b, err := json.Marshal(t)
	if err != nil {
		return nil, 0, err
	}
	if len(b) > maxTripBytes {
		return nil, 0, &toolError{"a viagem ficava demasiado grande (mais de 2 MB)"}
	}
	s.backup(id, s.tripPath(id))
	if err := s.aiSnapshot(id, raw, cur.rev+1); err != nil {
		return nil, 0, err
	}
	rev, _, err := s.storeTrip(id, cur.rev, b)
	return out, rev, err
}

// createTrip grava a viagem nova t (com o id que newTripFrom lhe deu).
func (s *server) createTrip(t jsonObj) (int64, error) {
	id := str(t, "id")
	b, err := json.Marshal(t)
	if err != nil {
		return 0, err
	}
	s.tripsMu.Lock()
	defer s.tripsMu.Unlock()
	if _, err := os.Stat(s.tripPath(id)); err == nil {
		return 0, &toolError{"já existe uma viagem com este id"}
	}
	rev, _, err := s.storeTrip(id, 0, b)
	return rev, err
}

func (s *server) aiDir(id string) string { return filepath.Join(s.cfg.dataDir, "backups", id) }

// aiSnapshot guarda raw (o registo antes da alteração) como a cópia que desfaz a revisão rev, e mantém as
// últimas aiSnapshotsKept. Chamar com s.tripsMu trancado.
func (s *server) aiSnapshot(id string, raw []byte, rev int64) error {
	dir := s.aiDir(id)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	name := fmt.Sprintf("%s%s-r%d.json", aiSnapshotPrefix, s.now().UTC().Format("20060102T150405.000Z"), rev)
	if err := s.writeFile(filepath.Join(dir, name), raw); err != nil {
		return err
	}
	snaps := s.aiSnapshots(id)
	for _, n := range snaps[:max(len(snaps)-aiSnapshotsKept, 0)] {
		os.Remove(filepath.Join(dir, n))
	}
	return nil
}

// aiSnapshots: os nomes das cópias de antes da IA da viagem id, da mais antiga para a mais recente
// (o nome começa pela data).
func (s *server) aiSnapshots(id string) []string {
	entries, _ := os.ReadDir(s.aiDir(id))
	var out []string
	for _, e := range entries {
		if strings.HasPrefix(e.Name(), aiSnapshotPrefix) && strings.HasSuffix(e.Name(), ".json") {
			out = append(out, e.Name())
		}
	}
	return out
}

// undoAI repõe a viagem id como estava antes da última alteração da IA, se ninguém a mudou depois
// (a revisão atual é a que a IA gravou). A cópia usada sai da pasta: o próximo undoAI vai à anterior,
// enquanto as alterações forem seguidas (só da IA, sem gravações da página pelo meio).
// Devolve a revisão nova.
func (s *server) undoAI(id string) (int64, error) {
	s.tripsMu.Lock()
	defer s.tripsMu.Unlock()
	cur, _, t, err := s.loadTrip(id)
	if err != nil {
		return 0, err
	}
	if err := checkWritable(t); err != nil {
		return 0, err
	}
	snaps := s.aiSnapshots(id)
	if len(snaps) == 0 {
		return 0, &toolError{"não há nenhuma alteração da IA para desfazer nesta viagem"}
	}
	last := snaps[len(snaps)-1]
	_, revPart, _ := strings.Cut(strings.TrimSuffix(last, ".json"), "-r")
	if rev, err := strconv.ParseInt(revPart, 10, 64); err != nil || rev != cur.rev {
		return 0, &toolError{"a viagem mudou depois da última alteração da IA: usa o Desfazer da página ou uma cópia de segurança"}
	}
	p := filepath.Join(s.aiDir(id), last)
	raw, err := os.ReadFile(p)
	if err != nil {
		return 0, err
	}
	var rec record
	if err := json.Unmarshal(raw, &rec); err != nil {
		return 0, err
	}
	s.backup(id, s.tripPath(id))
	rev, _, err := s.storeTrip(id, cur.rev, rec.Trip)
	if err != nil {
		return 0, err
	}
	os.Remove(p)
	// A viagem voltou ao que a alteração anterior da IA gravou (a revisão rec.Rev), agora com a revisão rev.
	// A cópia dessa alteração passa a desfazer rev, para o undo seguinte também funcionar.
	if len(snaps) > 1 {
		prev := snaps[len(snaps)-2]
		if before, ok := strings.CutSuffix(prev, fmt.Sprintf("-r%d.json", rec.Rev)); ok {
			os.Rename(filepath.Join(s.aiDir(id), prev), filepath.Join(s.aiDir(id), fmt.Sprintf("%s-r%d.json", before, rev)))
		}
	}
	return rev, nil
}

// undoAITrip é POST /api/trips/{id}/undo-ai, o botão "Desfazer a IA" da página: {rev}, ou 409 com a razão
// (nada para desfazer, a viagem mudou depois, está só de leitura ou já não existe).
func (s *server) undoAITrip(w http.ResponseWriter, _ *http.Request, id string) {
	rev, err := s.undoAI(id)
	var te *toolError
	switch {
	case errors.As(err, &te):
		writeError(w, http.StatusConflict, err.Error())
	case err != nil:
		s.log.Printf("erro a desfazer a IA em %s: %v", id, err)
		writeError(w, 500, "não consegui desfazer")
	default:
		writeJSON(w, 200, map[string]any{"rev": rev})
	}
}
