package config

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"gopkg.in/yaml.v3"
)

// writeTempYAML crée un fichier YAML temporaire pour le test et
// retourne son chemin. Cleanup via t.Cleanup.
func writeTempYAML(t *testing.T, body string) string {
	t.Helper()
	dir := t.TempDir()
	path := filepath.Join(dir, "config.yaml")
	if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
		t.Fatalf("write temp yaml: %v", err)
	}
	return path
}

func TestLoad_NoYAML_DefaultsApplied(t *testing.T) {
	cfg := Load("")

	// Tuning : defaults codés en dur.
	if cfg.Tuning.SessionTTL != 8*time.Hour {
		t.Errorf("SessionTTL = %s, want 8h", cfg.Tuning.SessionTTL)
	}
	if cfg.Tuning.SSEMaxSubscribers != 100 {
		t.Errorf("SSEMaxSubscribers = %d, want 100", cfg.Tuning.SSEMaxSubscribers)
	}
	if cfg.Tuning.SessionCookieName != "openfga_explorer_session" {
		t.Errorf("SessionCookieName = %q, want default", cfg.Tuning.SessionCookieName)
	}

	// Theme : defaults complets.
	if len(cfg.Theme.Types) != 9 {
		t.Errorf("Theme.Types size = %d, want 9", len(cfg.Theme.Types))
	}
	if _, ok := cfg.Theme.Types["user"]; !ok {
		t.Error("Theme.Types should contain 'user' by default")
	}
	if cfg.Theme.Default == nil {
		t.Error("Theme.Default should be non-nil by default")
	}
}

func TestLoad_YAMLOverridesTuning(t *testing.T) {
	path := writeTempYAML(t, `
tuning:
  session_ttl: 1h
  sse_max_subscribers: 5
  session_cookie_name: my_custom_cookie
`)

	cfg := Load(path)

	if cfg.Tuning.SessionTTL != 1*time.Hour {
		t.Errorf("SessionTTL = %s, want 1h", cfg.Tuning.SessionTTL)
	}
	if cfg.Tuning.SSEMaxSubscribers != 5 {
		t.Errorf("SSEMaxSubscribers = %d, want 5", cfg.Tuning.SSEMaxSubscribers)
	}
	if cfg.Tuning.SessionCookieName != "my_custom_cookie" {
		t.Errorf("SessionCookieName = %q, want my_custom_cookie", cfg.Tuning.SessionCookieName)
	}
	// Les clés absentes du YAML conservent leur défaut.
	if cfg.Tuning.BootstrapTimeout != 15*time.Second {
		t.Errorf("BootstrapTimeout = %s, want 15s (default)", cfg.Tuning.BootstrapTimeout)
	}
}

func TestLoad_YAMLPartialThemeMergesTypes(t *testing.T) {
	path := writeTempYAML(t, `
theme:
  types:
    user:
      icon: ti-crown
      bg: '#000000'
      text: '#FFFFFF'
      border: '#FFD700'
`)
	cfg := Load(path)

	// Le user override prend effet.
	user := cfg.Theme.Types["user"]
	if user.Icon != "ti-crown" {
		t.Errorf("Types.user.icon = %q, want ti-crown", user.Icon)
	}
	if user.Bg != "#000000" {
		t.Errorf("Types.user.bg = %q, want #000000", user.Bg)
	}

	// Les autres types gardent leur built-in.
	if _, ok := cfg.Theme.Types["organization"]; !ok {
		t.Error("organization should still be in built-in defaults")
	}
}

func TestLoad_YAMLMalformed_FailsAtUnmarshal(t *testing.T) {
	// On vérifie que yaml.Unmarshal échoue proprement sur une durée
	// invalide — c'est le prérequis pour que loadYAML renvoie une erreur.
	data := []byte("tuning:\n  session_ttl: not-a-duration\n")
	var doc struct {
		Tuning *TuningConfig `yaml:"tuning"`
	}
	err := yaml.Unmarshal(data, &doc)
	if err == nil {
		t.Fatal("yaml.Unmarshal should fail on bad duration")
	}
	// yaml.v3 signale la ligne + le type qui pose problème — on
	// vérifie que l'erreur mentionne au moins l'un des deux.
	if !strings.Contains(err.Error(), "session_ttl") &&
		!strings.Contains(err.Error(), "time.Duration") {
		t.Errorf("error should mention 'session_ttl' or 'time.Duration', got: %v", err)
	}
}

func TestThemeAsJSON(t *testing.T) {
	cfg := Load("")
	data, err := cfg.ThemeAsJSON()
	if err != nil {
		t.Fatalf("ThemeAsJSON: %v", err)
	}
	if len(data) == 0 {
		t.Error("ThemeAsJSON returned empty bytes")
	}
	s := string(data)
	// Le JSON doit contenir les 3 sections.
	for _, want := range []string{`"types"`, `"palette"`, `"default"`, `"user"`} {
		if !strings.Contains(s, want) {
			t.Errorf("JSON should contain %s, got: %s", want, s)
		}
	}
}

