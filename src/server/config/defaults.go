// defaults.go : valeurs par défaut in-code, utilisées quand aucune
// source (env, YAML) ne les a renseignées.
//
// C'est ici que les changements "durs" sont concentrés : déplacer une
// constante d'ici vers le YAML est une ligne.
package config

import "time"

// DefaultTuning renvoie les tuning values par défaut. Ces valeurs
// étaient hardcodées dans `main.go` et les constructors avant
// l'introduction du YAML ; on les a regroupées ici pour visibilité.
func DefaultTuning() TuningConfig {
	return TuningConfig{
		SessionTTL:          8 * time.Hour,
		BootstrapTimeout:    15 * time.Second,
		OIDCInitTimeout:     10 * time.Second,
		SSEMaxSubscribers:   100,
		SSEChannelBuffer:    16,
		RateLimitIdleTTL:    10 * time.Minute,
		RateLimitDefaultRPM: 50,
		SessionCookieName:   "openfga_explorer_session",
		SessionTokenBytes:   32,
		SessionGCInterval:   10 * time.Minute,
	}
}

// DefaultTheme renvoie les valeurs built-in du thème. Le frontend
// frontend reçoit une copie sérialisée de cette map via
// /api/config/theme, ou garde son propre built-in (cf. `lib/theme.js`
// côté JS) si la route n'est pas joignable.
//
// Les clés (user, organization, etc.) sont les types OpenFGA
// "habituels" — un type absent ici tombe sur Default et finit dans la
// Palette (par hash du nom) via la logique de `cfg()`.
func DefaultTheme() ThemeConfig {
	return ThemeConfig{
		Types: map[string]ThemeEntry{
			"user":         {Icon: "ti-user", Bg: "#E6F1FB", Text: "#0C447C", Border: "#85B7EB"},
			"organization": {Icon: "ti-building-community", Bg: "#EFE8F4", Text: "#3F2A6B", Border: "#9F88C2"},
			"team":         {Icon: "ti-users", Bg: "#F0E8E1", Text: "#5A2E0E", Border: "#C99B7A"},
			"document":     {Icon: "ti-file-text", Bg: "#F4F0E5", Text: "#3D3514", Border: "#C2B170"},
			"folder":       {Icon: "ti-folder", Bg: "#E5F4F0", Text: "#0D4A2E", Border: "#6FC79E"},
			"network":      {Icon: "ti-network", Bg: "#E8EEF7", Text: "#1B365C", Border: "#7AA0CD"},
			"plan":         {Icon: "ti-license", Bg: "#FAEEF0", Text: "#6B1F2E", Border: "#D48594"},
			"feature":      {Icon: "ti-star", Bg: "#FFF6E0", Text: "#6B4D00", Border: "#D7B75A"},
			"repo":         {Icon: "ti-brand-git", Bg: "#EAEEF8", Text: "#1B2A52", Border: "#7F94C7"},
		},
		Palette: []ThemeEntry{
			{Icon: "ti-circle", Bg: "#E6F1FB", Text: "#0C447C", Border: "#85B7EB"},
			{Icon: "ti-square", Bg: "#FBEAF0", Text: "#72243E", Border: "#ED93B1"},
			{Icon: "ti-triangle", Bg: "#EEEDFE", Text: "#3C3489", Border: "#AFA9EC"},
			{Icon: "ti-diamond", Bg: "#FAEEDA", Text: "#633806", Border: "#EF9F27"},
			{Icon: "ti-hexagon", Bg: "#EAF3DE", Text: "#27500A", Border: "#97C459"},
			{Icon: "ti-octagon", Bg: "#E1F5EE", Text: "#085041", Border: "#5DCAA5"},
			{Icon: "ti-pentagon", Bg: "#FAECE7", Text: "#712B13", Border: "#F0997B"},
			{Icon: "ti-star", Bg: "#E6F1FB", Text: "#155366", Border: "#7FC2D6"},
		},
		Default: &ThemeEntry{Icon: "ti-circle-dot", Bg: "#F1EFE8", Text: "#444441", Border: "#B4B2A9"},
	}
}
