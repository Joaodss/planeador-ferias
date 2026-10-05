package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"testing"
	"testing/iotest"
	"time"
)

func TestTripLifecycle(t *testing.T) {
	t.Parallel()
	s := newTestServer(t)
	dir := s.cfg.dataDir
	// relógio parado: os nomes das cópias não dependem do dia em que o teste corre
	withClock(s, time.Date(2027, 7, 5, 23, 59, 30, 0, time.UTC))

	w := authedCall(s, "PUT", "/api/trips/x", tripBody("x", 0, "A"))
	if w.Code != http.StatusOK || decode[record](t, w).Rev != 1 {
		t.Fatalf("criar: código %d, %s", w.Code, w.Body)
	}

	// Outro dispositivo grava com base antiga: conflito com a versão atual.
	w = authedCall(s, "PUT", "/api/trips/x", tripBody("x", 0, "conflito"))
	if w.Code != http.StatusConflict {
		t.Fatalf("conflito: código %d, esperava 409", w.Code)
	}
	cur := decode[record](t, w)
	var tn tripName
	json.Unmarshal(cur.Trip, &tn)
	if cur.Rev != 1 || tn.Name != "A" {
		t.Errorf("o conflito devia devolver a rev 1 com nome A, veio rev %d nome %q", cur.Rev, tn.Name)
	}

	w = authedCall(s, "PUT", "/api/trips/x", tripBody("x", 1, "B"))
	if rec := decode[record](t, w); w.Code != http.StatusOK || rec.Rev != 2 || rec.UpdatedAt != "2027-07-05T23:59:30Z" {
		t.Fatalf("atualizar: código %d, %s", w.Code, w.Body)
	}
	backup := filepath.Join(dir, "backups", "x", "2027-07-05.json")
	if b, err := os.ReadFile(backup); err != nil || !strings.Contains(string(b), `"name":"A"`) {
		t.Errorf("devia existir uma cópia do dia com a versão A: %v %s", err, b)
	}

	w = authedCall(s, "GET", "/api/trips", "")
	list := decode[struct {
		User  string    `json:"user"`
		Trips []*record `json:"trips"`
	}](t, w)
	if list.User != testUser || len(list.Trips) != 1 || list.Trips[0].Rev != 2 {
		t.Fatalf("lista inesperada: %s", w.Body)
	}

	// Apagar move o ficheiro para as cópias, não o elimina.
	if w := authedCall(s, "DELETE", "/api/trips/x", ""); w.Code != http.StatusOK {
		t.Fatalf("apagar: código %d", w.Code)
	}
	if _, err := os.Stat(s.tripPath("x")); !os.IsNotExist(err) {
		t.Error("a viagem apagada ainda está em trips/")
	}
	if b, err := os.ReadFile(filepath.Join(dir, "backups", "x", "apagada-2027-07-05T235930Z.json")); err != nil || !strings.Contains(string(b), `"name":"B"`) {
		t.Errorf("a viagem apagada devia ficar em backups/x/apagada-<hora UTC>.json: %v %s", err, b)
	}

	// Gravar uma viagem que foi apagada noutro dispositivo.
	w = authedCall(s, "PUT", "/api/trips/x", tripBody("x", 2, "C"))
	if w.Code != http.StatusConflict || !decode[struct{ Deleted bool }](t, w).Deleted {
		t.Errorf("gravar viagem apagada: código %d, %s", w.Code, w.Body)
	}

	// Apagar duas vezes não é erro.
	if w := authedCall(s, "DELETE", "/api/trips/x", ""); w.Code != http.StatusOK {
		t.Errorf("apagar de novo: código %d", w.Code)
	}
}

func TestTripListSkipsUnreadableFiles(t *testing.T) {
	t.Parallel()
	s := newTestServer(t)
	authedCall(s, "PUT", "/api/trips/ok", tripBody("ok", 0, "Boa"))
	os.WriteFile(filepath.Join(s.cfg.dataDir, "trips", "estragada.json"), []byte("{"), 0o600)
	os.WriteFile(filepath.Join(s.cfg.dataDir, "trips", "notas.txt"), []byte("x"), 0o600)
	w := authedCall(s, "GET", "/api/trips", "")
	if n := len(decode[struct{ Trips []*record }](t, w).Trips); w.Code != http.StatusOK || n != 1 {
		t.Fatalf("esperava 1 viagem legível, veio %d (código %d)", n, w.Code)
	}
}

