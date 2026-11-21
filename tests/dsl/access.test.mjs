// tests/dsl/access.test.mjs — « Qui a accès, et pourquoi » sur le modèle
// Kubernetes du webhook.

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import { parseDSL } from '../../src/web/js/models/dsl.js';
import {
  accessRelations, assignableRelations, linkRelations, impliedRelations, grantingRelations,
  subjectFilters, explainAccess, groupTuples, groupTypeFor, knownObjects, objectTypes,
} from '../../src/web/js/lib/access.js';

const model = parseDSL(fs.readFileSync(new URL('./fixtures/kubernetes.fga', import.meta.url), 'utf8'));

const tuples = [
  { user: 'project:billing', relation: 'project', object: 'namespace:billing' },
  { user: 'cluster:prod', relation: 'cluster', object: 'namespace:billing' },
  { user: 'group:billing-team#member', relation: 'editor', object: 'project:billing' },
  { user: 'user:bob', relation: 'viewer', object: 'cluster:prod' },
  { user: 'user:carol', relation: 'admin', object: 'namespace:billing' },
];

describe('model reading', () => {
  it('separates link relations from access relations', () => {
    expect([...linkRelations(model, 'namespace')].sort()).toEqual(['cluster', 'project']);
    expect(accessRelations(model, 'namespace')).not.toContain('project');
    expect(assignableRelations(model, 'namespace')).toEqual(['admin', 'editor', 'viewer']);
    expect(objectTypes(model)).toEqual(['group', 'cluster', 'project', 'namespace']);
  });

  it('follows computed relations', () => {
    const fromEditor = impliedRelations(model, 'namespace', 'editor');
    for (const r of ['editor', 'viewer', 'can_read', 'can_read_secrets', 'can_write', 'can_exec']) expect(fromEditor.has(r)).toBe(true);
    expect(fromEditor.has('can_admin')).toBe(false);
    expect([...grantingRelations(model, 'namespace', 'can_read')].sort()).toEqual(['admin', 'can_read', 'editor', 'viewer']);
  });

  it('lists subjects and the group type', () => {
    expect(subjectFilters(model, 'namespace')).toEqual([{ type: 'user' }, { type: 'group', relation: 'member' }]);
    expect(groupTypeFor(model)).toEqual({ type: 'group', relation: 'member' });
    expect(groupTuples(model, 'user:alice', ['billing-team', 'authentik Admins'])).toEqual([
      { user: 'user:alice', relation: 'member', object: 'group:billing-team' },
      { user: 'user:alice', relation: 'member', object: 'group:authentik_Admins' },
    ]);
    expect(knownObjects(tuples, 'namespace')).toEqual(['namespace:billing']);
  });
});

describe('explainAccess', () => {
  it('direct tuple', () => {
    const [p] = explainAccess({ model, tuples, subject: 'user:carol', object: 'namespace:billing', relation: 'can_write' });
    expect(p.tuple).toEqual(tuples[4]);
    expect(p.via).toEqual([]);
  });

  it('through the project, with a contextual group', () => {
    const all = [...tuples, ...groupTuples(model, 'user:alice', ['billing-team'])];
    const paths = explainAccess({ model, tuples: all, subject: 'user:alice', object: 'namespace:billing', relation: 'can_exec' });
    expect(paths).toHaveLength(1);
    expect(paths[0].tuple).toEqual(tuples[2]);
    expect(paths[0].via).toEqual([tuples[0]]);
    expect(paths[0].membership).toEqual({ user: 'user:alice', relation: 'member', object: 'group:billing-team' });
  });

  it('through the cluster, and no path when not granted', () => {
    const [p] = explainAccess({ model, tuples, subject: 'user:bob', object: 'namespace:billing', relation: 'can_read' });
    expect(p.via).toEqual([tuples[1]]);
    expect(explainAccess({ model, tuples, subject: 'user:bob', object: 'namespace:billing', relation: 'can_write' })).toEqual([]);
  });
});
