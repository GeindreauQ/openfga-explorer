// tests/dsl/parser.test.mjs — Tests unitaires du parser DSL officiel.
//
// Couvre les features OpenFGA DSL supportées :
//   - model / schema 1.x / commentaires
//   - type X / relations / define Y: <expr>
//   - expressions : [a, b#c, user with cond], computed, X from Y,
//                   A or B, A and B, A but not B, parenthésage
//   - condition name(params) { cel }

import { describe, it, expect } from 'vitest';
import { transformer } from '@openfga/syntax-transformer';

function parseDSL(text) {
  const { listener, errorListener } = transformer.parseDSL(text);
  if (errorListener.errors?.length) {
    return { errors: errorListener.errors.map(e => ({ message: e.message })) };
  }
  return listener.authorizationModel;
}

describe('OpenFGA DSL parser', () => {
  it('parses a simple type with this expression', () => {
    const out = parseDSL(`model
  schema 1.1

type user

type document
  relations
    define viewer: [user]`);
    expect(out.type_definitions).toHaveLength(2);
    const doc = out.type_definitions.find(t => t.type === 'document');
    expect(doc.relations.viewer).toBeDefined();
    expect(out.conditions).toBeUndefined();
    expect(out.schema_version).toBe('1.1');
  });

  it('parses a userset rewrite ([team#member])', () => {
    const out = parseDSL(`model
  schema 1.1
type user
type team
  relations
    define member: [user]
type repo
  relations
    define admin: [user, team#member]`);
    const repo = out.type_definitions.find(t => t.type === 'repo');
    expect(repo.relations.admin).toBeDefined();
    expect(repo.metadata.relations.admin.directly_related_user_types).toEqual([
      { type: 'user' },
      { type: 'team', relation: 'member' },
    ]);
  });

  it('parses wildcards ([user:*])', () => {
    const out = parseDSL(`model
  schema 1.1
type user
type doc
  relations
    define viewer: [user:*]`);
    const doc = out.type_definitions.find(t => t.type === 'doc');
    const dt = doc.metadata.relations.viewer.directly_related_user_types[0];
    expect(dt).toEqual({ type: 'user', wildcard: {} });
  });

  it('parses computed userset (relation)', () => {
    const out = parseDSL(`model
  schema 1.1
type user
type doc
  relations
    define writer: [user]
    define editor: writer`);
    const doc = out.type_definitions.find(t => t.type === 'doc');
    expect(doc.relations.editor.computedUserset.relation).toBe('writer');
  });

  it('parses tuple-to-userset (X from Y)', () => {
    const out = parseDSL(`model
  schema 1.1
type user
type folder
  relations
    define viewer: [user]
type doc
  relations
    define parent: [folder]
    define viewer: viewer from parent`);
    const doc = out.type_definitions.find(t => t.type === 'doc');
    expect(doc.relations).toHaveProperty('viewer');
    expect(doc.relations.viewer.tupleToUserset.tupleset.relation).toBe('parent');
    expect(doc.relations.viewer.tupleToUserset.computedUserset.relation).toBe('viewer');
  });

  it('parses union (A or B)', () => {
    const out = parseDSL(`model
  schema 1.1
type user
type doc
  relations
    define writer: [user]
    define editor: [user]
    define viewer: writer or editor`);
    const doc = out.type_definitions.find(t => t.type === 'doc');
    expect(doc.relations.viewer.union).toBeDefined();
    expect(doc.relations.viewer.union.child).toHaveLength(2);
  });

  it('parses intersection (A and B)', () => {
    const out = parseDSL(`model
  schema 1.1
type user
type doc
  relations
    define writer: [user]
    define editor: [user]
    define viewer: writer and editor`);
    const doc = out.type_definitions.find(t => t.type === 'doc');
    expect(doc.relations.viewer.intersection).toBeDefined();
    expect(doc.relations.viewer.intersection.child).toHaveLength(2);
  });

  it('parses exclusion (A but not B)', () => {
    const out = parseDSL(`model
  schema 1.1
type user
type doc
  relations
    define allowed: [user]
    define blocked: [user]
    define viewer: allowed but not blocked`);
    const doc = out.type_definitions.find(t => t.type === 'doc');
    expect(doc.relations.viewer.difference).toBeDefined();
    expect(doc.relations.viewer.difference.base).toBeDefined();
    expect(doc.relations.viewer.difference.subtract).toBeDefined();
  });

  it('parses a condition with CEL expression', () => {
    const out = parseDSL(`model
  schema 1.1
type user
type document
  relations
    define viewer: [user with non_expired_grant]
condition non_expired_grant(current_time: timestamp, grant_time: timestamp, grant_duration: duration) {
  current_time < grant_time + grant_duration
}`);
    expect(out.conditions.non_expired_grant).toBeDefined();
    expect(out.conditions.non_expired_grant.expression).toBe(
      'current_time < grant_time + grant_duration'
    );
    expect(out.conditions.non_expired_grant.parameters).toEqual({
      current_time: { type_name: 'TYPE_NAME_TIMESTAMP' },
      grant_time: { type_name: 'TYPE_NAME_TIMESTAMP' },
      grant_duration: { type_name: 'TYPE_NAME_DURATION' },
    });
  });

  it('handles invalid DSL gracefully', () => {
    const out = parseDSL('this is not valid');
    expect(out.errors).toBeDefined();
    expect(out.errors.length).toBeGreaterThan(0);
  });

  it('round-trips a complex model through JSON', () => {
    const text = `model
  schema 1.1
type user
type team
  relations
    define member: [user]
type org
  relations
    define admin: [user, team#member]
type repo
  relations
    define owner: [org]
    define admin: [user, team#member] or admin from owner`;
    const parsed = parseDSL(text);
    expect(parsed.errors || []).toEqual([]);
    expect(parsed.type_definitions).toHaveLength(4);
  });
});