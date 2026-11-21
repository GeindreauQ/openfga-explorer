// User store : comptes locaux hashés (bcrypt) avec seeding d'un admin
// par défaut. Pas de dépendance réseau : tout vit en mémoire.
package authn

import (
	"crypto/rand"
	"fmt"
	"log"
	"strings"
	"sync"

	"golang.org/x/crypto/bcrypt"

	"github.com/GeindreauQ/openfga-explorer/models"
)

// builtInUser est l'enregistrement interne d'un compte local. Le mot
// de passe n'est jamais stocké en clair (bcrypt hash uniquement).
type builtInUser struct {
	Username     string
	Email        string
	Name         string
	PasswordHash []byte
	Roles        []string
}

// UserStore est le contrat pour vérifier et lister les utilisateurs
// locaux. Interface fine, extensible à un futur store SQL/LDAP.
type UserStore interface {
	Add(username, email, name, password string, roles []string) error
	Verify(username, password string) (*models.User, error)
	HasUser(username string) bool
}

// MemoryUserStore est l'implémentation par défaut, en mémoire. Suffit
// pour l'usage actuel ; alignement avec SessionStore pour permettre
// plus tard une bascule Redis/SQL sans changer le code appelant.
type MemoryUserStore struct {
	mu    sync.RWMutex
	users map[string]*builtInUser
}

// NewMemoryUserStore crée un store vide.
func NewMemoryUserStore() *MemoryUserStore {
	return &MemoryUserStore{users: make(map[string]*builtInUser)}
}

// Add insère un utilisateur hashé. Retourne une erreur si le username
// est déjà pris ou trop court.
func (s *MemoryUserStore) Add(username, email, name, password string, roles []string) error {
	username = strings.TrimSpace(strings.ToLower(username))
	if username == "" {
		return fmt.Errorf("username vide")
	}
	if len(password) < 8 {
		return fmt.Errorf("mot de passe trop court (min 8 caractères)")
	}
	hash, err := bcrypt.GenerateFromPassword([]byte(password), bcrypt.DefaultCost)
	if err != nil {
		return fmt.Errorf("bcrypt: %w", err)
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, exists := s.users[username]; exists {
		return fmt.Errorf("utilisateur %q existe déjà", username)
	}
	s.users[username] = &builtInUser{
		Username:     username,
		Email:        strings.TrimSpace(email),
		Name:         strings.TrimSpace(name),
		PasswordHash: hash,
		Roles:        roles,
	}
	return nil
}

// Verify vérifie un couple username/password et retourne l'utilisateur
// ou une erreur. La comparaison bcrypt est en temps constant.
func (s *MemoryUserStore) Verify(username, password string) (*models.User, error) {
	username = strings.TrimSpace(strings.ToLower(username))
	s.mu.RLock()
	u, ok := s.users[username]
	s.mu.RUnlock()
	if !ok {
		return nil, fmt.Errorf("utilisateur ou mot de passe invalide")
	}
	if err := bcrypt.CompareHashAndPassword(u.PasswordHash, []byte(password)); err != nil {
		// Message générique pour ne pas leaker l'info "user existe".
		return nil, fmt.Errorf("utilisateur ou mot de passe invalide")
	}
	return &models.User{
		Subject:       "local:" + u.Username,
		Email:         u.Email,
		EmailVerified: true,
		Name:          u.Name,
		PreferredName: u.Username,
		Roles:         u.Roles,
		Source:        "local",
		BuiltIn:       true,
		Role:          models.RoleAdmin,
	}, nil
}

// HasUser indique si un username existe (utile pour les diagnostics).
func (s *MemoryUserStore) HasUser(username string) bool {
	s.mu.RLock()
	defer s.mu.RUnlock()
	_, ok := s.users[strings.ToLower(username)]
	return ok
}

// SeedDefaultAdmin crée l'admin par défaut si OIDC est désactivé et
// qu'aucun admin n'existe déjà.
//
// Le mot de passe est soit :
//   - lu depuis envPassword (recommandé en prod / k8s)
//   - généré aléatoirement (24 chars, alphabet sans ambiguïté)
//
// Le mot de passe en clair est imprimé dans les logs UNE SEULE fois,
// avec un encadré de mise en garde.
//
// Retourne le username et le cleartext password (pour les tests et le
// log).
func SeedDefaultAdmin(store UserStore, envPassword string) (username, cleartext string, seeded bool, err error) {
	const defaultName = "admin"
	if store.HasUser(defaultName) {
		return defaultName, "", false, nil
	}

	if envPassword != "" {
		cleartext = envPassword
	} else {
		cleartext = generatePassword(24)
	}
	email := defaultName + "@local"
	if err := store.Add(defaultName, email, "Default Administrator", cleartext, []string{"admin"}); err != nil {
		return "", "", false, fmt.Errorf("seed admin: %w", err)
	}
	log.Print(`
================================================================
 SECURITY: default admin account created
----------------------------------------------------------------
   username : ` + defaultName + `
   password : ` + cleartext + `
----------------------------------------------------------------
 This password is shown ONCE. Store it in a secret manager now
 (Vault, AWS Secrets Manager, sealed-secrets, etc.) and remove
 it from your log pipeline. To set a fixed password instead,
 pass ADMIN_PASSWORD=<your-secret> to the container.
================================================================`)
	return defaultName, cleartext, true, nil
}

func generatePassword(n int) string {
	const alphabet = "abcdefghijkmnpqrstuvwxyz" +
		"ABCDEFGHJKMNPQRSTUVWXYZ" +
		"23456789" +
		"!@#$%^&*?-_=+"
	out := make([]byte, n)
	buf := make([]byte, n)
	if _, err := rand.Read(buf); err != nil {
		return "openfga-err-change-me-immediately"
	}
	for i, b := range buf {
		out[i] = alphabet[int(b)%len(alphabet)]
	}
	return string(out)
}
