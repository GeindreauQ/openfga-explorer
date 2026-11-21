// Session : état serveur pour un utilisateur authentifié. Le cookie
// contient l'ID de session, qui sert à retrouver l'utilisateur en
// mémoire. La session est invalidée à expiration ou au logout.
package authn

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"fmt"
	"strings"
	"sync"
	"time"

	"github.com/GeindreauQ/openfga-explorer/models"
)

// ErrSessionNotFound est renvoyé par SetStoreID quand le cookie ne
// correspond à aucune session active. Différent d'un "session expired"
// pour permettre au caller de distinguer une erreur "pas connecté" d'une
// session arrivée à expiration côté GC.
var ErrSessionNotFound = errors.New("session not found")

// Session est l'état serveur d'une session active.
type Session struct {
	ID   string
	User *models.User
	// StoreID est le store OpenFGA actuellement sélectionné par cet
	// utilisateur. Vide tant qu'aucun store n'a été choisi. Mis à jour
	// par /api/stores/select. Périmètre par-session, ce qui permet
	// plusieurs utilisateurs simultanés sur des stores distincts (vs
	// l'ancien modèle global mutable côté client).
	StoreID string
	// CSRFToken est un secret par-session utilisé par le middleware
	// CSRFMiddleware pour distinguer les requêtes mutatrices issues du
	// frontend authentifié des attaques CSRF cross-origin. Généré à la
	// création de session, jamais transmis en cookie — uniquement via
	// /api/me (puis dans le header X-CSRF-Token par le frontend).
	CSRFToken string
	CreatedAt time.Time
	ExpiresAt time.Time
}

// IsValid indique si la session n'est pas expirée.
func (s *Session) IsValid() bool {
	return time.Now().Before(s.ExpiresAt)
}

// SessionStore est le contrat de stockage des sessions. Une seule
// implémentation aujourd'hui (MemorySessionStore) mais l'interface
// permet d'en ajouter d'autres (Redis, etc.) sans toucher aux
// controllers.
type SessionStore interface {
	Create(user *models.User) (*Session, string, error)
	Get(cookieValue string) *Session
	Delete(cookieValue string)
	// SetStoreID met à jour le store OpenFGA actif lié à cette session.
	// Retourne ErrSessionNotFound si le cookie n'a pas de session
	// correspondante.
	SetStoreID(cookieValue, storeID string) error
	CookieName() string
}

// MemorySessionStore implémente SessionStore en mémoire. Suffisant pour
// un déploiement mono-instance. Pour du multi-replicas, il faudrait un
// store partagé (Redis, etc.) — au-delà du scope d'un outil d'admin.
type MemorySessionStore struct {
	mu         sync.RWMutex
	sessions   map[string]*Session
	secret     []byte
	ttl        time.Duration
	cookieName string
	tokenBytes int
}

// NewMemorySessionStore crée un store en mémoire. `secret` doit faire au
// moins 32 bytes pour HMAC-SHA256 ; en deçà la lib le tolère mais la
// sécurité est réduite (un warning est loggué par le caller).
//
// `ttl` est la durée avant expiration d'une session inactive.
// `cookieName` est le nom du cookie côté navigateur.
// `tokenBytes` est la taille (en bytes) du token aléatoire servant
// d'ID de session ; défaut 32 si <= 0.
func NewMemorySessionStore(secret string, ttl time.Duration, cookieName string, tokenBytes int) *MemorySessionStore {
	if cookieName == "" {
		cookieName = "openfga_explorer_session"
	}
	if tokenBytes <= 0 {
		tokenBytes = 32
	}
	return &MemorySessionStore{
		sessions:   make(map[string]*Session),
		secret:     []byte(secret),
		ttl:        ttl,
		cookieName: cookieName,
		tokenBytes: tokenBytes,
	}
}

