// Package config centralise la lecture de la configuration.
//
// Les paramètres proviennent de trois sources, par ordre de priorité
// décroissante :
//
//  1. Variables d'environnement (toujours prioritaires, pour les
//     déploiements type Kubernetes/CI)
//  2. Fichier YAML passé via `--config=path` (optionnel, surcharge
//     les défauts in-code pour les valeurs présentes)
//  3. Défauts codés en dur dans `defaults.go`
//
// Sections du YAML supportées :
//
//	tuning:
//	  session_ttl: 8h
//	  sse_max_subscribers: 100
//	  ...
//
//	theme:
//	  types:
//	    user: { icon: ti-user, bg: '#E6F1FB', ... }
//	  palette: [...]
//	  default: { ... }
//
// Sans flag `--config`, le YAML n'est pas lu : comportement strictement
// identique aux versions antérieures (env only).
package config

import (
	"bufio"
	"encoding/json"
	"fmt"
	"log"
	"os"
	"strings"
	"time"
	"unicode"

	"gopkg.in/yaml.v3"
)

// Config regroupe tous les paramètres du serveur, du modèle et du thème.
type Config struct {
	Server  ServerConfig
	OpenFGA OpenFGAConfig
	Auth    AuthConfig
	Tuning  TuningConfig
	Theme   ThemeConfig // exposé au frontend via GET /api/config/theme
}

// ServerConfig : paramètres HTTP et fichiers statiques.
type ServerConfig struct {
	Addr       string
	WebDir     string
	ConfigPath string // chemin du YAML (vide si non passé)
}

// OpenFGAConfig : connexion à l'instance OpenFGA cible.
//
// Le store actif n'est PAS persisté en config : il est sélectionné
// depuis l'UI au démarrage et modifiable à chaud via /api/stores/select.
// L'instance cible (URL + token éventuel) est la seule donnée stable
// dont le binaire a besoin pour démarrer.
type OpenFGAConfig struct {
	URL   string
	Token string
	// OAuth : jetons client_credentials (OPENFGA_OIDC_*), pour un OpenFGA
	// configuré en authn.method: oidc. Prioritaire sur Token.
	OAuth OpenFGAOAuthConfig
}

// OpenFGAOAuthConfig décrit l'obtention d'un jeton OAuth2 pour OpenFGA.
// Username/Password : compte de service et app password (Authentik) ;
// sinon ClientSecret.
type OpenFGAOAuthConfig struct {
	TokenURL     string
	ClientID     string
	ClientSecret string
	Username     string
	Password     string
	Scope        string
}

// AuthConfig : authentification (OIDC + locale + modes spéciaux).
type AuthConfig struct {
	OIDC         OIDCConfig
	LocalEnabled bool
	// LocalDisabled (LOCAL_LOGIN_DISABLED=1) retire le login local quand
	// l'OIDC est configuré : plus de mot de passe admin exposé.
	LocalDisabled bool
	Disabled      bool
	SessionSecret string
	AdminPassword string
	SecureCookies bool
	RateLimitRPM  int
}

// OIDCConfig : paramètres OIDC.
type OIDCConfig struct {
	IssuerURL    string
	ClientID     string
	ClientSecret string
	RedirectURL  string
	Scopes       []string
	// AdminGroups : groupes (claim "groups") qui donnent le rôle admin.
	// Vide : tout utilisateur OIDC est admin.
	AdminGroups []string
	// ViewerGroups : groupes qui donnent la lecture seule. Vide : tout
	// utilisateur hors AdminGroups est viewer ; sinon les autres sont refusés.
	ViewerGroups []string
}