func TestTripValidation(t *testing.T) {
	t.Parallel()
	s := newTestServer(t)
	huge := `{"baseRev":0,"trip":{"id":"x","note":"` + strings.Repeat("a", maxBody) + `"}}`
	for _, tc := range []struct {
		name, method, path, body string
		want                     int
	}{
		{"id diferente do caminho", "PUT", "/api/trips/x", tripBody("y", 0, "A"), http.StatusBadRequest},
		{"id com caracteres proibidos", "PUT", "/api/trips/a.b", tripBody("a.b", 0, "A"), http.StatusBadRequest},
		{"id demasiado longo", "PUT", "/api/trips/" + strings.Repeat("a", 65), "{}", http.StatusBadRequest},
		{"id com barra codificada", "PUT", "/api/trips/a%2Fb", tripBody("a/b", 0, "A"), http.StatusBadRequest},
		{"JSON inválido", "PUT", "/api/trips/x", "{", http.StatusBadRequest},
		{"lixo depois do JSON", "PUT", "/api/trips/x", tripBody("x", 0, "A") + "x", http.StatusBadRequest},
		{"viagem sem objeto", "PUT", "/api/trips/x", `{"baseRev":0}`, http.StatusBadRequest},
		{"demasiado grande", "PUT", "/api/trips/x", huge, http.StatusRequestEntityTooLarge},
		{"método errado", "POST", "/api/trips/x", "{}", http.StatusMethodNotAllowed},
		{"caminho desconhecido", "GET", "/api/nada", "", http.StatusNotFound},
	} {
		if w := authedCall(s, tc.method, tc.path, tc.body); w.Code != tc.want {
			t.Errorf("%s: código %d, esperava %d (%s)", tc.name, w.Code, tc.want, w.Body)
		}
	}
	if entries, _ := os.ReadDir(filepath.Join(s.cfg.dataDir, "trips")); len(entries) != 0 {
		t.Errorf("pedidos inválidos não podem gravar nada, encontrei %d ficheiros", len(entries))
	}
}

// Uma ligação cortada a meio do corpo é um pedido inválido, não uma viagem demasiado grande.
func TestPutTripReadError(t *testing.T) {
	t.Parallel()
	s := newTestServer(t)
	body := io.MultiReader(strings.NewReader(`{"baseRev":0,"trip":{"id":"x"`), iotest.ErrReader(io.ErrUnexpectedEOF))
	r := httptest.NewRequest("PUT", "/api/trips/x", body)
	r.Header.Set("X-Requested-With", "planner")
	r.AddCookie(&http.Cookie{Name: cookieName, Value: s.newToken()})
	w := httptest.NewRecorder()
	s.ServeHTTP(w, r)
	if w.Code != http.StatusBadRequest {
		t.Fatalf("código %d, esperava 400 (%s)", w.Code, w.Body)
	}
}

func TestBackupRetention(t *testing.T) {
	t.Parallel()
	s := newTestServer(t)
	dir := filepath.Join(s.cfg.dataDir, "backups", "x")
	os.MkdirAll(dir, 0o700)
	start := time.Date(2020, 1, 1, 0, 0, 0, 0, time.UTC)
	for i := 0; i < backupsKept+5; i++ {
		os.WriteFile(filepath.Join(dir, start.AddDate(0, 0, i).Format("2006-01-02")+".json"), []byte("{}"), 0o600)
	}
	os.WriteFile(filepath.Join(dir, "apagada-2019-01-01T000000Z.json"), []byte("{}"), 0o600)
	src := filepath.Join(s.cfg.dataDir, "trips", "x.json")
	os.WriteFile(src, []byte(`{"rev":1}`), 0o600)

	s.backup("x", src)

	entries, _ := os.ReadDir(dir)
	daily, deleted := 0, 0
	for _, e := range entries {
		if strings.HasPrefix(e.Name(), "apagada-") {
			deleted++
		} else {
			daily++
		}
	}
	if daily != backupsKept {
		t.Errorf("ficaram %d cópias diárias, esperava %d", daily, backupsKept)
	}
	if deleted != 1 {
		t.Error("as viagens apagadas nunca podem ser removidas pela limpeza")
	}
	if _, err := os.Stat(filepath.Join(dir, start.Format("2006-01-02")+".json")); !os.IsNotExist(err) {
		t.Error("a cópia mais antiga devia ter sido removida")
	}
}

