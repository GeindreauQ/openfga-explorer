// Fonctions utilitaires sans dépendance.

/** Échappe les caractères HTML sensibles pour une insertion sûre dans le DOM. */
export function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Type d'une référence OpenFGA « type:id » → « type ». */
export function parseType(ref) {
  return ref.split(':')[0] || 'unknown';
}

/** Identifiant d'une référence OpenFGA « type:id » → « id ». */
export function parseId(ref) {
  const [, ...rest] = ref.split(':');
  return rest.join(':') || ref;
}

/** Raccourci pour document.getElementById. */
export function $(id) {
  return document.getElementById(id);
}
