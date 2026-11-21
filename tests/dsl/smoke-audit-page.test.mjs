// tests/dsl/smoke-audit-page.test.mjs — Smoke test du split de
// audit-page.js. Vérifie que les renderers de résultats produisent
// du HTML correct pour les 3 modes (Check, Reverse, Forward) et que
// le panneau "Pourquoi ?" reste fonctionnel.

import { describe, it, expect } from 'vitest';
import {
  renderCheckResult,
  renderUsersResult,
  renderObjectsResult,
} from '../../src/web/js/controllers/audit-page/run.js';
import {
  renderWhySection,
  renderWhyTree,
} from '../../src/web/js/controllers/audit-page/why.js';

describe('audit-page split — result renderers', () => {
  it('renderCheckResult emits ALLOWED verdict card for true', () => {
    const html = renderCheckResult({
      allowed: true,
      tuple: { user: 'user:alice', relation: 'viewer', object: 'doc:1' },
    });
    expect(html).toContain('ALLOWED');
    expect(html).toContain('audit-results-ok');
    expect(html).toContain('user:alice');
    expect(html).toContain('viewer');
    expect(html).toContain('doc:1');
  });

  it('renderCheckResult emits DENIED verdict card for false', () => {
    const html = renderCheckResult({
      allowed: false,
      tuple: { user: 'user:bob', relation: 'editor', object: 'doc:2' },
    });
    expect(html).toContain('DENIED');
    expect(html).toContain('audit-results-warn');
  });

  it('renderUsersResult emits a list with a "Pourquoi ?" button per user', () => {
    const html = renderUsersResult(
      {
        users: [
          { object: { type: 'user', id: 'alice' } },
          { object: { type: 'user', id: 'bob' } },
        ],
        count: 2,
      },
      { object: 'doc:1', relation: 'viewer' }
    );
    expect(html).toContain('2 users trouvés');
    expect(html).toContain('user:alice');
    expect(html).toContain('user:bob');
    // Chaque item doit avoir son bouton "Pourquoi ?" avec les data-*.
    const whyCount = (html.match(/audit-why-btn/g) || []).length;
    expect(whyCount).toBe(2);
    expect(html).toContain('data-why-object="doc:1"');
  });

  it('renderUsersResult shows an empty state when no users', () => {
    const html = renderUsersResult({ users: [], count: 0 }, { object: 'doc:1', relation: 'viewer' });
    expect(html).toContain('Aucun user de ce type');
  });

  it('renderUsersResult handles wildcards and usersets (no Pourquoi button for wildcard)', () => {
    const html = renderUsersResult(
      {
        users: [
          { wildcard: { type: 'user' } },
          { userset: { object: { type: 'group', id: 'g1' }, relation: 'member' } },
        ],
        count: 2,
      },
      { object: 'doc:1', relation: 'viewer' }
    );
    // Le wildcard n'a pas de bouton Pourquoi (pas requêtable).
    const whyCount = (html.match(/audit-why-btn/g) || []).length;
    expect(whyCount).toBe(1);
    expect(html).toContain('wildcard');
    expect(html).toContain('group:g1#member');
  });

  it('renderObjectsResult emits a list with a Pourquoi button per object', () => {
    const html = renderObjectsResult(
      { objects: ['doc:1', 'doc:2'], count: 2 },
      { user: 'user:alice', relation: 'viewer' }
    );
    expect(html).toContain('2 objects trouvés');
    expect(html).toContain('doc:1');
    expect(html).toContain('doc:2');
    expect((html.match(/audit-why-btn/g) || []).length).toBe(2);
    expect(html).toContain('data-why-user="user:alice"');
  });
});

describe('audit-page split — why tree', () => {
  it('renderWhyTree renders a list of leaves with source/target highlighting', () => {
    const body = {
      resolved: true,
      tuples: [
        { user: 'role:admin#member', relation: 'viewer', object: 'doc:1' },
        { user: 'user:alice', relation: 'member', object: 'role:admin' },
      ],
    };
    const html = renderWhyTree(body);
    expect(html).toContain('audit-tree');
    expect(html).toContain('audit-tree-source');
    expect(html).toContain('audit-tree-target');
    expect(html).toContain('user:alice');
    expect(html).toContain('role:admin#member');
  });

  it('renderWhyTree shows an empty state when resolved=false', () => {
    const html = renderWhyTree({ resolved: false, tuples: [] });
    expect(html).toContain('Aucun chemin de résolution');
  });

  it('renderWhySection emits a placeholder when body is null', () => {
    const html = renderWhySection(null, { user: 'u', relation: 'r', object: 'o' });
    expect(html).toContain('audit-why-section');
    expect(html).toContain('Chemin de résolution indisponible');
  });

  it('renderWhySection embeds the tree when body is provided', () => {
    const html = renderWhySection(
      { resolved: true, tuples: [
        { user: 'a', relation: 'r', object: 'o' },
      ] },
      { user: 'a', relation: 'r', object: 'o' }
    );
    expect(html).toContain('audit-why-section');
    expect(html).toContain('audit-tree-source');
  });
});