func TestTripListETag(t *testing.T) {
	t.Parallel()
	s := newTestServer(t)
	tok := s.newToken()
	list := func(inm string) *httptest.ResponseRecorder {
		return call(s, "GET", "/api/trips", "", withCookie(tok), withHeader("If-None-Match", inm))
	}
	authedCall(s, "PUT", "/api/trips/x", tripBody("x", 0, "A"))

	w := list("")
	etag := w.Header().Get("ETag")
	if w.Code != http.StatusOK || etag == "" {
		t.Fatalf("primeira lista: código %d, ETag %q", w.Code, etag)
	}
	if got := decode[struct{ Trips []*record }](t, w).Trips; len(got) != 1 || got[0].Rev != 1 {
		t.Fatalf("lista inesperada: %s", w.Body)
	}
	// Ao voltar ao separador sem nada mudado: 304, sem corpo. Também com o ETag como um proxy o deixa.
	for _, inm := range []string{etag, "W/" + etag, `"` + strings.Trim(etag, `"`) + `-gzip"`, `"outro", ` + etag} {
		if w := list(inm); w.Code != http.StatusNotModified || w.Body.Len() != 0 || w.Header().Get("ETag") != etag {
			t.Errorf("If-None-Match %s: código %d, %d bytes, ETag %q", inm, w.Code, w.Body.Len(), w.Header().Get("ETag"))
		}
	}

	// Cada gravação e cada apagar mudam o ETag.
	authedCall(s, "PUT", "/api/trips/x", tripBody("x", 1, "B"))
	w = list(etag)
	if w.Code != http.StatusOK || w.Header().Get("ETag") == etag {
		t.Fatalf("depois de gravar: código %d, ETag %q igual ao anterior", w.Code, w.Header().Get("ETag"))
	}
	if !strings.Contains(w.Body.String(), `"name":"B"`) {
		t.Errorf("a lista devia ter a versão B: %s", w.Body)
	}
	etag = w.Header().Get("ETag")
	authedCall(s, "DELETE", "/api/trips/x", "")
	w = list(etag)
	if w.Code != http.StatusOK || len(decode[struct{ Trips []*record }](t, w).Trips) != 0 {
		t.Fatalf("depois de apagar: código %d, %s", w.Code, w.Body)
	}

	// Mudar PLANNER_HOME_TZ (num reinício) também muda o ETag: a página tem de receber o fuso novo.
	etag = w.Header().Get("ETag")
	s.cfg.homeTz = "Asia/Tokyo"
	w = list(etag)
	if w.Code != http.StatusOK || w.Header().Get("ETag") == etag || !strings.Contains(w.Body.String(), `"homeTz":"Asia/Tokyo"`) {
		t.Fatalf("depois de mudar o fuso: código %d, ETag %q, %s", w.Code, w.Header().Get("ETag"), w.Body)
	}
}

func TestTripListSeesHandEdits(t *testing.T) {
	t.Parallel()
	s := newTestServer(t)
	authedCall(s, "PUT", "/api/trips/x", tripBody("x", 0, "A"))
	w := authedCall(s, "GET", "/api/trips", "") // a viagem fica na cache
	etag := w.Header().Get("ETag")

	// Alguém repõe uma cópia à mão: a lista mostra o ficheiro novo e o ETag muda.
	p := s.tripPath("x")
	if err := os.WriteFile(p, []byte(`{"rev":7,"updatedAt":"","trip":{"id":"x","name":"À mão"}}`), 0o600); err != nil {
		t.Fatal(err)
	}
	later := time.Now().Add(time.Minute)
	os.Chtimes(p, later, later)
	w = call(s, "GET", "/api/trips", "", withCookie(s.newToken()), withHeader("If-None-Match", etag))
	if w.Code != http.StatusOK || !strings.Contains(w.Body.String(), "À mão") {
		t.Fatalf("a lista devia mostrar a cópia reposta: código %d, %s", w.Code, w.Body)
	}
	// e a próxima gravação parte da revisão desse ficheiro
	if w := authedCall(s, "PUT", "/api/trips/x", tripBody("x", 1, "B")); w.Code != http.StatusConflict || decode[record](t, w).Rev != 7 {
		t.Errorf("gravar sobre a revisão antiga: código %d, %s", w.Code, w.Body)
	}
	if w := authedCall(s, "PUT", "/api/trips/x", tripBody("x", 7, "B")); w.Code != http.StatusOK || decode[record](t, w).Rev != 8 {
		t.Errorf("gravar sobre a revisão 7: código %d, %s", w.Code, w.Body)
	}

	// Tirado à mão: desaparece da lista e da cache.
	os.Remove(p)
	if n := len(decode[struct{ Trips []*record }](t, authedCall(s, "GET", "/api/trips", "")).Trips); n != 0 {
		t.Errorf("a viagem tirada à mão ainda aparece (%d)", n)
	}
	if len(s.cache) != 0 || s.cacheBytes != 0 {
		t.Errorf("a cache devia ficar vazia: %d viagens, %d bytes", len(s.cache), s.cacheBytes)
	}
}

