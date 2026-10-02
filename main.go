// Planeador de Férias — servidor.
//
// Um único binário sem dependências externas: serve a página, trata do login
// e guarda cada viagem num ficheiro JSON próprio dentro de DATA_DIR.
package main

import (
	"bytes"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"embed"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"io/fs"
	"log"
	"mime"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

//go:embed web
var webFS embed.FS

const (
	cookieName  = "planner_session"
	sessionTTL  = 30 * 24 * time.Hour
	maxBody     = 2 << 20 // 2 MB por viagem
	backupsKept = 30
)

var idRe = regexp.MustCompile(`^[A-Za-z0-9_-]{1,64}$`)

type config struct {
	user, password, dataDir, addr string
}

type server struct {
	cfg    config
	key    []byte // chave de assinatura das sessões
	mu     sync.Mutex
	static map[string]staticFile

	limMu    sync.Mutex
	failures map[string][]time.Time
}

type staticFile struct {
	body  []byte
	ctype string
	etag  string
}

// record é o que fica em disco para cada viagem.
type record struct {
	Rev       int64           `json:"rev"`
	UpdatedAt string          `json:"updatedAt"`
	Trip      json.RawMessage `json:"trip"`
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
	}
	if cfg.user == "" || cfg.password == "" {
		log.Fatal("Define PLANNER_USER e PLANNER_PASSWORD antes de arrancar (ver .env.example).")
	}
	if len(cfg.password) < 10 {
		log.Fatal("PLANNER_PASSWORD tem de ter pelo menos 10 caracteres.")
	}
	for _, d := range []string{"trips", "backups"} {
		if err := os.MkdirAll(filepath.Join(cfg.dataDir, d), 0o700); err != nil {
			log.Fatalf("Não consigo criar %s: %v", filepath.Join(cfg.dataDir, d), err)
		}
	}

	s := &server{cfg: cfg, failures: map[string][]time.Time{}}
	if err := s.loadKey(); err != nil {
		log.Fatalf("Não consigo preparar a chave das sessões: %v", err)
	}
	if err := s.loadStatic(); err != nil {
		log.Fatalf("Não consigo carregar a página: %v", err)
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

/* ---------- sessões ---------- */

// loadKey junta um segredo aleatório guardado em disco com a palavra-passe:
// as sessões sobrevivem a reinícios e deixam de valer se a palavra-passe mudar.
func (s *server) loadKey() error {
	p := filepath.Join(s.cfg.dataDir, ".session-secret")
	secret, err := os.ReadFile(p)
	if err != nil || len(secret) < 32 {
		secret = make([]byte, 32)
		if _, err := rand.Read(secret); err != nil {
			return err
		}
		if err := os.WriteFile(p, secret, 0o600); err != nil {
			return err
		}
	}
	h := sha256.New()
	h.Write(secret)
	h.Write([]byte(s.cfg.user + "\x00" + s.cfg.password))
	s.key = h.Sum(nil)
	return nil
}

func (s *server) sign(payload string) string {
	m := hmac.New(sha256.New, s.key)
	m.Write([]byte(payload))
	return base64.RawURLEncoding.EncodeToString(m.Sum(nil))
}

func (s *server) newToken() string {
	payload := strconv.FormatInt(time.Now().Add(sessionTTL).Unix(), 10)
	return payload + "." + s.sign(payload)
}

func (s *server) authed(r *http.Request) bool {
	c, err := r.Cookie(cookieName)
	if err != nil {
		return false
	}
	payload, sig, ok := strings.Cut(c.Value, ".")
	if !ok || !hmac.Equal([]byte(sig), []byte(s.sign(payload))) {
		return false
	}
	exp, err := strconv.ParseInt(payload, 10, 64)
	return err == nil && time.Now().Unix() < exp
}

func isHTTPS(r *http.Request) bool {
	return r.TLS != nil || strings.EqualFold(r.Header.Get("X-Forwarded-Proto"), "https")
}

func (s *server) setCookie(w http.ResponseWriter, r *http.Request, value string, maxAge int) {
	http.SetCookie(w, &http.Cookie{
		Name: cookieName, Value: value, Path: "/", MaxAge: maxAge,
		HttpOnly: true, Secure: isHTTPS(r), SameSite: http.SameSiteStrictMode,
	})
}

func equalStr(a, b string) bool {
	ha, hb := sha256.Sum256([]byte(a)), sha256.Sum256([]byte(b))
	return subtle.ConstantTimeCompare(ha[:], hb[:]) == 1
}

func clientIP(r *http.Request) string {
	if xff := r.Header.Get("X-Forwarded-For"); xff != "" {
		return strings.TrimSpace(strings.Split(xff, ",")[0])
	}
	h, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return h
}

// tooManyFailures limita tentativas falhadas: 8 por endereço e 40 no total, em 10 minutos.
func (s *server) tooManyFailures(ip string) bool {
	s.limMu.Lock()
	defer s.limMu.Unlock()
	cut := time.Now().Add(-10 * time.Minute)
	total := 0
	for k, ts := range s.failures {
		keep := ts[:0]
		for _, t := range ts {
			if t.After(cut) {
				keep = append(keep, t)
			}
		}
		if len(keep) == 0 {
			delete(s.failures, k)
			continue
		}
		s.failures[k] = keep
		total += len(keep)
	}
	return len(s.failures[ip]) >= 8 || total >= 40
}

func (s *server) noteFailure(ip string) {
	s.limMu.Lock()
	s.failures[ip] = append(s.failures[ip], time.Now())
	s.limMu.Unlock()
}

/* ---------- encaminhamento ---------- */

func (s *server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	h := w.Header()
	h.Set("X-Content-Type-Options", "nosniff")
	h.Set("Referrer-Policy", "no-referrer")
	h.Set("X-Frame-Options", "DENY")
	h.Set("Content-Security-Policy", "default-src 'self'; script-src 'self' https://cdnjs.cloudflare.com; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'")

	p := r.URL.Path
	switch {
	case p == "/healthz":
		io.WriteString(w, "ok")
	case strings.HasPrefix(p, "/api/"):
		s.api(w, r, strings.TrimPrefix(p, "/api/"))
	default:
		s.serveStatic(w, r)
	}
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(v)
}

func fail(w http.ResponseWriter, status int, msg string) {
	writeJSON(w, status, map[string]string{"error": msg})
}

func (s *server) api(w http.ResponseWriter, r *http.Request, path string) {
	// Pedidos que alteram dados têm de vir da própria página (defesa extra contra CSRF,
	// além do cookie SameSite=Strict).
	if r.Method != http.MethodGet && r.Header.Get("X-Requested-With") != "planner" {
		fail(w, http.StatusForbidden, "pedido recusado")
		return
	}

	switch {
	case path == "login" && r.Method == http.MethodPost:
		s.login(w, r)
		return
	case path == "logout" && r.Method == http.MethodPost:
		s.setCookie(w, r, "", -1)
		writeJSON(w, 200, map[string]bool{"ok": true})
		return
	}

	if !s.authed(r) {
		fail(w, http.StatusUnauthorized, "sessão em falta")
		return
	}

	switch {
	case path == "trips" && r.Method == http.MethodGet:
		s.listTrips(w)
	case strings.HasPrefix(path, "trips/"):
		id := strings.TrimPrefix(path, "trips/")
		if !idRe.MatchString(id) {
			fail(w, http.StatusBadRequest, "identificador inválido")
			return
		}
		switch r.Method {
		case http.MethodPut:
			s.putTrip(w, r, id)
		case http.MethodDelete:
			s.deleteTrip(w, id)
		default:
			fail(w, http.StatusMethodNotAllowed, "método não suportado")
		}
	default:
		fail(w, http.StatusNotFound, "não existe")
	}
}

func (s *server) login(w http.ResponseWriter, r *http.Request) {
	ip := clientIP(r)
	if s.tooManyFailures(ip) {
		fail(w, http.StatusTooManyRequests, "demasiadas tentativas")
		return
	}
	var in struct{ User, Password string }
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4096)).Decode(&in); err != nil {
		fail(w, http.StatusBadRequest, "pedido inválido")
		return
	}
	okUser := equalStr(strings.TrimSpace(in.User), s.cfg.user)
	okPass := equalStr(in.Password, s.cfg.password)
	if !okUser || !okPass {
		s.noteFailure(ip)
		time.Sleep(400 * time.Millisecond)
		fail(w, http.StatusUnauthorized, "credenciais erradas")
		return
	}
	s.setCookie(w, r, s.newToken(), int(sessionTTL.Seconds()))
	writeJSON(w, 200, map[string]string{"user": s.cfg.user})
}

