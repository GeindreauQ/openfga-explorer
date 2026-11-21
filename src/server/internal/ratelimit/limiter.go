// Package ratelimit : token bucket par IP.
//
// Basé sur golang.org/x/time/rate. Suffisant pour un déploiement
// mono-instance. Pour du multi-replicas, il faudrait un store partagé
// (Redis, etc.) — au-delà du scope d'un outil d'admin.
package ratelimit

import (
	"sync"
	"time"

	"golang.org/x/time/rate"
)

// Limiter maintient un token-bucket par IP. Chaque IP a son propre
// bucket créé à la première utilisation et nettoyé après inactivité.
type Limiter struct {
	mu      sync.Mutex
	buckets map[string]*ipBucket
	rate    rate.Limit
	burst   int
	idleTTL time.Duration
	stopGC  chan struct{}
}

type ipBucket struct {
	limiter  *rate.Limiter
	lastSeen time.Time
}

// New crée un rate limiter. `perMinute` est le nombre d'événements
// autorisés par minute par IP (avec burst identique). `idleTTL` est
// la durée après laquelle un bucket inactif est nettoyé par le GC
// (typiquement 10min, surchargeable via la config YAML).
func New(perMinute int, idleTTL time.Duration) *Limiter {
	if perMinute <= 0 {
		perMinute = 5
	}
	if idleTTL <= 0 {
		idleTTL = 10 * time.Minute
	}
	rl := &Limiter{
		buckets: make(map[string]*ipBucket),
		rate:    rate.Limit(float64(perMinute) / 60.0),
		burst:   perMinute,
		idleTTL: idleTTL,
		stopGC:  make(chan struct{}),
	}
	go rl.gcLoop()
	return rl
}

// Allow renvoie true si la requête pour `ip` est autorisée. Incrémente
// le bucket ; les requêtes suivantes sont bloquées jusqu'au refill
// (toutes les 60/perMinute secondes).
func (r *Limiter) Allow(ip string) bool {
	r.mu.Lock()
	b, ok := r.buckets[ip]
	if !ok {
		b = &ipBucket{limiter: rate.NewLimiter(r.rate, r.burst)}
		r.buckets[ip] = b
	}
	b.lastSeen = time.Now()
	r.mu.Unlock()
	return b.limiter.Allow()
}

// Stop arrête la goroutine de garbage collection. À appeler au shutdown.
func (r *Limiter) Stop() {
	close(r.stopGC)
}

func (r *Limiter) gcLoop() {
	ticker := time.NewTicker(r.idleTTL)
	defer ticker.Stop()
	for {
		select {
		case <-r.stopGC:
			return
		case now := <-ticker.C:
			r.mu.Lock()
			for ip, b := range r.buckets {
				if now.Sub(b.lastSeen) > r.idleTTL {
					delete(r.buckets, ip)
				}
			}
			r.mu.Unlock()
		}
	}
}
