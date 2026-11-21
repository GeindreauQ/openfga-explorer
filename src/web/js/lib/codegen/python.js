// lib/codegen/python.js — Client Python asynchrone (openfga-sdk) : une
// classe de constantes par type, et une surcouche Authz.

import { headerLines, pascal, str, uniqueIdents, upperSnake } from './spec.js';

// Noms de classes réservés en Python (pascal("none") === "None").
const RESERVED = new Set(['None', 'True', 'False', 'Authz', 'ObjectType']);

export function generatePython(spec) {
  const classes = uniqueIdents(spec.types.map(t => t.name), pascal, RESERVED);
  const lines = [
    '"""',
    ...headerLines(spec, '', 'openfga-sdk >= 0.9 (pip install openfga-sdk)').map(l => l.trim()),
    '"""',
    '',
    'import os',
    '',
    'from openfga_sdk import ClientConfiguration, OpenFgaClient',
    'from openfga_sdk.client.models import (',
    '    ClientCheckRequest,',
    '    ClientListObjectsRequest,',
    '    ClientTuple,',
    '    ClientWriteRequest,',
    ')',
    'from openfga_sdk.client.models.list_users_request import ClientListUsersRequest',
    'from openfga_sdk.credentials import CredentialConfiguration, Credentials',
    'from openfga_sdk.models import FgaObject, UserTypeFilter',
    '',
    '',
    'class ObjectType:',
    '    """Types d\'objets du modèle."""',
    '',
  ];
  const typeConsts = uniqueIdents(spec.types.map(t => t.name), upperSnake);
  for (const t of spec.types) lines.push(`    ${typeConsts.get(t.name)} = ${str(t.name)}`);

  for (const t of spec.types) {
    if (!t.relations.length) continue;
    const rels = uniqueIdents(t.relations.map(r => r.name), upperSnake);
    lines.push('', '', `class ${classes.get(t.name)}:`, `    """Relations du type ${t.name}."""`, '');
    for (const r of t.relations) {
      const doc = r.summary;
      lines.push(`    ${rels.get(r.name)} = ${str(r.name)}  # ${doc}`);
    }
  }

  lines.push(
    '',
    '',
    'def ref(object_type: str, object_id: str) -> str:',
    '    """Identifiant OpenFGA "type:id"."""',
    '    return f"{object_type}:{object_id}"',
    '',
    '',
    'def configuration() -> ClientConfiguration:',
    '    """Configuration du SDK par les variables d\'environnement."""',
    '    token = os.environ.get("FGA_API_TOKEN")',
    '    return ClientConfiguration(',
    `        api_url=os.environ.get("FGA_API_URL", ${str(spec.apiUrl)}),`,
    `        store_id=os.environ.get("FGA_STORE_ID", ${str(spec.storeId)}),`,
    `        authorization_model_id=os.environ.get("FGA_MODEL_ID", ${str(spec.modelId)}) or None,`,
    '        credentials=Credentials(',
    '            method="api_token",',
    '            configuration=CredentialConfiguration(api_token=token),',
    '        )',
    '        if token',
    '        else None,',
    '    )',
    '',
    '',
    'class Authz:',
    '    """Appels courants ; à utiliser dans `async with OpenFgaClient(configuration()) as fga`."""',
    '',
    '    def __init__(self, fga: OpenFgaClient):',
    '        self.fga = fga',
    '',
    '    async def check(self, user: str, relation: str, obj: str) -> bool:',
    '        """user a-t-il relation sur obj ?"""',
    '        resp = await self.fga.check(ClientCheckRequest(user=user, relation=relation, object=obj))',
    '        return bool(resp.allowed)',
    '',
    '    async def grant(self, user: str, relation: str, obj: str) -> None:',
    '        """Écrit le tuple (user, relation, obj)."""',
    '        await self.fga.write(ClientWriteRequest(writes=[ClientTuple(user=user, relation=relation, object=obj)]))',
    '',
    '    async def revoke(self, user: str, relation: str, obj: str) -> None:',
    '        """Supprime le tuple (user, relation, obj)."""',
    '        await self.fga.write(ClientWriteRequest(deletes=[ClientTuple(user=user, relation=relation, object=obj)]))',
    '',
    '    async def list_objects(self, user: str, relation: str, object_type: str) -> list[str]:',
    '        """Objets de type object_type sur lesquels user a relation."""',
    '        resp = await self.fga.list_objects(ClientListObjectsRequest(user=user, relation=relation, type=object_type))',
    '        return list(resp.objects)',
    '',
    '    async def list_users(self, obj: str, relation: str, user_type: str) -> list[str]:',
    '        """Sujets de type user_type qui ont relation sur obj ("type:id", "type:*" ou "type:id#rel")."""',
    '        object_type, object_id = obj.split(":", 1)',
    '        resp = await self.fga.list_users(',
    '            ClientListUsersRequest(',
    '                object=FgaObject(type=object_type, id=object_id),',
    '                relation=relation,',
    '                user_filters=[UserTypeFilter(type=user_type)],',
    '            )',
    '        )',
    '        users = []',
    '        for u in resp.users:',
    '            if u.object:',
    '                users.append(f"{u.object.type}:{u.object.id}")',
    '            elif u.userset:',
    '                users.append(f"{u.userset.type}:{u.userset.id}#{u.userset.relation}")',
    '            elif u.wildcard:',
    '                users.append(f"{u.wildcard.type}:*")',
    '        return users',
  );

  const ex = spec.example;
  if (ex) {
    const t = spec.types.find(x => x.name === ex.type);
    const rels = uniqueIdents(t.relations.map(r => r.name), upperSnake);
    const cls = classes.get(ex.type);
    const object = `ref(ObjectType.${typeConsts.get(ex.type)}, "demo")`;
    lines.push(
      '',
      '',
      'async def main() -> None:',
      '    async with OpenFgaClient(configuration()) as fga:',
      '        authz = Authz(fga)',
      `        obj = ${object}`,
      `        await authz.grant(${str(ex.user)}, ${cls}.${rels.get(ex.writeRelation)}, obj)`,
      `        print(await authz.check(${str(ex.user)}, ${cls}.${rels.get(ex.checkRelation)}, obj))`,
      `        print(await authz.list_objects(${str(ex.user)}, ${cls}.${rels.get(ex.checkRelation)}, ObjectType.${typeConsts.get(ex.type)}))`,
      `        print(await authz.list_users(obj, ${cls}.${rels.get(ex.checkRelation)}, ${str(ex.userType)}))`,
      '',
      '',
      'if __name__ == "__main__":',
      '    import asyncio',
      '',
      '    asyncio.run(main())',
    );
  }
  return lines.join('\n') + '\n';
}
