// controllers/access-page/index.js — Page Accès : onglets « Qui a accès »,
// « Droits d'un sujet », « Simuler kubectl » (modèle du webhook seulement)
// et « Attribuer ».

import { $ } from '../../lib/dom.js';
import { isGraphActive, destroyGraph } from '../../views/graph.js';
import { context, initClusterField, refreshClusterField } from './common.js';
import { renderObjectForm } from './object.js';
import { renderSubjectForm } from './subject.js';
import { renderKubectlForm, setGrantHandler } from './kubectl.js';
import { renderGrantForm } from './grant.js';

const RENDER = { object: renderObjectForm, subject: renderSubjectForm, kubectl: renderKubectlForm, grant: renderGrantForm };
let current = 'object';
let initialized = false;

export async function showAccessPage() {
  document.body.classList.remove('home-shown', 'dsl-shown', 'audit-shown', 'io-shown', 'assertions-shown');
  $('home-dashboard')?.setAttribute('hidden', '');
  for (const id of ['dsl-page', 'audit-page', 'io-page', 'assertions-page']) $(id)?.setAttribute('hidden', '');
  document.body.classList.add('access-shown');
  $('access-page')?.removeAttribute('hidden');
  if (isGraphActive()) destroyGraph();

  if (!initialized) {
    initialized = true;
    initClusterField();
    $('access-tabs')?.addEventListener('click', e => {
      const tab = e.target.closest('[data-access-tab]');
      if (tab) selectTab(tab.dataset.accessTab);
    });
    $('access-tabs')?.addEventListener('keydown', onTabKey);
    $('access-page')?.addEventListener('access-cluster-changed', () => selectTab(current));
    setGrantHandler(prefill => selectTab('grant', prefill));
    // Changement de store ou rechargement des tuples : on repart du formulaire vide.
    for (const ev of ['connection-refreshed', 'store-model-changed']) {
      document.addEventListener(ev, () => {
        if (!$('access-page')?.hasAttribute('hidden')) selectTab(current);
      });
    }
  }
  selectTab(current);
}

/** Ouvre un onglet de la page Accès (raccourcis de l'accueil). */
export function selectAccessTab(name) { selectTab(name); }

function selectTab(name, prefill = {}) {
  const ctx = context();
  refreshClusterField(ctx);
  const kubectlTab = document.querySelector('#access-tabs [data-access-tab="kubectl"]');
  if (kubectlTab) kubectlTab.hidden = !ctx.k8s;
  if (name === 'kubectl' && !ctx.k8s) name = 'object';
  if (name === 'grant' && document.body.classList.contains('read-only')) name = 'object';
  current = name;
  document.querySelectorAll('#access-tabs [data-access-tab]').forEach(t => {
    const on = t.dataset.accessTab === name;
    t.classList.toggle('active', on);
    t.setAttribute('aria-selected', String(on));
    t.tabIndex = on ? 0 : -1;
  });
  const form = $('access-form');
  form.className = `access-form access-form-${name}`;
  if (!ctx.model?.types?.length) {
    form.innerHTML = '';
    $('access-results').innerHTML = '<div class="access-empty"><i class="ti ti-database-off" aria-hidden="true"></i><strong>Aucun modèle</strong><span>Sélectionnez un store qui a un modèle d\'autorisation.</span></div>';
    return;
  }
  RENDER[name](form, prefill);
}

/** Flèches gauche/droite entre onglets (motif ARIA tablist). */
function onTabKey(e) {
  if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
  const tabs = [...document.querySelectorAll('#access-tabs [data-access-tab]')].filter(t => !t.hidden && getComputedStyle(t).display !== 'none');
  const i = tabs.findIndex(t => t.dataset.accessTab === current);
  const next = tabs[(i + (e.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length];
  selectTab(next.dataset.accessTab);
  next.focus();
}
