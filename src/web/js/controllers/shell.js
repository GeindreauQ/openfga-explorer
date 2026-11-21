// controllers/shell.js — Barre latérale : navigation, entrée active,
// choix du thème, ouverture sur mobile.

import { $ } from '../lib/dom.js';
import { preference, setPreference } from '../lib/color-scheme.js';
import { showHome, enterFromHome } from './router.js';
import { logout } from '../lib/api.js';
import { closeEvents } from '../lib/events.js';
import { toast } from '../lib/toast.js';

// Page affichée ← classe posée sur <body> par le routeur.
const PAGE_CLASSES = [
  ['home-shown', 'home'], ['dsl-shown', 'admin_dsl'], ['audit-shown', 'audit'], ['io-shown', 'import_export'],
  ['assertions-shown', 'assertions'], ['access-shown', 'access'],
];

export function currentPage() {
  const cls = document.body.classList;
  for (const [c, page] of PAGE_CLASSES) if (cls.contains(c)) return page;
  return 'manage_tuple';
}

function syncActive() {
  const page = currentPage();
  document.querySelectorAll('.sidebar [data-nav]').forEach(a => {
    if (a.dataset.nav === page) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  });
}

function syncTheme() {
  const p = preference();
  document.querySelectorAll('[data-theme-choice]').forEach(b => {
    const on = b.dataset.themeChoice === p;
    b.setAttribute('aria-checked', String(on));
    b.tabIndex = on ? 0 : -1;
  });
}

function setSidebar(open) {
  document.body.classList.toggle('sidebar-open', open);
  $('btn-sidebar')?.setAttribute('aria-expanded', String(open));
  const scrim = $('sidebar-scrim');
  if (scrim) scrim.hidden = !open;
}

export function wireShell() {
  document.querySelectorAll('.sidebar [data-nav]').forEach(a => a.addEventListener('click', e => {
    // Ctrl/Cmd-clic, clic milieu : nouvel onglet via le href.
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
    e.preventDefault();
    setSidebar(false);
    if (a.dataset.nav === 'home') showHome();
    else enterFromHome(a.dataset.nav);
    $('content')?.focus({ preventScroll: true });
  }));
  new MutationObserver(syncActive).observe(document.body, { attributes: true, attributeFilter: ['class'] });
  syncActive();

  const themes = [...document.querySelectorAll('[data-theme-choice]')];
  themes.forEach((b, i) => {
    b.addEventListener('click', () => { setPreference(b.dataset.themeChoice); syncTheme(); });
    b.addEventListener('keydown', e => {
      if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
      const next = themes[(i + (e.key === 'ArrowRight' ? 1 : themes.length - 1)) % themes.length];
      setPreference(next.dataset.themeChoice); syncTheme(); next.focus();
    });
  });
  syncTheme();

  $('btn-sidebar')?.addEventListener('click', () => setSidebar(!document.body.classList.contains('sidebar-open')));
  $('sidebar-scrim')?.addEventListener('click', () => setSidebar(false));
  document.addEventListener('keydown', onEscape);
  $('btn-logout')?.addEventListener('click', async () => {
    try {
      await logout();
    } catch (e) {
      toast('Déconnexion impossible : ' + e.message, true);
      return;
    }
    closeEvents();
    window.location.assign('/login');
  });
}

/** Échap ferme la fenêtre au premier plan (modale, visite guidée), sinon
 *  la barre latérale ouverte sur mobile. */
function onEscape(e) {
  if (e.key !== 'Escape' || e.defaultPrevented) return;
  const shown = el => !el.hidden && getComputedStyle(el).display !== 'none';
  const top = [...document.querySelectorAll('.modal-backdrop.open, .dsl-tour')]
    .filter(shown).at(-1);
  const close = top?.querySelector('.modal-close, #dsl-tour-close');
  if (close) {
    e.preventDefault();
    close.click();
  } else if (document.body.classList.contains('sidebar-open')) {
    setSidebar(false);
  }
}
