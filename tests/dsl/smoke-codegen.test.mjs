// tests/dsl/smoke-codegen.test.mjs — Générateurs de code client.
//
// Les sorties ont été vérifiées contre un vrai OpenFGA (tsc strict + exécution,
// go vet + exécution, Python openfga-sdk + ruff, bash) ; ces tests figent ce
// qui les rend correctes : types directs lus dans les métadonnées du
// modèle, appels conformes aux SDK, identifiants valides, exemple cohérent.

import { describe, it, expect } from 'vitest';
import { filenameFor, generateCode, listLanguages } from '../../src/web/js/lib/codegen/index.js';
import { buildSpec } from '../../src/web/js/lib/codegen/spec.js';

// Format brut d'OpenFGA : `this` est vide, les types directs sont dans
// metadata.relations[rel].directly_related_user_types.
const MODEL = {
  id: '01MODEL',
  schema_version: '1.1',
  type_definitions: [
    { type: 'user', relations: {} },
    {
      type: 'org-unit',
      relations: { member: { this: {} } },
      metadata: { relations: { member: { directly_related_user_types: [{ type: 'user' }] } } },
    },
    {
      type: 'none',
      relations: { owner: { this: {} } },
      metadata: { relations: { owner: { directly_related_user_types: [{ type: 'user', wildcard: {} }] } } },
    },
    {
      type: 'document',
      relations: {
        viewer: { this: {} },
        editor: { union: { child: [{ this: {} }, { computedUserset: { relation: 'viewer' } }] } },
        parent: { this: {} },
        can_read: {
          union: {
            child: [
              { computedUserset: { relation: 'viewer' } },
              { tupleToUserset: { tupleset: { relation: 'parent' }, computedUserset: { relation: 'member' } } },
            ],
          },
        },
      },
      metadata: {
        relations: {
          viewer: { directly_related_user_types: [{ type: 'user' }, { type: 'org-unit', relation: 'member' }] },
          editor: { directly_related_user_types: [{ type: 'user' }] },
          parent: { directly_related_user_types: [{ type: 'org-unit' }] },
        },
      },
    },
  ],
};
const CTX = { storeId: '01STORE', storeName: 'docs', modelId: '01MODEL', apiUrl: 'http://openfga:8080' };

describe('codegen', () => {
  it('lists the 4 supported languages and their files', () => {
    expect(listLanguages()).toEqual(['typescript', 'go', 'python', 'curl']);
    expect(listLanguages().map(filenameFor)).toEqual(['authz.ts', 'authz.go', 'authz.py', 'openfga.sh']);
    expect(() => generateCode(MODEL, 'cobol')).toThrow(/non supporté/i);
  });

  it('reads direct types from the model metadata and describes relations as DSL', () => {
    const doc = buildSpec(MODEL).types.find(t => t.name === 'document');
    const rel = name => doc.relations.find(r => r.name === name);
    expect(rel('viewer')).toMatchObject({ assignable: true, subjects: ['user', 'org-unit#member'] });
    expect(rel('editor').summary).toBe('[user] or viewer');
    expect(rel('can_read')).toMatchObject({ assignable: false, summary: 'viewer or member from parent' });
  });

  it('writes an assignable tuple then checks a can_* permission in the example', () => {
    expect(buildSpec(MODEL).example).toEqual({
      user: 'user:alice', userType: 'user', writeRelation: 'viewer', checkRelation: 'can_read',
      type: 'document', object: 'document:demo',
    });
  });

  it('TypeScript: SDK calls, store defaults, relations typed per object type', () => {
    const out = generateCode(MODEL, 'typescript', CTX);
    expect(out).toContain('this.fga.check({ user, relation, object })');
    expect(out).toContain('user_filters: [{ type: userType }]');
    expect(out).not.toContain('.execute()');
    expect(out).toContain('storeId: process.env.FGA_STORE_ID ?? "01STORE"');
    expect(out).toContain('authorizationModelId: process.env.FGA_MODEL_ID ?? "01MODEL"');
    expect(out).toContain('"org-unit": [');
    expect(out).toContain('relation: RelationOf<T>, object: ObjectRef<T>');
  });

  it('Go: fluent SDK calls, valid identifiers, gofmt-aligned constants', () => {
    const out = generateCode(MODEL, 'go', CTX);
    expect(out).toContain('a.FGA.Check(ctx).Body(client.ClientCheckRequest{');
    expect(out).toContain('openfga.FgaObject{Type: objectType, Id: id}');
    expect(out).toContain('\tTypeOrgUnit  = "org-unit"');
    expect(out).toMatch(/\tDocumentCanRead = "can_read" \/\/ viewer or member from parent/);
    expect(out).toContain('env("FGA_STORE_ID", "01STORE")');
  });

  it('Python: request objects, no reserved class names', () => {
    const out = generateCode(MODEL, 'python', CTX);
    expect(out).toContain('await self.fga.check(ClientCheckRequest(user=user, relation=relation, object=obj))');
    expect(out).toContain('from openfga_sdk.client.models.list_users_request import ClientListUsersRequest');
    expect(out).toContain('class OrgUnit:');
    expect(out).toContain('class None_:');
    expect(out).not.toMatch(/^class None:/m);
    expect(out).toContain('await authz.grant("user:alice", Document.VIEWER, obj)');
  });

  it('curl: runnable script with commands, model id and error bodies', () => {
    const out = generateCode(MODEL, 'curl', CTX);
    expect(out.startsWith('#!/usr/bin/env bash\n')).toBe(true);
    expect(out).toContain('set -euo pipefail');
    expect(out).toContain('FGA_STORE_ID="${FGA_STORE_ID:-01STORE}"');
    expect(out).toContain('--fail-with-body');
    for (const cmd of ['check)', 'grant)', 'revoke)', 'list-objects)', 'list-users)', 'read)']) {
      expect(out).toContain(`  ${cmd}`);
    }
  });
});
