package main

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/json"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"time"
)

const (
	cookieName = "planner_session"
	sessionTTL = 30 * 24 * time.Hour // renovada a cada uso (ver requireSession)
	// sessionRenewEvery: o cookie só volta a ser emitido quando já passou este tempo desde o último,
	// para não haver um Set-Cookie em cada resposta.
	sessionRenewEvery = 24 * time.Hour

	// Logins falhados (ver tooManyFailures): quem se engana a escrever não chega a estes números, quem tenta
	// adivinhar a palavra-passe fica limitado a poucas tentativas por janela. O limite total apanha também
	// quem muda de endereço a cada tentativa.
	maxFailuresPerIP = 8
	maxFailuresTotal = 40
	failureWindow    = 10 * time.Minute
	// loginFailDelay: espera depois de cada login falhado, que torna as tentativas seguidas ainda mais lentas.
	loginFailDelay = 400 * time.Millisecond
	// maxLoginBytes: o corpo do login só traz o utilizador e a palavra-passe.
	maxLoginBytes = 4096
)

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
	payload := strconv.FormatInt(s.now().Add(sessionTTL).Unix(), 10)
	return payload + "." + s.sign(payload)
}

// session devolve até quando vale a sessão do pedido (ok=false se não houver uma válida).
func (s *server) session(r *http.Request) (exp time.Time, ok bool) {
	c, err := r.Cookie(cookieName)
	if err != nil {
		return
	}
	payload, sig, found := strings.Cut(c.Value, ".")
	if !found || !hmac.Equal([]byte(sig), []byte(s.sign(payload))) {
		return
	}
	unix, err := strconv.ParseInt(payload, 10, 64)
	if err != nil || s.now().Unix() >= unix {
		return
	}
	return time.Unix(unix, 0), true
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

/* ---------- login ---------- */

// constantTimeEqual compara a e b num tempo que não depende de onde diferem nem do comprimento (compara os hashes):
// o tempo de resposta do login não revela quantos caracteres estão certos.
func constantTimeEqual(a, b string) bool {
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

// tooManyFailures diz se o endereço ip já não pode tentar entrar: maxFailuresPerIP falhas dele ou
// maxFailuresTotal no total, na última failureWindow.
func (s *server) tooManyFailures(ip string) bool {
	s.failuresMu.Lock()
	defer s.failuresMu.Unlock()
	total := s.pruneFailures()
	return len(s.failures[ip]) >= maxFailuresPerIP || total >= maxFailuresTotal
}

// pruneFailures esquece as falhas com mais de failureWindow, e os endereços que ficam sem nenhuma,
// e devolve quantas ficam no total. Chamar com s.failuresMu trancado.
func (s *server) pruneFailures() int {
	cut := s.now().Add(-failureWindow)
	total := 0
	for k, ts := range s.failures {
		ts = slices.DeleteFunc(ts, func(t time.Time) bool { return !t.After(cut) })
		if len(ts) == 0 {
			delete(s.failures, k)
			continue
		}
		s.failures[k] = ts
		total += len(ts)
	}
	return total
}

func (s *server) noteFailure(ip string) {
	s.failuresMu.Lock()
	s.failures[ip] = append(s.failures[ip], s.now())
	s.failuresMu.Unlock()
}

func (s *server) login(w http.ResponseWriter, r *http.Request) {
	ip := clientIP(r)
	if s.tooManyFailures(ip) {
		writeError(w, http.StatusTooManyRequests, "demasiadas tentativas")
		return
	}
	var in struct{ User, Password string }
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, maxLoginBytes)).Decode(&in); err != nil {
		writeError(w, http.StatusBadRequest, "pedido inválido")
		return
	}
	okUser := constantTimeEqual(strings.TrimSpace(in.User), s.cfg.user)
	okPass := constantTimeEqual(in.Password, s.cfg.password)
	if !okUser || !okPass {
		s.noteFailure(ip)
		time.Sleep(s.failDelay)
		writeError(w, http.StatusUnauthorized, "credenciais erradas")
		return
	}
	s.setCookie(w, r, s.newToken(), int(sessionTTL.Seconds()))
	writeJSON(w, 200, map[string]string{"user": s.cfg.user})
}

func (s *server) logout(w http.ResponseWriter, r *http.Request) {
	s.setCookie(w, r, "", -1)
	writeJSON(w, 200, map[string]bool{"ok": true})
}