func TestTripListWithFullCache(t *testing.T) {
	t.Parallel()
	s := newTestServer(t)
	s.maxCache = 100 // só cabe a primeira viagem: as outras vêm do disco
	for _, id := range []string{"a", "b", "c"} {
		authedCall(s, "PUT", "/api/trips/"+id, tripBody(id, 0, "Viagem "+id))
	}
	w := authedCall(s, "GET", "/api/trips", "")
	got := decode[struct{ Trips []*record }](t, w).Trips
	if w.Code != http.StatusOK || len(got) != 3 {
		t.Fatalf("esperava 3 viagens, veio %d (código %d)", len(got), w.Code)
	}
	for _, rec := range got {
		var tn tripName
		json.Unmarshal(rec.Trip, &tn)
		if rec.Rev != 1 || tn.Name != "Viagem "+tn.ID {
			t.Errorf("registo errado: rev %d, %+v", rec.Rev, tn)
		}
	}
	if s.cacheBytes > s.maxCache {
		t.Errorf("a cache passou do limite: %d bytes", s.cacheBytes)
	}
	// Conflito com a viagem que não coube na cache: devolve o registo lido do disco.
	if w := authedCall(s, "PUT", "/api/trips/c", tripBody("c", 0, "x")); w.Code != http.StatusConflict || decode[record](t, w).Rev != 1 {
		t.Errorf("conflito: código %d, %s", w.Code, w.Body)
	}
}

func TestTripListSkipsTripsThatAreNotObjects(t *testing.T) {
	t.Parallel()
	s := newTestServer(t)
	authedCall(s, "PUT", "/api/trips/ok", tripBody("ok", 0, "Boa"))
	for name, body := range map[string]string{"nula": `{"rev":1,"trip":null}`, "sem": `{"rev":1}`, "lista": `[1]`} {
		os.WriteFile(filepath.Join(s.cfg.dataDir, "trips", name+".json"), []byte(body), 0o600)
	}
	w := authedCall(s, "GET", "/api/trips", "")
	if n := len(decode[struct{ Trips []*record }](t, w).Trips); w.Code != http.StatusOK || n != 1 {
		t.Fatalf("esperava só a viagem que a página consegue abrir, veio %d: %s", n, w.Body)
	}
}

// O limite é maxBody bytes de corpo: exatamente maxBody passa, um byte a mais dá 413.
func TestPutTripBody(t *testing.T) {
	t.Parallel()
	s := newTestServer(t)
	body := func(n int) string {
		head, tail := `{"baseRev":0,"trip":{"id":"x","note":"`, `"}}`
		return head + strings.Repeat("a", n-len(head)-len(tail)) + tail
	}
	if w := authedCall(s, "PUT", "/api/trips/x", body(maxBody+1)); w.Code != http.StatusRequestEntityTooLarge {
		t.Errorf("maxBody+1 bytes: código %d, esperava 413", w.Code)
	}
	if w := authedCall(s, "PUT", "/api/trips/x", body(maxBody)); w.Code != http.StatusOK {
		t.Errorf("exatamente maxBody bytes: código %d, esperava 200 (%.200s)", w.Code, w.Body)
	}
}