// TuningConfig : valeurs numériques / durées surchargeables depuis le
// YAML. Toutes ont un défaut codé en dur dans `defaults.go`.
type TuningConfig struct {
	SessionTTL          time.Duration `yaml:"session_ttl"`
	BootstrapTimeout    time.Duration `yaml:"bootstrap_timeout"`
	OIDCInitTimeout     time.Duration `yaml:"oidc_init_timeout"`
	SSEMaxSubscribers   int           `yaml:"sse_max_subscribers"`
	SSEChannelBuffer    int           `yaml:"sse_channel_buffer"`
	RateLimitIdleTTL    time.Duration `yaml:"ratelimit_idle_ttl"`
	RateLimitDefaultRPM int           `yaml:"ratelimit_default_per_min"`
	SessionCookieName   string        `yaml:"session_cookie_name"`
	SessionTokenBytes   int           `yaml:"session_token_bytes"`
	SessionGCInterval   time.Duration `yaml:"session_gc_interval"`
}

// ThemeConfig : branding frontend servi en JSON. Chaque entrée est
// optionnelle : on ne surcharge que ce qui est présent, le reste vient
// du built-in (cf. `defaults.go`).
type ThemeConfig struct {
	Types   map[string]ThemeEntry `yaml:"types"`
	Palette []ThemeEntry          `yaml:"palette"`
	Default *ThemeEntry           `yaml:"default"`
}

// ThemeEntry décrit les 4 propriétés visuelles d'un type ou d'une entrée
// de palette. Le mapping YAML est direct (icon, bg, text, border). Les
// tags JSON exposent les clés en lowercase pour matcher les conventions
// du frontend (cf. `src/web/js/lib/theme.js`).
type ThemeEntry struct {
	Icon   string `yaml:"icon" json:"icon"`
	Bg     string `yaml:"bg" json:"bg"`
	Text   string `yaml:"text" json:"text"`
	Border string `yaml:"border" json:"border"`
}

// ThemeJSON est la projection JSON envoyée au frontend (clés
// identiques, juste sérialisée en JSON).
type ThemeJSON struct {
	Types   map[string]ThemeEntry `json:"types"`
	Palette []ThemeEntry          `json:"palette"`
	Default ThemeEntry            `json:"default"`
}

