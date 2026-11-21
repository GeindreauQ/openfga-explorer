// lib/color-scheme.js — Thème clair / sombre. La préférence (system,
// light, dark) est gardée dans localStorage ; le thème résolu est posé
// sur <html data-theme>. Le script en tête de index.html fait la même
// résolution avant le premier rendu, pour éviter un flash.

const KEY = 'openfga-explorer.theme';
// Absent hors navigateur (tests unitaires Node) : thème clair.
const media = typeof window !== 'undefined' && window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;

export function preference() {
  try { return globalThis.localStorage?.getItem(KEY) || 'system'; } catch { return 'system'; }
}

export function setPreference(value) {
  try { localStorage.setItem(KEY, value); } catch { /* stockage indisponible : thème non mémorisé */ }
  apply();
}

export function resolvedTheme() {
  const p = preference();
  return p === 'system' ? (media?.matches ? 'dark' : 'light') : p;
}

export const isDark = () => resolvedTheme() === 'dark';

/** Applique le thème ; émet `theme-changed` quand il change (graphes à redessiner). */
export function apply() {
  const theme = resolvedTheme();
  if (document.documentElement.dataset.theme === theme) return;
  document.documentElement.dataset.theme = theme;
  document.dispatchEvent(new CustomEvent('theme-changed', { detail: { theme } }));
}

media?.addEventListener('change', apply);

/** Valeur résolue d'un token CSS (pour Cytoscape, qui ne lit pas var()). */
export function token(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}