// updatedAt vem sempre em RFC 3339 e em UTC, seja qual for o fuso do servidor.
func TestPutTripUpdatedAt(t *testing.T) {
	t.Parallel()
	s := newTestServer(t)
	withClock(s, time.Date(2027, 7, 5, 10, 30, 0, 0, time.FixedZone("Lisboa", 3600)))
	w := authedCall(s, "PUT", "/api/trips/x", tripBody("x", 0, "A"))
	if got := decode[record](t, w).UpdatedAt; got != "2027-07-05T09:30:00Z" {
		t.Errorf("resposta com updatedAt %q, esperava 2027-07-05T09:30:00Z", got)
	}
	if b, _ := os.ReadFile(s.tripPath("x")); !strings.HasPrefix(string(b), `{"rev":1,"updatedAt":"2027-07-05T09:30:00Z","trip":{"id":"x"`) {
		t.Errorf("registo em disco: %s", b)
	}
}

func TestPutTripErrors(t *testing.T) {
	t.Parallel()
	t.Run("registo corrompido", func(t *testing.T) {
		s := newTestServer(t)
		os.WriteFile(s.tripPath("x"), []byte(`{"rev":1,"trip":`), 0o600)
		if w := authedCall(s, "PUT", "/api/trips/x", tripBody("x", 1, "A")); w.Code != http.StatusInternalServerError {
			t.Errorf("código %d, esperava 500 (%s)", w.Code, w.Body)
		}
		if b, _ := os.ReadFile(s.tripPath("x")); string(b) != `{"rev":1,"trip":` {
			t.Errorf("o registo corrompido não pode ser substituído às cegas: %s", b)
		}
	})
	t.Run("trips/<id>.json é uma pasta", func(t *testing.T) {
		s := newTestServer(t)
		os.Mkdir(s.tripPath("x"), 0o700)
		if w := authedCall(s, "PUT", "/api/trips/x", tripBody("x", 0, "A")); w.Code != http.StatusInternalServerError {
			t.Errorf("código %d, esperava 500 (%s)", w.Code, w.Body)
		}
	})
	t.Run("pasta trips/ apagada", func(t *testing.T) {
		s := newTestServer(t)
		os.RemoveAll(filepath.Join(s.cfg.dataDir, "trips"))
		logs := captureLog(s)
		w := authedCall(s, "PUT", "/api/trips/x", tripBody("x", 0, "A"))
		if w.Code != http.StatusInternalServerError || !strings.Contains(w.Body.String(), "não consegui gravar") {
			t.Errorf("código %d, esperava 500 \"não consegui gravar\" (%s)", w.Code, w.Body)
		}
		if !strings.Contains(logs.String(), "erro a gravar x") {
			t.Errorf("a falha devia ficar no log: %q", logs.String())
		}
		if len(s.cache) != 0 {
			t.Error("uma gravação falhada não pode ficar na cache")
		}
	})
	t.Run("disco cheio", func(t *testing.T) {
		s := newTestServer(t)
		authedCall(s, "PUT", "/api/trips/x", tripBody("x", 0, "A"))
		before, cached := s.cache["x"], s.cacheBytes
		s.writeFile = func(string, []byte) error { return errors.New("sem espaço") }
		logs := captureLog(s)
		if w := authedCall(s, "PUT", "/api/trips/x", tripBody("x", 1, "B")); w.Code != http.StatusInternalServerError {
			t.Errorf("código %d, esperava 500 (%s)", w.Code, w.Body)
		}
		if !strings.Contains(logs.String(), "erro a gravar x: sem espaço") {
			t.Errorf("a falha devia ficar no log: %q", logs.String())
		}
		if s.cache["x"] != before || s.cacheBytes != cached {
			t.Error("uma gravação falhada não pode mexer na cache")
		}
		if b, _ := os.ReadFile(s.tripPath("x")); !strings.Contains(string(b), `"name":"A"`) {
			t.Errorf("a versão gravada antes tem de ficar: %s", b)
		}
		// a próxima gravação continua a partir da revisão 1
		s.writeFile = writeAtomic
		if w := authedCall(s, "PUT", "/api/trips/x", tripBody("x", 1, "B")); w.Code != http.StatusOK || decode[record](t, w).Rev != 2 {
			t.Errorf("depois de haver espaço: código %d, %s", w.Code, w.Body)
		}
	})
	t.Run("o ficheiro gravado desaparece logo", func(t *testing.T) {
		s := newTestServer(t)
		s.writeFile = func(string, []byte) error { return nil } // diz que gravou, mas não fica nada
		if w := authedCall(s, "PUT", "/api/trips/x", tripBody("x", 0, "A")); w.Code != http.StatusOK {
			t.Errorf("código %d, esperava 200 (%s)", w.Code, w.Body)
		}
		if len(s.cache) != 0 {
			t.Error("sem ficheiro em disco não pode ficar nada na cache")
		}
	})
}