// Create enregistre un nouvel utilisateur et retourne (session, cookieValue).
// Le cookie est signé avec HMAC-SHA256.
func (s *MemorySessionStore) Create(user *models.User) (*Session, string, error) {
	id, err := randomToken(s.tokenBytes)
	if err != nil {
		return nil, "", err
	}
	csrf, err := randomToken(s.tokenBytes)
	if err != nil {
		return nil, "", err
	}
	now := time.Now()
	sess := &Session{
		ID:        id,
		User:      user,
		CSRFToken: csrf,
		CreatedAt: now,
		ExpiresAt: now.Add(s.ttl),
	}
	s.mu.Lock()
	s.sessions[id] = sess
	s.mu.Unlock()
	cookie, err := s.sign(id)
	if err != nil {
		return nil, "", err
	}
	return sess, cookie, nil
}

// Get récupère une session depuis la valeur d'un cookie signé. Renvoie
// nil si le cookie est invalide, expiré ou inconnu.
func (s *MemorySessionStore) Get(cookieValue string) *Session {
	if cookieValue == "" {
		return nil
	}
	id, err := s.verify(cookieValue)
	if err != nil {
		return nil
	}
	s.mu.RLock()
	sess := s.sessions[id]
	s.mu.RUnlock()
	if sess == nil || !sess.IsValid() {
		if sess != nil {
			s.mu.Lock()
			delete(s.sessions, id)
			s.mu.Unlock()
		}
		return nil
	}
	return sess
}

// Delete invalide une session (logout).
func (s *MemorySessionStore) Delete(cookieValue string) {
	id, err := s.verify(cookieValue)
	if err != nil {
		return
	}
	s.mu.Lock()
	delete(s.sessions, id)
	s.mu.Unlock()
}

// SetStoreID met à jour le store ID lié à la session identifiée par
// cookieValue. Renvoie ErrSessionNotFound si le cookie ne correspond à
// aucune session active (cookie invalide, expiré, ou jamais émis).
//
// Cohérence multi-utilisateur : avant ce mécanisme, le store ID vivait
// dans le client OpenFGA global, ce qui faisait que l'utilisateur A
// héritait du store sélectionné par l'utilisateur B. Désormais le store
// est scopé à la session.
func (s *MemorySessionStore) SetStoreID(cookieValue, storeID string) error {
	id, err := s.verify(cookieValue)
	if err != nil {
		return ErrSessionNotFound
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	sess, ok := s.sessions[id]
	if !ok || !sess.IsValid() {
		return ErrSessionNotFound
	}
	sess.StoreID = storeID
	return nil
}

// CookieName expose le nom du cookie utilisé.
func (s *MemorySessionStore) CookieName() string { return s.cookieName }

// sign produit "<id>.<hmac>".
func (s *MemorySessionStore) sign(id string) (string, error) {
	mac := hmac.New(sha256.New, s.secret)
	mac.Write([]byte(id))
	sig := mac.Sum(nil)
	return id + "." + base64.RawURLEncoding.EncodeToString(sig), nil
}

// verify parse "<id>.<hmac>" et vérifie la signature.
func (s *MemorySessionStore) verify(cookie string) (string, error) {
	parts := strings.SplitN(cookie, ".", 2)
	if len(parts) != 2 {
		return "", fmt.Errorf("malformed cookie")
	}
	id, sigB64 := parts[0], parts[1]
	sig, err := base64.RawURLEncoding.Strict().DecodeString(sigB64)
	if err != nil {
		return "", err
	}
	mac := hmac.New(sha256.New, s.secret)
	mac.Write([]byte(id))
	if !hmac.Equal(mac.Sum(nil), sig) {
		return "", fmt.Errorf("bad signature")
	}
	return id, nil
}

// StartGC lance une goroutine qui nettoie les sessions expirées toutes
// les `interval`. À appeler dans main.go après la création du store.
// Sans GC, les sessions expirées ne sont nettoyées que lors d'un accès
// via Get() — les sessions jamais relues restent en mémoire.
func (s *MemorySessionStore) StartGC(interval time.Duration) {
	go func() {
		ticker := time.NewTicker(interval)
		defer ticker.Stop()
		for range ticker.C {
			s.mu.Lock()
			now := time.Now()
			for id, sess := range s.sessions {
				if now.After(sess.ExpiresAt) {
					delete(s.sessions, id)
				}
			}
			s.mu.Unlock()
		}
	}()
}

func randomToken(n int) (string, error) {
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(b), nil
}