func TestValidate_SessionSecret_DefaultValue_FailsWhenAuthEnabled(t *testing.T) {
	cfg := Load("")
	cfg.Auth.Disabled = false
	cfg.Auth.SessionSecret = "dev-only-insecure-change-me"

	err := cfg.Validate()
	if err == nil {
		t.Fatal("Validate should reject default SESSION_SECRET when auth is enabled")
	}
	if !strings.Contains(err.Error(), "SESSION_SECRET") {
		t.Errorf("error should mention SESSION_SECRET, got: %v", err)
	}
}

func TestValidate_SessionSecret_Empty_FailsWhenAuthEnabled(t *testing.T) {
	cfg := Load("")
	cfg.Auth.Disabled = false
	cfg.Auth.SessionSecret = ""

	err := cfg.Validate()
	if err == nil {
		t.Fatal("Validate should reject empty SESSION_SECRET when auth is enabled")
	}
}

func TestValidate_SessionSecret_TooShort_FailsWhenAuthEnabled(t *testing.T) {
	cfg := Load("")
	cfg.Auth.Disabled = false
	cfg.Auth.SessionSecret = "too-short" // 9 chars, < 32

	err := cfg.Validate()
	if err == nil {
		t.Fatal("Validate should reject SESSION_SECRET < 32 chars when auth is enabled")
	}
	if !strings.Contains(err.Error(), "32") {
		t.Errorf("error should mention 32 chars threshold, got: %v", err)
	}
}

func TestValidate_SessionSecret_Disabled_SkipsCheck(t *testing.T) {
	cfg := Load("")
	cfg.Auth.Disabled = true
	cfg.Auth.SessionSecret = "dev-only-insecure-change-me" // default, but auth off

	if err := cfg.Validate(); err != nil {
		t.Errorf("Validate should not fail when AUTH_DISABLED=1, got: %v", err)
	}
}

func TestValidate_SessionSecret_StrongValue_Passes(t *testing.T) {
	cfg := Load("")
	cfg.Auth.Disabled = false
	cfg.Auth.SessionSecret = strings.Repeat("a", 32) // 32 chars

	if err := cfg.Validate(); err != nil {
		t.Errorf("Validate should accept 32-char SESSION_SECRET, got: %v", err)
	}
}

func TestLoad_OIDCScopes_CommasOrSpaces(t *testing.T) {
	for _, value := range []string{"", "openid,profile,email", "openid profile email", "profile, email"} {
		t.Setenv("OIDC_SCOPES", value)
		got := strings.Join(Load("").Auth.OIDC.Scopes, ",")
		if got != "openid,profile,email" {
			t.Errorf("OIDC_SCOPES=%q → %q, want openid,profile,email", value, got)
		}
	}
}

func TestValidate_LocalLoginDisabledNeedsOIDC(t *testing.T) {
	t.Setenv("SESSION_SECRET", strings.Repeat("x", 32))
	t.Setenv("LOCAL_LOGIN_DISABLED", "1")
	if err := Load("").Validate(); err == nil {
		t.Fatal("LOCAL_LOGIN_DISABLED sans OIDC devrait être refusé")
	}
	t.Setenv("OIDC_ISSUER_URL", "https://idp.example.com")
	t.Setenv("OIDC_CLIENT_ID", "explorer")
	t.Setenv("OIDC_REDIRECT_URL", "https://explorer.example.com/auth/callback")
	if err := Load("").Validate(); err != nil {
		t.Fatalf("avec OIDC : %v", err)
	}
}

func TestValidate_OpenFGAOAuth(t *testing.T) {
	t.Setenv("SESSION_SECRET", strings.Repeat("x", 32))
	t.Setenv("OPENFGA_OIDC_TOKEN_URL", "https://idp.example.com/token")
	t.Setenv("OPENFGA_OIDC_CLIENT_ID", "openfga")
	if err := Load("").Validate(); err == nil {
		t.Fatal("un client sans secret ni compte de service devrait être refusé")
	}
	t.Setenv("OPENFGA_OIDC_USERNAME", "openfga-explorer")
	t.Setenv("OPENFGA_OIDC_PASSWORD", "app-password")
	if err := Load("").Validate(); err != nil {
		t.Fatal(err)
	}
}

func TestLoad_OIDCRoleGroups(t *testing.T) {
	t.Setenv("OIDC_ADMIN_GROUPS", "openfga-admins, authentik Admins,")
	t.Setenv("OIDC_VIEWER_GROUPS", "openfga-viewers")
	oidc := Load("").Auth.OIDC
	if got := strings.Join(oidc.AdminGroups, "|"); got != "openfga-admins|authentik Admins" {
		t.Errorf("AdminGroups = %q", got)
	}
	if got := strings.Join(oidc.ViewerGroups, "|"); got != "openfga-viewers" {
		t.Errorf("ViewerGroups = %q", got)
	}
}