func TestListTripsErrors(t *testing.T) {
	t.Parallel()
	s := newTestServer(t)
	authedCall(s, "PUT", "/api/trips/x", tripBody("x", 0, "A"))
	os.RemoveAll(filepath.Join(s.cfg.dataDir, "trips"))
	if w := authedCall(s, "GET", "/api/trips", ""); w.Code != http.StatusInternalServerError {
		t.Errorf("sem a pasta trips/: código %d, esperava 500 (%s)", w.Code, w.Body)
	}
}

func TestDeleteTripErrors(t *testing.T) {
	t.Parallel()
	s := newTestServer(t)
	authedCall(s, "PUT", "/api/trips/x", tripBody("x", 0, "A"))
	os.WriteFile(filepath.Join(s.cfg.dataDir, "backups", "x"), []byte("não é uma pasta"), 0o600)
	if w := authedCall(s, "DELETE", "/api/trips/x", ""); w.Code != http.StatusInternalServerError {
		t.Errorf("sem pasta para as cópias: código %d, esperava 500", w.Code)
	}
	if _, err := os.Stat(s.tripPath("x")); err != nil {
		t.Errorf("se não há onde guardar a cópia, a viagem fica onde estava: %v", err)
	}

	// Já existe uma pasta com o nome que a cópia ia ter: não dá para mover o ficheiro.
	authedCall(s, "PUT", "/api/trips/y", tripBody("y", 0, "A"))
	withClock(s, time.Date(2027, 7, 5, 12, 0, 0, 0, time.UTC))
	dst := filepath.Join(s.cfg.dataDir, "backups", "y", "apagada-2027-07-05T120000Z.json")
	os.MkdirAll(dst, 0o700)
	os.WriteFile(filepath.Join(dst, "ocupado"), []byte("x"), 0o600)
	if w := authedCall(s, "DELETE", "/api/trips/y", ""); w.Code != http.StatusInternalServerError {
		t.Errorf("sem conseguir mover: código %d, esperava 500", w.Code)
	}
	if _, err := os.Stat(s.tripPath("y")); err != nil {
		t.Errorf("se não conseguiu mover, a viagem fica onde estava: %v", err)
	}
	if _, ok := s.cache["y"]; !ok {
		t.Error("se não conseguiu mover, a viagem continua na cache")
	}
}

