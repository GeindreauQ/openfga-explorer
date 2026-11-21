// tests/dsl/smoke-dsl-graph.test.mjs — Smoke test du split de dsl-graph.js.
//
// Vérifie que le graphe de dépendances du nouveau module
// `views/dsl-graph/index.js` se charge sans erreur, que les exports
// publics sont présents (init, setData, getSelectedNode, getPinnedEdge,
// destroy) et que les helpers purs de state.js sont corrects.

import { describe, it, expect } from 'vitest';
import * as dslGraph from '../../src/web/js/views/dsl-graph/index.js';
import { state, dedupeEdges, classifyRelation, escapeHtml } from '../../src/web/js/views/dsl-graph/state.js';

describe('dsl-graph split', () => {
  it('exposes the public API surface', () => {
    for (const fn of ['init', 'setData', 'getSelectedNode', 'getPinnedEdge', 'destroy']) {
      expect(typeof dslGraph[fn], `dslGraph.${fn} should be a function`).toBe('function');
    }
  });

  it('state.js exports the singleton and pure helpers', () => {
    expect(state).toBeDefined();
    expect(state.nodes).toEqual([]);
    expect(typeof dedupeEdges).toBe('function');
    expect(typeof classifyRelation).toBe('function');
    expect(typeof escapeHtml).toBe('function');
  });

  it('escapeHtml escapes the dangerous characters', () => {
    // L'implémentation historique n'échappe QUE <, >, & (pas les
    // guillemets). On vérifie le contrat tel qu'il est utilisé dans
    // les innerHTML du graphe DSL — pas une régression.
    expect(escapeHtml('<script>alert("x")</script>'))
      .toBe('&lt;script&gt;alert("x")&lt;/script&gt;');
    expect(escapeHtml('a & b > c')).toBe('a &amp; b &gt; c');
    expect(escapeHtml(42)).toBe('42');
  });

  it('dedupeEdges merges edges by (from, to) and accumulates relations', () => {
    const raw = [
      { from: 'a', to: 'b', label: 'rel1', type: 'direct', style: 'solid' },
      { from: 'a', to: 'b', label: 'rel2', type: 'direct', style: 'solid' },
      { from: 'a', to: 'c', label: 'rel3', type: 'direct', style: 'solid' },
    ];
    const out = dedupeEdges(raw);
    expect(out).toHaveLength(2);
    const ab = out.find(e => e.from === 'a' && e.to === 'b');
    expect(ab.relations.sort()).toEqual(['rel1', 'rel2']);
  });

  it('dedupeEdges sorts the relation list for stable tooltips', () => {
    const raw = [
      { from: 'a', to: 'b', label: 'zeta', type: 'direct', style: 'solid' },
      { from: 'a', to: 'b', label: 'alpha', type: 'direct', style: 'solid' },
    ];
    const out = dedupeEdges(raw);
    expect(out[0].relations).toEqual(['alpha', 'zeta']);
  });

  it('classifyRelation recognizes union / intersection / computed / wildcard', () => {
    expect(classifyRelation('r: a or b').label).toBe('Union (or)');
    expect(classifyRelation('r: a and b').label).toBe('Intersection (and)');
    expect(classifyRelation('r: #member').label).toBe('Computed userset');
    expect(classifyRelation('r: viewer from parent').label).toBe('Tuple-to-userset');
    expect(classifyRelation('r: a but not b').label).toBe('Difference');
    expect(classifyRelation('r: *').label).toBe('Wildcard');
    expect(classifyRelation('r: this').label).toBe('Direct this');
    // 'plain' (sans `:`) → l'expression entière est 'plain' ; elle
    // matche /^\w+$/ et est classée 'Direct this' (cas par défaut
    // historique).
    expect(classifyRelation('plain').label).toBe('Direct this');
  });
});