// Load lit la config depuis l'environnement (et éventuellement un
// fichier YAML si path != ""). L'env est lu en PREMIER, puis le YAML
// surcharge ce qui est défini — sauf indication contraire dans la
// fonction (cf. `merge`).
func Load(configPath string) Config {
	loadDotEnv(".env")
	// Virgules ou espaces : "openid,profile,email" comme "openid profile email".
	scopes := splitList(envOr("OIDC_SCOPES", "openid,profile,email"))
	// OIDC spec requiert le scope "openid"
	hasOpenID := false
	for _, s := range scopes {
		if s == "openid" {
			hasOpenID = true
			break
		}
	}
	if !hasOpenID {
		scopes = append([]string{"openid"}, scopes...)
	}

	cfg := Config{
		Server: ServerConfig{
			Addr:       envOr("ADDR", ":8000"),
			WebDir:     envOr("WEB_DIR", "../web"),
			ConfigPath: configPath,
		},
		OpenFGA: OpenFGAConfig{
			URL:   strings.TrimRight(os.Getenv("OPENFGA_URL"), "/"),
			Token: os.Getenv("OPENFGA_TOKEN"),
			OAuth: OpenFGAOAuthConfig{
				TokenURL:     os.Getenv("OPENFGA_OIDC_TOKEN_URL"),
				ClientID:     os.Getenv("OPENFGA_OIDC_CLIENT_ID"),
				ClientSecret: os.Getenv("OPENFGA_OIDC_CLIENT_SECRET"),
				Username:     os.Getenv("OPENFGA_OIDC_USERNAME"),
				Password:     os.Getenv("OPENFGA_OIDC_PASSWORD"),
				Scope:        os.Getenv("OPENFGA_OIDC_SCOPE"),
			},
		},
		Auth: AuthConfig{
			OIDC: OIDCConfig{
				IssuerURL:    os.Getenv("OIDC_ISSUER_URL"),
				ClientID:     os.Getenv("OIDC_CLIENT_ID"),
				ClientSecret: os.Getenv("OIDC_CLIENT_SECRET"),
				RedirectURL:  os.Getenv("OIDC_REDIRECT_URL"),
				Scopes:       scopes,
				AdminGroups:  splitCSV(os.Getenv("OIDC_ADMIN_GROUPS")),
				ViewerGroups: splitCSV(os.Getenv("OIDC_VIEWER_GROUPS")),
			},
			SessionSecret: envOr("SESSION_SECRET", "dev-only-insecure-change-me"),
			AdminPassword: os.Getenv("ADMIN_PASSWORD"),
		},
	}

	// Auth activée par défaut. AUTH_DISABLED=1 est l'exception.
	cfg.Auth.Disabled = os.Getenv("AUTH_DISABLED") == "1"
	cfg.Auth.SecureCookies = os.Getenv("SECURE_COOKIES") == "1"
	cfg.Auth.LocalDisabled = os.Getenv("LOCAL_LOGIN_DISABLED") == "1"

	// Rate limit : RATE_LIMIT_PER_MIN, défaut 50.
	// 5 (l'ancienne valeur) causait des timeouts dans la suite E2E
	// (30 tests × 1 login = 30 req/min > 5). 50 reste raisonnable en
	// prod pour un outil d'admin mono-équipe, et `RATE_LIMIT_PER_MIN`
	// permet de l'ajuster vers le bas si besoin (ex: derrière un
	// reverse-proxy mutualisé).
	cfg.Auth.RateLimitRPM = 50
	if v := os.Getenv("RATE_LIMIT_PER_MIN"); v != "" {
		if n, err := atoi(v); err == nil && n > 0 {
			cfg.Auth.RateLimitRPM = n
		}
	}

	// Tunings : valeurs par défaut in-code (env n'a pas la priorité sur
	// ces champs-là — passez par le YAML ou recompilez).
	cfg.Tuning = DefaultTuning()

	// Theme : on commence avec les défauts, le YAML surcharge ce qui est
	// présent.
	cfg.Theme = DefaultTheme()

	// Charge le YAML si un chemin est fourni. L'absence de fichier
	// n'est pas une erreur : sans `--config`, la config vient
	// exclusivement de l'env et des défauts in-code.
	if configPath != "" {
		if err := loadYAML(configPath, &cfg); err != nil {
			log.Fatalf("config: %v (--config=%s)", err, configPath)
		}
		log.Printf("config: %s chargé (tuning + theme)", configPath)
	}

	log.Printf("config: OPENFGA_URL=%q OIDC=%q auth_disabled=%v secure_cookies=%v rate_limit=%d/min",
		cfg.OpenFGA.URL,
		cfg.Auth.OIDC.IssuerURL, cfg.Auth.Disabled, cfg.Auth.SecureCookies,
		cfg.Auth.RateLimitRPM)

	if cfg.Auth.SessionSecret == "dev-only-insecure-change-me" {
		log.Printf("SECURITY: SESSION_SECRET is the placeholder value. " +
			"This is fine for local dev but MUST be overridden before any " +
			"non-local deployment (set SESSION_SECRET to a 32+ char random string).")
	}

	if cfg.ConfiguredOIDC() && !cfg.Auth.Disabled &&
		!strings.HasPrefix(strings.ToLower(cfg.Auth.OIDC.RedirectURL), "https://") &&
		os.Getenv("OIDC_ALLOW_INSECURE_REDIRECT") != "1" {
		log.Printf("SECURITY: OIDC_REDIRECT_URL=%q does not use HTTPS. "+
			"This is fine for local dev but the OIDC code flow will leak the "+
			"authorization code over the wire. Set OIDC_REDIRECT_URL to an "+
			"https:// URL, or OIDC_ALLOW_INSECURE_REDIRECT=1 to silence this "+
			"warning.", cfg.Auth.OIDC.RedirectURL)
	}
	return cfg
}