func TestDailyBackup(t *testing.T) {
	t.Parallel()
	s := newTestServer(t)
	clk := withClock(s, time.Date(2027, 7, 5, 9, 0, 0, 0, time.UTC))
	dir := filepath.Join(s.cfg.dataDir, "backups", "x")
	put := func(rev int64, name string) {
		t.Helper()
		if w := authedCall(s, "PUT", "/api/trips/x", tripBody("x", rev, name)); w.Code != http.StatusOK {
			t.Fatalf("PUT %s: código %d", name, w.Code)
		}
	}
	copies := func() map[string]string {
		t.Helper()
		out := map[string]string{}
		entries, _ := os.ReadDir(dir)
		for _, e := range entries {
			var tn tripName
			b, _ := os.ReadFile(filepath.Join(dir, e.Name()))
			var rec record
			json.Unmarshal(b, &rec)
			json.Unmarshal(rec.Trip, &tn)
			out[e.Name()] = tn.Name
		}
		return out
	}

	// Três gravações no mesmo dia: uma cópia, com a versão anterior à primeira alteração.
	for i, name := range []string{"A", "B", "C"} {
		put(int64(i), name)
		clk.add(time.Hour)
	}
	if got := copies(); len(got) != 1 || got["2027-07-05.json"] != "A" {
		t.Fatalf("esperava só a cópia de dia 5 com a versão A, encontrei %v", got)
	}

	// No dia seguinte (em UTC), a primeira gravação faz outra cópia, com a versão C.
	clk.add(14 * time.Hour) // 2027-07-06 00:00 UTC
	put(3, "D")
	put(4, "E")
	if got := copies(); len(got) != 2 || got["2027-07-05.json"] != "A" || got["2027-07-06.json"] != "C" {
		t.Errorf("esperava as cópias de dia 5 (A) e de dia 6 (C), encontrei %v", got)
	}

	// Sem conseguir escrever a cópia: fica um aviso no log e a gravação continua.
	clk.add(24 * time.Hour)
	logs := captureLog(s)
	s.writeFile = func(p string, b []byte) error {
		if strings.Contains(p, "backups") {
			return errors.New("sem espaço")
		}
		return writeAtomic(p, b)
	}
	put(5, "F")
	if !strings.Contains(logs.String(), "cópia de x falhou: sem espaço") {
		t.Errorf("a falha da cópia devia ficar no log: %q", logs.String())
	}
	if got := copies(); len(got) != 2 {
		t.Errorf("a cópia falhada não pode deixar ficheiros: %v", got)
	}
	s.writeFile = writeAtomic

	// Sem pasta para a cópia, a gravação continua.
	authedCall(s, "PUT", "/api/trips/y", tripBody("y", 0, "A"))
	os.WriteFile(filepath.Join(s.cfg.dataDir, "backups", "y"), []byte("não é uma pasta"), 0o600)
	if w := authedCall(s, "PUT", "/api/trips/y", tripBody("y", 1, "B")); w.Code != http.StatusOK {
		t.Errorf("a gravação não depende da cópia: código %d", w.Code)
	}

	// Sem o ficheiro de origem não há nada a copiar.
	s.backup("z", filepath.Join(s.cfg.dataDir, "trips", "z.json"))
	if _, err := os.Stat(filepath.Join(s.cfg.dataDir, "backups", "z")); !os.IsNotExist(err) {
		t.Errorf("sem origem não devia criar backups/z: %v", err)
	}
}

func TestWriteAtomic(t *testing.T) {
	t.Parallel()
	dir := t.TempDir()
	if err := writeAtomic(filepath.Join(dir, "nao-existe", "x.json"), []byte("{}")); err == nil {
		t.Error("numa pasta que não existe devia dar erro")
	}
	p := filepath.Join(dir, "x.json")
	for _, data := range []string{`{"v":1}`, `{"v":2}`} { // a segunda escrita substitui a primeira
		if err := writeAtomic(p, []byte(data)); err != nil {
			t.Fatal(err)
		}
		if b, _ := os.ReadFile(p); string(b) != data {
			t.Errorf("conteúdo %s, esperava %s", b, data)
		}
	}
	if fi, _ := os.Stat(p); runtime.GOOS != "windows" && fi.Mode().Perm() != 0o600 {
		t.Errorf("permissões %v, esperava 0600", fi.Mode().Perm())
	}
	if tmp, _ := filepath.Glob(filepath.Join(dir, ".tmp-*")); len(tmp) != 0 {
		t.Errorf("ficaram ficheiros temporários: %v", tmp)
	}
}

// cacheBytes tem de ser sempre a soma dos bytes guardados na cache.
func TestTripCache(t *testing.T) {
	t.Parallel()
	s := newTestServer(t)
	check := func(when string, n int) {
		t.Helper()
		var sum int64
		for _, c := range s.cache {
			sum += int64(len(c.raw))
		}
		if len(s.cache) != n || s.cacheBytes != sum {
			t.Errorf("%s: %d viagens e %d bytes na cache, esperava %d viagens e %d bytes", when, len(s.cache), s.cacheBytes, n, sum)
		}
	}
	for _, id := range []string{"a", "b", "c"} {
		authedCall(s, "PUT", "/api/trips/"+id, tripBody(id, 0, "Viagem "+id))
	}
	check("depois de criar", 3)
	authedCall(s, "PUT", "/api/trips/a", tripBody("a", 1, "Um nome bem mais comprido do que o primeiro"))
	check("depois de gravar", 3)
	authedCall(s, "DELETE", "/api/trips/b", "")
	check("depois de apagar", 2)
	os.Remove(s.tripPath("c"))
	authedCall(s, "GET", "/api/trips", "")
	check("depois de tirar à mão", 1)
}

