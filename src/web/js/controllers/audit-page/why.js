// controllers/audit-page/why.js — Affichage du chemin de résolution
// (le "Pourquoi ?") partagé entre les 3 modes (Check, Reverse, Forward).
//
// Aucun import interne audit-page : ce module est pur HTML+fetch, ce
// qui évite les cycles avec forms.js / run.js.

import { $, escapeHtml } from '../../lib/dom.js';
import { auditExpand } from '../../lib/api.js';

/**
 * Rend la section "Pourquoi ?" associée à un Check. L'expand est
 * optionnel (peut être null si l'appel a échoué) : dans ce cas on
 * affiche un placeholder neutre pour ne pas faire croire à un
 * silence. body peut être null si l'expand a planté.
 */
export function renderWhySection(body, { user, relation, object }) {
  if (!body) {
    return `<section class="audit-why-section">
      <h4 class="audit-why-title"><i class="ti ti-help" aria-hidden="true"></i> Pourquoi ?</h4>
      <p class="audit-empty">Chemin de résolution indisponible (erreur API).</p>
    </section>`;
  }
  return `<section class="audit-why-section">
    <h4 class="audit-why-title"><i class="ti ti-help" aria-hidden="true"></i> Pourquoi ?</h4>
    ${renderWhyTree(body)}
  </section>`;
}

/**
 * Rend uniquement l'arbre de tuples (sans le verdict). body peut
 * être null si l'expand a planté — renderWhySection gère ce cas.
 *
 * Le backend renvoie les tuples dans l'ordre DFS inverse :
 *   - tuples[0]            = tuple de propagation (racine : celui
 *                            qui satisfait la requête)
 *   - tuples[n-1]          = tuple source (fait brut dans le store)
 * On les affiche dans l'ordre "logique" du raisonnement : source en
 * haut, propagation en bas. L'indentation suit le même mouvement :
 * top à gauche, profondeur grandissante vers le bas.
 */
export function renderWhyTree(body) {
  const tuples = body.tuples || [];
  if (!body.resolved || tuples.length === 0) {
    return `<p class="audit-empty">Aucun chemin de résolution trouvé dans les tuples du store. La requête a peut-être échoué hors du modèle, ou aucun tuple ne lie le sujet à l'objet.</p>`;
  }
  const lines = ['<ul class="audit-tree">'];
  // On parcourt à l'envers (n-1 → 0) pour mettre la source en haut.
  const order = tuples.map((_, i) => tuples.length - 1 - i);
  order.forEach((idx, visualIndex) => {
    const t = tuples[idx];
    const isSource = idx === tuples.length - 1;
    const isTarget = idx === 0;
    const role = isSource ? 'source' : (isTarget ? 'target' : 'middle');
    lines.push(`<li class="audit-tree-leaf audit-tree-${role} audit-depth-${Math.min(visualIndex, 8)}">
      <span class="audit-tree-subject">${escapeHtml(t.user)}</span>
      <span class="audit-tree-arrow">→</span>
      <span class="audit-tree-rel">${escapeHtml(t.relation)}</span>
      <span class="audit-tree-arrow">→</span>
      <span class="audit-tree-object">${escapeHtml(t.object)}</span>
    </li>`);
  });
  lines.push('</ul>');
  // Petite légende pour comprendre la lecture du chemin.
  const legend = `
    <div class="audit-why-legend">
      <span class="audit-tree-leaf audit-tree-source"><span class="audit-tree-subject">alice</span> <span class="audit-tree-arrow">→</span> <span class="audit-tree-rel">assignee</span> <span class="audit-tree-arrow">→</span> <span class="audit-tree-object">role:foo</span></span>
      <span class="hint">fait dans le store (source)</span>
      <span class="audit-tree-leaf audit-tree-target"><span class="audit-tree-subject">role:foo#assignee</span> <span class="audit-tree-arrow">→</span> <span class="audit-tree-rel">relation</span> <span class="audit-tree-arrow">→</span> <span class="audit-tree-object">objet</span></span>
      <span class="hint">propagation jusqu'à la requête</span>
    </div>`;
  lines.push(legend);
  lines.push(`<p class="hint">${tuples.length} tuple${tuples.length > 1 ? 's' : ''} dans le chemin de résolution — lu de haut en bas.</p>`);
  return lines.join('');
}

/**
 * Fetch /api/audit/expand et rend l'arbre de tuples dans un
 * conteneur donné. Utilisé par le handler délégué sur #audit-results
 * (boutons "Pourquoi ?" par item de Reverse/Forward).
 */
export async function fetchAndRenderWhy(container, { user, relation, object }) {
  container.innerHTML = '<div class="audit-why-loading"><div class="audit-spinner" aria-hidden="true"></div></div>';
  try {
    const body = await auditExpand({ user, relation, object });
    container.innerHTML = renderWhyTree(body);
  } catch (e) {
    container.innerHTML = `<p class="audit-error">${escapeHtml(e.message)}</p>`;
  }
}