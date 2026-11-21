// Panneau d'état de connexion OpenFGA + sélecteur de store. La
// configuration réelle (URL/Store/Token) est gérée côté serveur ; ce
// module se contente de refléter /api/health et de piloter le
// dropdown de stores.

import { $ } from './lib/dom.js';
import { getHealth, listStores } from './lib/api.js';

// État de connexion connu, partagé avec le reste de l'app.
export const connection = {
  configured: false,
  storeId: '',
  storeName: '',
  openfgaUrl: '',
  // Liste des stores disponibles (renvoyés par GET /api/stores).
  // Chaque entrée : {id, name, active}.
  stores: [],
};

let configOpen = false;

/** Affiche/masque le panneau latéral d'état de connexion. */
export function toggleConfig() {
  configOpen = !configOpen;
  $('config-panel').classList.toggle('open', configOpen);
  $('btn-toggle-config')?.setAttribute('aria-expanded', String(configOpen));
}

/**
 * Interroge le backend pour connaître l'état de la connexion OpenFGA,
 * la liste des stores et le store actif, puis met à jour le dropdown
 * et le panneau latéral.
 */
export async function refreshConnection() {
  let health;
  try {
    health = await getHealth();
  } catch {
    health = { configured: false, storeId: '', storeName: '', openfgaUrl: '' };
  }

  connection.configured = !!health.configured;
  connection.storeId = health.storeId || '';
  connection.storeName = health.storeName || '';
  connection.openfgaUrl = health.openfgaUrl || '';

  // Liste des stores (uniquement si OpenFGA est configuré).
  if (connection.configured) {
    try {
      connection.stores = await listStores();
    } catch {
      connection.stores = [];
    }
  } else {
    connection.stores = [];
  }

  renderIndicator();
  renderStoreSelect();
  renderPanel();
  // Notifier les listeners (notamment la home dashboard) que la
  // connexion a été rafraîchie. Les listeners peuvent alors mettre à
  // jour leurs stats (compteur de stores, etc.).
  document.dispatchEvent(new CustomEvent('connection-refreshed', { detail: { connection } }));
  return connection;
}

// Pastille de statut (ok / off) + label court dans l'en-tête.
// Exportée pour être ré-appelée depuis changeStore() (main.js)
// après une sélection via le dropdown.
export function renderIndicator() {
  const label = $('store-label');
  const ind = $('btn-toggle-config');
  if (!ind || !label) return;
  const dot = $('conn-dot') || ind.querySelector('.status-dot');
  if (connection.configured && connection.storeId) {
    if (dot) dot.className = 'status-dot ok';
    label.textContent = 'OpenFGA';
  } else if (connection.configured) {
    if (dot) dot.className = 'status-dot warn';
    label.textContent = 'Sélectionner un store';
  } else {
    if (dot) dot.className = 'status-dot off';
    label.textContent = 'OpenFGA non configuré';
  }
}

// Peuple le <select id="store-select"> avec la liste des stores.
// L'option correspondant au store actif est présélectionnée. On
// mémorise la sélection courante pour ne pas flicker si l'utilisateur
// est en train de choisir. L'option "Aucun Store Sélectionné" (value="")
// est toujours présente en tête de liste : elle permet à l'utilisateur
// de désélectionner explicitement le store actif (l'UI affiche alors
// un état "aucun store sélectionné").
function renderStoreSelect() {
  const sel = $('store-select');
  if (!sel) return;
  const current = sel.value;
  sel.innerHTML = '';
  // Première option : "Aucun Store Sélectionné" (toujours présente).
  const noneOpt = document.createElement('option');
  noneOpt.value = '';
  noneOpt.textContent = '— Aucun Store Sélectionné —';
  sel.appendChild(noneOpt);
  if (connection.stores.length === 0) {
    // On a déjà ajouté l'option "Aucun" ; on désactive le select si
    // OpenFGA n'est pas configuré.
    sel.disabled = !connection.configured;
    return;
  }
  sel.disabled = false;
  for (const s of connection.stores) {
    const opt = document.createElement('option');
    opt.value = s.id;
    opt.textContent = s.name || s.id;
    if (s.id === connection.storeId) opt.selected = true;
    sel.appendChild(opt);
  }
  // Si la valeur actuelle n'est plus dans la liste (store supprimé côté
  // OpenFGA), on garde la sélection pour que l'UI reflète l'état.
  if (current && !connection.stores.some(s => s.id === current) && current !== '') {
    sel.value = current;
  }
}

// Panneau latéral détaillé.
function renderPanel() {
  const status = $('conn-status');
  const url = $('conn-url');
  const store = $('conn-store');
  const stores = $('conn-stores');

  if (connection.configured) {
    status.innerHTML = '<span class="status-dot ok"></span><span>Connecté à OpenFGA</span>';
    url.textContent = connection.openfgaUrl || '—';
    store.textContent = connection.storeId
      ? (connection.storeName
          ? `${connection.storeName} (${connection.storeId})`
          : connection.storeId)
      : '—';
    stores.textContent = connection.stores.length > 0
      ? connection.stores.map(s => s.name || s.id).join(', ')
      : 'aucun store sur cette instance';
  } else {
    status.innerHTML = '<span class="status-dot off"></span><span>OpenFGA non configuré</span>';
    url.textContent = connection.openfgaUrl || '—';
    store.textContent = '—';
    stores.textContent = '—';
  }

  // Le bouton "Charger les tuples" a été retiré du panneau ; les tuples
  // sont chargés automatiquement par main.js (boot, switch de store, etc.).
}
