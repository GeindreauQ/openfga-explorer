// controllers/events.go — Broker d'événements temps-réel via SSE.
//
// Quand le store actif est modifié (écriture de tuples, application
// d'un nouveau authorization model), on publie un événement sur un
// broker interne. Les clients HTTP abonnés via GET /api/events
// (text/event-stream) reçoivent l'événement au format SSE.
//
// Routes :
//   GET /api/events  → SSE endpoint, renvoie les events du store actif
//                      au fur et à mesure (text/event-stream).
//
// Hooks : broker.Publish() est appelé depuis tuples.go::Write (avec
// type="tuples.write", count=N) et depuis dsl.go::Apply (avec
// type="dsl.apply", model_id=…, types=N).

package controllers

import (
	"encoding/json"
	"fmt"
	"net/http"
	"sync"

	"github.com/GeindreauQ/openfga-explorer/internal/apperr"
)

// Event est la payload envoyée sur le bus. Tous les champs sont
// optionnels sauf `Type` et `StoreID` (filtrage côté client : on
// ignore les events des autres stores).
type Event struct {
	Type    string `json:"type"`               // "tuples.write" | "dsl.apply"
	StoreID string `json:"store_id"`           // store concerné
	Count   int    `json:"count,omitempty"`    // nb tuples écrits/supprimés
	ModelID string `json:"model_id,omitempty"` // nouvel authorization model id
	Types   int    `json:"types,omitempty"`    // nb types du modèle
	Source  string `json:"source,omitempty"`   // "manual" | "import" | "preview"
}

// EventBroker est un fan-out simple en mémoire. Chaque abonné reçoit
// tous les événements via son channel ; le filtrage par StoreID est
// fait côté client.
//
// Capacité : maxSubs subscribers simultanés (au-delà, Subscribe
// retourne une erreur). Largement suffisant pour un outil d'admin
// mono-équipe — pas de besoin de pub/sub distribué.
type EventBroker struct {
	mu       sync.RWMutex
	subs     map[chan Event]struct{}
	maxSubs  int
	chBuf    int
	stopOnce sync.Once
	stopCh   chan struct{}
}

// NewEventBroker crée un broker prêt à l'emploi.
//
// `maxSubs` plafonne le nombre de clients SSE simultanés (au-delà,
// Subscribe renvoie 503). `chBuf` est la taille du buffer par
// subscriber — les events destinés à un client lent sont droppés
// silencieusement plutôt que de bloquer le publisher.
func NewEventBroker(maxSubs, chBuf int) *EventBroker {
	if maxSubs <= 0 {
		maxSubs = 100
	}
	if chBuf <= 0 {
		chBuf = 16
	}
	return &EventBroker{
		subs:    make(map[chan Event]struct{}),
		maxSubs: maxSubs,
		chBuf:   chBuf,
		stopCh:  make(chan struct{}),
	}
}

// Subscribe retourne un channel d'événements et une fonction
// d'unsubscriber. Le channel est buffered (chBuf) pour absorber les
// pics d'activité (plusieurs Writes rapides vers OpenFGA).
func (b *EventBroker) Subscribe() (chan Event, func(), error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	if len(b.subs) >= b.maxSubs {
		return nil, nil, apperr.New(http.StatusServiceUnavailable,
			fmt.Sprintf("trop d'abonnés SSE (%d max)", b.maxSubs))
	}
	ch := make(chan Event, b.chBuf)
	b.subs[ch] = struct{}{}
	unsub := func() {
		b.mu.Lock()
		defer b.mu.Unlock()
		if _, ok := b.subs[ch]; ok {
			delete(b.subs, ch)
			close(ch)
		}
	}
	return ch, unsub, nil
}

// Publish envoie un événement à tous les abonnés (non-bloquant :
// si un abonné est lent, l'event est silencieusement droppé pour
// ce subscriber).
func (b *EventBroker) Publish(evt Event) {
	b.mu.RLock()
	defer b.mu.RUnlock()
	for ch := range b.subs {
		select {
		case ch <- evt:
		default:
			// Subscriber lent : on drop pour ne pas bloquer le
			// publisher. Le client rattrapera au prochain event.
		}
	}
}

// Stream est le handler HTTP pour GET /api/events. Il ouvre un
// connexion SSE et stream les events du broker jusqu'à ce que le
// client se déconnecte (r.Context().Done).
//
// Headers importants :
//   - Content-Type: text/event-stream (protocole SSE)
//   - Cache-Control: no-cache (interdit la mise en cache des events)
//   - X-Accel-Buffering: no (désactive le buffering de nginx si
//     l'app est servie derrière un reverse-proxy)
//
// Format d'un event SSE :
//
//	event: tuples.write
//	data: {"type":"tuples.write","store_id":"01H...","count":5}
//	\n  (ligne vide = délimiteur d'event)
func (b *EventBroker) Stream(w http.ResponseWriter, r *http.Request) {
	flusher, ok := w.(http.Flusher)
	if !ok {
		writeError(w, apperr.New(http.StatusInternalServerError,
			"streaming non supporté par ce serveur HTTP"))
		return
	}
	ch, unsub, err := b.Subscribe()
	if err != nil {
		writeError(w, err)
		return
	}
	defer unsub()

	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	w.Header().Set("X-Accel-Buffering", "no")
	w.WriteHeader(http.StatusOK)

	// Event "ready" immédiat pour confirmer au client que la
	// connexion est établie. Utile pour les E2E tests qui
	// doivent attendre que le flux soit prêt avant de trigger
	// une mutation côté backend.
	fmt.Fprintf(w, "event: ready\ndata: {}\n\n")
	flusher.Flush()

	// Boucle principale : on forward chaque event reçu sur le
	// channel au format SSE. On sort si le client se déconnecte.
	for {
		select {
		case <-r.Context().Done():
			return
		case <-b.stopCh:
			return
		case evt, ok := <-ch:
			if !ok {
				return
			}
			data, err := json.Marshal(evt)
			if err != nil {
				continue // event mal formé, on skip (ne devrait pas arriver)
			}
			fmt.Fprintf(w, "event: %s\ndata: %s\n\n", evt.Type, data)
			flusher.Flush()
		}
	}
}

// Close ferme tous les abonnés. À appeler au shutdown du serveur
// pour éviter les goroutines orphelines.
func (b *EventBroker) Close() {
	b.stopOnce.Do(func() {
		close(b.stopCh)
		b.mu.Lock()
		defer b.mu.Unlock()
		for ch := range b.subs {
			close(ch)
		}
		b.subs = nil
	})
}
