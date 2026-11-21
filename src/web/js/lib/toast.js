// Notification éphémère en bas de l'écran.

import { $ } from './dom.js';

let timer = null;

/**
 * Affiche un message temporaire.
 * @param {string} msg     Texte à afficher.
 * @param {boolean} isErr  true pour un style d'erreur.
 */
export function toast(msg, isErr = false) {
  const el = $('toast');
  el.textContent = msg;
  el.style.background = isErr ? 'var(--danger)' : 'var(--text-primary)';
  el.style.color = 'var(--bg-primary)';
  el.classList.add('show');
  clearTimeout(timer);
  timer = setTimeout(() => el.classList.remove('show'), 3000);
}
