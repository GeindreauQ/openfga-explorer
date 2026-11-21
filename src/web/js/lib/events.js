// lib/events.js — Client SSE (Server-Sent Events) pour le temps-réel.
//
// Quand un autre client (ou le curl d'un script CI) modifie le store
// actif via /api/tuples ou /api/dsl/apply, le backend publie un
// event sur /api/events. Ce module s'abonne et notifie les listeners
// enregistrés. Pattern d'API calqué sur EventTarget (addEventListener /
// dispatchEvent) pour rester proche des APIs natives.
//
// Events supportés (cf. controllers/events.go) :
//   - "ready"       : envoyé immédiatement à l'ouverture de la SSE
//                     (utile pour les tests E2E qui doivent attendre
//                     que le flux soit prêt)
//   - "tuples.write": un ou plusieurs tuples ont été écrits/supprimés
//   - "dsl.apply"   : un nouveau authorization model a été appliqué
//
// Fallback gracieux : si le navigateur ne supporte pas EventSource
// (rare), le module reste inactif sans crash. L'utilisateur devra
// recharger manuellement après une modification externe.

const _listeners = new Map(); // type -> Array<callback>

/** Ajoute un listener. Retourne une fonction de désabonnement. */
export function addEventListener(type, callback) {
  if (!_listeners.has(type)) _listeners.set(type, []);
  _listeners.get(type).push(callback);
  return () => {
    const arr = _listeners.get(type);
    if (!arr) return;
    const idx = arr.indexOf(callback);
    if (idx >= 0) arr.splice(idx, 1);
  };
}

/** Déclenche tous les listeners d'un type donné. */
function dispatch(type, data) {
  const arr = _listeners.get(type);
  if (!arr) return;
  for (const cb of arr.slice()) {
    try { cb(data); } catch (e) { console.error('events listener:', e); }
  }
}

let _es = null;
let _connected = false;

/** Initialise l'abonnement SSE. À appeler une seule fois au boot. */
export function initEvents() {
  if (_es) return; // déjà connecté
  if (typeof EventSource === 'undefined') {
    console.warn('SSE: EventSource non supporté par ce navigateur, fallback manuel.');
    return;
  }
  _es = new EventSource('/api/events');

  // Event "ready" immédiat (envoyé par le serveur à l'ouverture).
  // Les tests E2E s'en servent pour savoir quand le flux est prêt.
  _es.addEventListener('ready', () => {
    _connected = true;
    dispatch('ready', {});
  });

  // Mutation de tuples → on refetch + toast.
  _es.addEventListener('tuples.write', (e) => {
    try {
      const evt = JSON.parse(e.data);
      dispatch('tuples.write', evt);
    } catch (err) {
      console.error('SSE tuples.write parse:', err);
    }
  });

  // Nouveau authorization model → on refetch le DSL + toast.
  _es.addEventListener('dsl.apply', (e) => {
    try {
      const evt = JSON.parse(e.data);
      dispatch('dsl.apply', evt);
    } catch (err) {
      console.error('SSE dsl.apply parse:', err);
    }
  });

  _es.onerror = () => {
    // EventSource reconnecte automatiquement. On note juste l'état
    // pour que les listeners puissent afficher un badge "hors-ligne"
    // s'ils le souhaitent.
    _connected = false;
    dispatch('disconnect', {});
  };
  _es.onopen = () => {
    _connected = true;
    dispatch('connect', {});
  };
}

/** Indique si le flux SSE est connecté (utile pour un badge UI). */
export function isEventsConnected() {
  return _connected;
}

/** Ferme la connexion SSE. Utilisé au logout. */
export function closeEvents() {
  if (_es) {
    _es.close();
    _es = null;
    _connected = false;
  }
}