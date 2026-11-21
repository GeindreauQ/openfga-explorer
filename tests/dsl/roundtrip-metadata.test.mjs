// tests/dsl/roundtrip-metadata.test.mjs — Modèle renvoyé par OpenFGA →
// AST interne → DSL : les types directs d'un `this` imbriqué dans une
// union (stockés dans metadata) ne doivent pas être perdus.

import { describe, it, expect } from 'vitest';
import { parseJSONModel, serializeDSL, checkDSL } from '../../src/web/js/models/dsl.js';

const MODEL = {
  schema_version: '1.1',
  type_definitions: [
    { type: 'user' },
    {
      type: 'repo',
      relations: {
        owner: { this: {} },
        admin: { union: { child: [{ this: {} }, { computedUserset: { relation: 'owner' } }] } },
      },
      metadata: {
        relations: {
          owner: { directly_related_user_types: [{ type: 'user' }] },
          admin: { directly_related_user_types: [{ type: 'user' }] },
        },
      },
    },
  ],
};

describe('JSON model round-trip', () => {
  it('keeps direct types of a this nested in a union', () => {
    const parsed = parseJSONModel(JSON.stringify(MODEL));
    const admin = parsed.types.find(t => t.name === 'repo').relations.find(r => r.name === 'admin');
    expect(admin.directTypes.map(d => d.type)).toEqual(['user']);

    const dsl = serializeDSL(parsed);
    expect(dsl).toContain('define admin: [user] or owner');
    expect(checkDSL(dsl).ok).toBe(true);
  });
});

describe('rawModelToDSL (historique, rollback)', () => {
  it('serializes every type of a raw OpenFGA model', async () => {
    const { rawModelToDSL } = await import('../../src/web/js/models/dsl.js');
    const dsl = rawModelToDSL(MODEL);
    expect(dsl).toContain('type repo');
    expect(dsl).toContain('define owner: [user]');
    expect(dsl).toContain('define admin: [user] or owner');
  });
});