// Vários dispositivos a criar a mesma viagem ao mesmo tempo: só um ganha, os outros recebem 409.
func TestConcurrentPuts(t *testing.T) {
	t.Parallel()
	s := newTestServer(t)
	const n = 10
	codes := make(chan int, n)
	var wg sync.WaitGroup
	for i := 0; i < n; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			codes <- authedCall(s, "PUT", "/api/trips/x", tripBody("x", 0, fmt.Sprint("dispositivo ", i))).Code
		}()
	}
	wg.Wait()
	close(codes)
	count := map[int]int{}
	for c := range codes {
		count[c]++
	}
	if count[http.StatusOK] != 1 || count[http.StatusConflict] != n-1 {
		t.Errorf("esperava 1 × 200 e %d × 409, veio %v", n-1, count)
	}
	if rec := decode[record](t, authedCall(s, "PUT", "/api/trips/x", tripBody("x", 0, "tarde"))); rec.Rev != 1 {
		t.Errorf("a viagem devia ficar na revisão 1, está na %d", rec.Rev)
	}
}

/* ---------- medições: go test -run '^$' -bench . -benchmem ---------- */

// benchTrip devolve uma viagem com n atividades (~170 bytes cada).
func benchTrip(id string, n int) string {
	var sb strings.Builder
	fmt.Fprintf(&sb, `{"id":%q,"name":"Viagem de teste","start":"2027-03-01","end":"2027-04-29","dayStart":7,"dayEnd":1,"people":3,"currency":"€","places":[],"dayPlaces":{},"tray":[],"costs":[],"blocks":[`, id)
	for i := 0; i < n; i++ {
		if i > 0 {
			sb.WriteByte(',')
		}
		fmt.Fprintf(&sb, `{"id":"a%d","date":"2027-03-%02d","start":%d,"len":90,"title":"Atividade %d no sítio","cat":"tour","status":"reservado","pp":12.5,"note":"Nota com acentuação e €"}`, i, 1+i%28, 420+i%60*15, i)
	}
	sb.WriteString("]}")
	return sb.String()
}

// GET /api/trips com 10 viagens de ~38 KB ou uma de ~1,2 MB; "304" é o refresh sem alterações.
func BenchmarkListTrips(b *testing.B) {
	for _, tc := range []struct {
		name     string
		trips, n int
		same     bool
	}{{"10x38KB", 10, 200, false}, {"1x1.2MB", 1, 7000, false}, {"10x38KB/304", 10, 200, true}} {
		b.Run(tc.name, func(b *testing.B) {
			s := newTestServer(b)
			for i := 0; i < tc.trips; i++ {
				id := fmt.Sprintf("t%d", i)
				if w := authedCall(s, "PUT", "/api/trips/"+id, `{"baseRev":0,"trip":`+benchTrip(id, tc.n)+`}`); w.Code != http.StatusOK {
					b.Fatalf("PUT: %d %s", w.Code, w.Body)
				}
			}
			tok := s.newToken()
			inm := ""
			if tc.same {
				inm = authedCall(s, "GET", "/api/trips", "").Header().Get("ETag")
			}
			b.ReportAllocs()
			b.ResetTimer()
			for i := 0; i < b.N; i++ {
				if w := call(s, "GET", "/api/trips", "", withCookie(tok), withHeader("If-None-Match", inm)); w.Code >= 400 {
					b.Fatal(w.Code)
				}
			}
		})
	}
}

// PUT de uma viagem de ~1,2 MB, com a escrita em disco (fsync incluído).
func BenchmarkPutTrip(b *testing.B) {
	s := newTestServer(b)
	trip := benchTrip("x", 7000)
	tok := s.newToken()
	b.SetBytes(int64(len(trip)))
	b.ReportAllocs()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		body := io.MultiReader(strings.NewReader(fmt.Sprintf(`{"baseRev":%d,"trip":`, i)), strings.NewReader(trip), strings.NewReader("}"))
		r := httptest.NewRequest("PUT", "/api/trips/x", body)
		r.Header.Set("X-Requested-With", "planner")
		r.AddCookie(&http.Cookie{Name: cookieName, Value: tok})
		w := httptest.NewRecorder()
		s.ServeHTTP(w, r)
		if w.Code != http.StatusOK {
			b.Fatalf("PUT %d: %d %s", i, w.Code, w.Body)
		}
	}
}