// ThemeAsJSON retourne le thème actif sous forme JSON, prêt à être
// servi au frontend via /api/config/theme.
func (c Config) ThemeAsJSON() ([]byte, error) {
	theme := ThemeJSON{
		Types:   c.Theme.Types,
		Palette: c.Theme.Palette,
		Default: ThemeEntry{},
	}
	if c.Theme.Default != nil {
		theme.Default = *c.Theme.Default
	}
	return json.Marshal(theme)
}

// loadYAML charge le fichier YAML et surcharge la config avec ce qui
// est défini. Les sections vides sont ignorées (pas de merge récursif
// partiel : soit la section est entière, soit elle est skipped — sauf
// pour `theme` où on merge champ par champ).
func loadYAML(path string, cfg *Config) error {
	data, err := os.ReadFile(path)
	if err != nil {
		return fmt.Errorf("lecture: %w", err)
	}
	var doc struct {
		Tuning *TuningConfig `yaml:"tuning"`
		Theme  *ThemeConfig  `yaml:"theme"`
	}
	if err := yaml.Unmarshal(data, &doc); err != nil {
		return fmt.Errorf("parsing YAML ligne %d: %w", errLine(err), err)
	}
	if doc.Tuning != nil {
		mergeTuning(&cfg.Tuning, doc.Tuning)
	}
	if doc.Theme != nil {
		mergeTheme(&cfg.Theme, doc.Theme)
	}
	return nil
}

// mergeTuning applique un TuningConfig partiel sur la base. Les valeurs
// non-zero du partiel écrasent la base ; le reste est préservé.
func mergeTuning(base *TuningConfig, partial *TuningConfig) {
	if partial.SessionTTL != 0 {
		base.SessionTTL = partial.SessionTTL
	}
	if partial.BootstrapTimeout != 0 {
		base.BootstrapTimeout = partial.BootstrapTimeout
	}
	if partial.OIDCInitTimeout != 0 {
		base.OIDCInitTimeout = partial.OIDCInitTimeout
	}
	if partial.SSEMaxSubscribers > 0 {
		base.SSEMaxSubscribers = partial.SSEMaxSubscribers
	}
	if partial.SSEChannelBuffer > 0 {
		base.SSEChannelBuffer = partial.SSEChannelBuffer
	}
	if partial.RateLimitIdleTTL != 0 {
		base.RateLimitIdleTTL = partial.RateLimitIdleTTL
	}
	if partial.RateLimitDefaultRPM > 0 {
		base.RateLimitDefaultRPM = partial.RateLimitDefaultRPM
	}
	if partial.SessionCookieName != "" {
		base.SessionCookieName = partial.SessionCookieName
	}
	if partial.SessionTokenBytes > 0 {
		base.SessionTokenBytes = partial.SessionTokenBytes
	}
	if partial.SessionGCInterval != 0 {
		base.SessionGCInterval = partial.SessionGCInterval
	}
}

// mergeTheme applique un ThemeConfig partiel sur la base. Pour `types`
// et `palette`, on merge au niveau de l'entrée : les types absents
// du YAML gardent leur valeur built-in ; les types présents sont
// remplacés entièrement.
func mergeTheme(base *ThemeConfig, partial *ThemeConfig) {
	if partial.Types != nil {
		if base.Types == nil {
			base.Types = map[string]ThemeEntry{}
		}
		for k, v := range partial.Types {
			base.Types[k] = v
		}
	}
	if partial.Palette != nil {
		base.Palette = partial.Palette
	}
	if partial.Default != nil {
		base.Default = partial.Default
	}
}

// errLine extrait le numéro de ligne d'une erreur yaml.v3.
func errLine(err error) int {
	type lineError interface{ Line() int }
	if le, ok := err.(lineError); ok {
		return le.Line()
	}
	return 0
}

