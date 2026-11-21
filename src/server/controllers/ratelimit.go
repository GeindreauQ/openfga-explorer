// RateLimitMiddleware bloque les requêtes au-delà du quota configuré.
// Renvoie 429 (Too Many Requests) avec un header Retry-After quand la
// requête est refusée.
//
// La clé du bucket est l'IP distante. En production derrière un LB /
// Ingress, le RemoteAddr sera l'IP du proxy ; le middleware lit alors
// X-Forwarded-For uniquement si la connexion vient d'un IP de confiance
// listée dans TRUSTED_PROXY_CIDRS (CSV de CIDRs). Sans cette config,
// on retombe sur RemoteAddr pour éviter qu'un client malveillant forge
// un X-Forwarded-For et contourne le rate limit.
package controllers

import (
	"net"
	"net/http"
	"os"
	"strings"

	"github.com/GeindreauQ/openfga-explorer/internal/ratelimit"
)

// RateLimitMiddleware renvoie un handler qui applique le rate limiter.
// `trustedProxies` est le set pré-parsé des CIDRs de confiance (nil =
// pas de confiance, comportement RemoteAddr uniquement).
func RateLimitMiddleware(rl *ratelimit.Limiter, trustedProxies []*net.IPNet) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			ip := clientIP(r, trustedProxies)
			if !rl.Allow(ip) {
				w.Header().Set("Retry-After", "60")
				writeJSON(w, http.StatusTooManyRequests, map[string]any{
					"error": "trop de tentatives, réessayez dans une minute",
				})
				return
			}
			next.ServeHTTP(w, r)
		})
	}
}

// LoadTrustedProxies parse la variable d'env TRUSTED_PROXY_CIDRS
// (liste CSV de CIDRs) en un slice de *net.IPNet utilisable par
// clientIP. Une CIDR invalide est logguée et ignorée. Retourne nil
// si la variable est vide ou absente.
func LoadTrustedProxies() []*net.IPNet {
	raw := strings.TrimSpace(os.Getenv("TRUSTED_PROXY_CIDRS"))
	if raw == "" {
		return nil
	}
	var out []*net.IPNet
	for _, cidr := range strings.Split(raw, ",") {
		cidr = strings.TrimSpace(cidr)
		if cidr == "" {
			continue
		}
		_, n, err := net.ParseCIDR(cidr)
		if err != nil {
			continue
		}
		out = append(out, n)
	}
	return out
}

// clientIP extrait l'IP du client en respectant X-Forwarded-For si la
// connexion vient d'un proxy de confiance.
func clientIP(r *http.Request, trusted []*net.IPNet) string {
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		host = r.RemoteAddr
	}
	remoteIP := net.ParseIP(host)
	if remoteIP == nil || len(trusted) == 0 {
		return host
	}
	for _, n := range trusted {
		if n.Contains(remoteIP) {
			return firstXForwardedFor(r, host)
		}
	}
	return host
}

// firstXForwardedFor retourne la première IP du header
// X-Forwarded-For, ou host en fallback.
func firstXForwardedFor(r *http.Request, host string) string {
	v := strings.TrimSpace(r.Header.Get("X-Forwarded-For"))
	if v == "" {
		return host
	}
	// Format : "client, proxy1, proxy2"
	if i := strings.Index(v, ","); i >= 0 {
		v = v[:i]
	}
	v = strings.TrimSpace(v)
	if ip := net.ParseIP(v); ip != nil {
		return v
	}
	return host
}