/* ---------- viagens ---------- */

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
	writeJSON(w, 200, map[string]any{"user": s.cfg.user, "trips": trips})
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

/* ---------- ficheiros da página ---------- */

func (s *server) loadStatic() error {
	s.static = map[string]staticFile{}
	return fs.WalkDir(webFS, "web", func(p string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() {
			return err
		}
		b, err := webFS.ReadFile(p)
		if err != nil {
			return err
		}
		sum := sha256.Sum256(b)
		ct := mime.TypeByExtension(filepath.Ext(p))
		if ct == "" {
			ct = "application/octet-stream"
		}
		s.static[strings.TrimPrefix(p, "web")] = staticFile{b, ct, `"` + hex.EncodeToString(sum[:8]) + `"`}
		return nil
	})
}

func (s *server) serveStatic(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		http.Error(w, "método não suportado", http.StatusMethodNotAllowed)
		return
	}
	p := r.URL.Path
	if p == "/" {
		p = "/index.html"
	}
	f, ok := s.static[p]
	if !ok {
		http.NotFound(w, r)
		return
	}
	w.Header().Set("Content-Type", f.ctype)
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("ETag", f.etag)
	if r.Header.Get("If-None-Match") == f.etag {
		w.WriteHeader(http.StatusNotModified)
		return
	}
	w.Header().Set("Content-Length", fmt.Sprint(len(f.body)))
	if r.Method == http.MethodHead {
		return
	}
	w.Write(f.body)
}