// Validate vérifie la cohérence de la config et renvoie une erreur
// fatale si une valeur requise est invalide.
func (c Config) Validate() error {
	if !c.Auth.Disabled {
		if c.Auth.SessionSecret == "" || c.Auth.SessionSecret == "dev-only-insecure-change-me" {
			return fmt.Errorf("SESSION_SECRET doit être changé (valeur par défaut détectée) — définissez SESSION_SECRET avec une chaîne d'au moins 32 caractères, ou passez AUTH_DISABLED=1 pour désactiver l'auth")
		}
		if len(c.Auth.SessionSecret) < 32 {
			return fmt.Errorf("SESSION_SECRET doit faire au moins 32 caractères (actuel: %d)", len(c.Auth.SessionSecret))
		}
	}
	if c.Auth.LocalDisabled && !c.Auth.Disabled && !c.ConfiguredOIDC() {
		return fmt.Errorf("LOCAL_LOGIN_DISABLED=1 sans OIDC configuré : aucun moyen de se connecter")
	}
	if o := c.OpenFGA.OAuth; o.TokenURL != "" && (o.ClientID == "" || (o.Username == "" && o.ClientSecret == "")) {
		return fmt.Errorf("OPENFGA_OIDC_TOKEN_URL exige OPENFGA_OIDC_CLIENT_ID et OPENFGA_OIDC_CLIENT_SECRET (ou OPENFGA_OIDC_USERNAME/PASSWORD)")
	}
	// OPENFGA_URL vide est autorisé : mode "non configuré" — l'UI
	// affiche "OpenFGA non configuré" et les routes renvoient 503.
	return nil
}

// ConfiguredOpenFGA indique si on a au moins l'URL OpenFGA.
func (c Config) ConfiguredOpenFGA() bool {
	return c.OpenFGA.URL != ""
}

// ConfiguredOIDC indique si l'auth OIDC est pleinement configurée.
func (c Config) ConfiguredOIDC() bool {
	return c.Auth.OIDC.IssuerURL != "" &&
		c.Auth.OIDC.ClientID != "" &&
		c.Auth.OIDC.RedirectURL != ""
}

// envOr renvoie la variable d'environnement nommée, ou def si elle est vide.
func envOr(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

// atoi convertit une string en int sans importer strconv (perf et
// lisibilité). Renvoie 0 et une erreur si la string n'est pas valide.
func atoi(s string) (int, error) {
	if s == "" {
		return 0, fmt.Errorf("empty")
	}
	n := 0
	for _, r := range s {
		if r < '0' || r > '9' {
			return 0, fmt.Errorf("not a number: %q", s)
		}
		n = n*10 + int(r-'0')
	}
	return n, nil
}

// loadDotEnv lit un fichier au format KEY=VALUE et exporte chaque entrée
// dans l'environnement si la clé n'est pas déjà définie. L'absence du
// fichier n'est pas une erreur.
func loadDotEnv(path string) {
	f, err := os.Open(path)
	if err != nil {
		return
	}
	defer f.Close()

	scanner := bufio.NewScanner(f)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		key, val, ok := strings.Cut(line, "=")
		if !ok {
			continue
		}
		key = strings.TrimSpace(key)
		val = strings.Trim(strings.TrimSpace(val), `"'`)
		if key == "" {
			continue
		}
		if _, exists := os.LookupEnv(key); !exists {
			_ = os.Setenv(key, val)
		}
	}
}

// splitList découpe une liste séparée par des virgules ou des espaces.
func splitList(v string) []string {
	return strings.FieldsFunc(v, func(r rune) bool {
		return r == ',' || unicode.IsSpace(r)
	})
}

// splitCSV découpe une liste séparée par des virgules (les noms de groupe
// peuvent contenir des espaces : "authentik Admins").
func splitCSV(v string) []string {
	var out []string
	for _, item := range strings.Split(v, ",") {
		if item = strings.TrimSpace(item); item != "" {
			out = append(out, item)
		}
	}
	return out
}
