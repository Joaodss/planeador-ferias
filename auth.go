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
	cut := s.now().Add(-10 * time.Minute)
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
	return len(s.failures[ip]) >= 8 || total >= 40
}

func (s *server) noteFailure(ip string) {
	s.limMu.Lock()
	s.failures[ip] = append(s.failures[ip], s.now())
	s.limMu.Unlock()
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
		time.Sleep(s.failDelay)
		fail(w, http.StatusUnauthorized, "credenciais erradas")
		return
	}
	s.setCookie(w, r, s.newToken(), int(sessionTTL.Seconds()))
	writeJSON(w, 200, map[string]string{"user": s.cfg.user})
}

func (s *server) logout(w http.ResponseWriter, r *http.Request) {
	s.setCookie(w, r, "", -1)
	writeJSON(w, 200, map[string]bool{"ok": true})
}
