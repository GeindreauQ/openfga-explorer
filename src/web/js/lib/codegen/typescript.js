// lib/codegen/typescript.js — Client TypeScript (@openfga/sdk) typé par le
// modèle : un relation n'est acceptée que sur son type d'objet
// (check(user, 'can_read', 'namespace:x') compile, 'namespace:x' avec une
// relation d'un autre type non).

import { headerLines, str } from './spec.js';

const IDENT = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const key = name => (IDENT.test(name) ? name : str(name));

export function generateTypeScript(spec) {
  const lines = [
    ...headerLines(spec, '//', '@openfga/sdk ^0.9 (npm install @openfga/sdk)'),
    '',
    "import { CredentialsMethod, OpenFgaClient } from '@openfga/sdk';",
    '',
    '/** Relations du modèle, par type d\'objet. */',
    'export const Relations = {',
  ];
  for (const t of spec.types) {
    if (!t.relations.length) {
      lines.push(`  ${key(t.name)}: [],`);
      continue;
    }
    lines.push(`  ${key(t.name)}: [`);
    for (const r of t.relations) {
      const doc = r.summary;
      lines.push(`    ${str(r.name)}, // ${doc}`);
    }
    lines.push('  ],');
  }
  lines.push(
    '} as const;',
    '',
    'export type ObjectType = keyof typeof Relations;',
    'export type RelationOf<T extends ObjectType> = (typeof Relations)[T][number];',
    '/** Identifiant OpenFGA "type:id" d\'un objet du modèle. */',
    'export type ObjectRef<T extends ObjectType = ObjectType> = `${T}:${string}`;',
    '',
    '/** ref("namespace", "billing") → "namespace:billing", typé. */',
    'export function ref<T extends ObjectType>(type: T, id: string): ObjectRef<T> {',
    '  return `${type}:${id}`;',
    '}',
    '',
    '/** Client configuré par les variables d\'environnement. */',
    'export function createClient(): OpenFgaClient {',
    '  const token = process.env.FGA_API_TOKEN;',
    '  return new OpenFgaClient({',
    `    apiUrl: process.env.FGA_API_URL ?? ${str(spec.apiUrl)},`,
    `    storeId: process.env.FGA_STORE_ID ?? ${str(spec.storeId)},`,
    `    authorizationModelId: process.env.FGA_MODEL_ID${spec.modelId ? ` ?? ${str(spec.modelId)}` : ''},`,
    '    credentials: token ? { method: CredentialsMethod.ApiToken, config: { token } } : undefined,',
    '  });',
    '}',
    '',
    'export class Authz {',
    '  constructor(readonly fga: OpenFgaClient = createClient()) {}',
    '',
    '  /** user a-t-il relation sur object ? */',
    '  async check<T extends ObjectType>(user: string, relation: RelationOf<T>, object: ObjectRef<T>): Promise<boolean> {',
    '    const { allowed } = await this.fga.check({ user, relation, object });',
    '    return allowed ?? false;',
    '  }',
    '',
    '  /** Écrit le tuple (user, relation, object). */',
    '  async grant<T extends ObjectType>(user: string, relation: RelationOf<T>, object: ObjectRef<T>): Promise<void> {',
    '    await this.fga.write({ writes: [{ user, relation, object }] });',
    '  }',
    '',
    '  /** Supprime le tuple (user, relation, object). */',
    '  async revoke<T extends ObjectType>(user: string, relation: RelationOf<T>, object: ObjectRef<T>): Promise<void> {',
    '    await this.fga.write({ deletes: [{ user, relation, object }] });',
    '  }',
    '',
    '  /** Objets de type type sur lesquels user a relation. */',
    '  async listObjects<T extends ObjectType>(user: string, relation: RelationOf<T>, type: T): Promise<ObjectRef<T>[]> {',
    '    const { objects } = await this.fga.listObjects({ user, relation, type });',
    '    return objects as ObjectRef<T>[];',
    '  }',
    '',
    '  /** Sujets de type userType qui ont relation sur object ("type:id", "type:*" ou "type:id#rel"). */',
    '  async listUsers<T extends ObjectType>(object: ObjectRef<T>, relation: RelationOf<T>, userType: ObjectType): Promise<string[]> {',
    "    const [type, id] = object.split(/:(.*)/s);",
    '    const { users } = await this.fga.listUsers({ object: { type, id }, relation, user_filters: [{ type: userType }] });',
    '    return users.map((u) => {',
    '      if (u.object) return `${u.object.type}:${u.object.id}`;',
    '      if (u.userset) return `${u.userset.type}:${u.userset.id}#${u.userset.relation}`;',
    '      return `${u.wildcard?.type}:*`;',
    '    });',
    '  }',
    '}',
  );

  const ex = spec.example;
  if (ex) {
    lines.push(
      '',
      '// Exemple :',
      '//   const authz = new Authz();',
      `//   await authz.grant(${str(ex.user)}, ${str(ex.writeRelation)}, ${str(ex.object)});`,
      `//   await authz.check(${str(ex.user)}, ${str(ex.checkRelation)}, ${str(ex.object)});`,
      `//   await authz.listObjects(${str(ex.user)}, ${str(ex.checkRelation)}, ${str(ex.type)});`,
      `//   await authz.listUsers(${str(ex.object)}, ${str(ex.checkRelation)}, ${str(ex.userType)});`,
    );
  }
  return lines.join('\n') + '\n';
}
