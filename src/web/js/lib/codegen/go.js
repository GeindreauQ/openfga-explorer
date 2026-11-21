// lib/codegen/go.js — Client Go (github.com/openfga/go-sdk) : constantes des
// types et relations du modèle, et une surcouche Authz.

import { headerLines, pascal, str, uniqueIdents } from './spec.js';

// Bloc const aligné comme le ferait gofmt : [nom, valeur, commentaire].
function constBlock(rows) {
  const nameWidth = Math.max(...rows.map(r => [...r[0]].length));
  const valueWidth = Math.max(...rows.map(r => [...r[1]].length));
  return rows.map(([name, value, comment]) => {
    const line = `\t${name.padEnd(nameWidth)} = ${comment ? value.padEnd(valueWidth) : value}`;
    return comment ? `${line} // ${comment}` : line;
  });
}

export function generateGo(spec) {
  const typeIdents = uniqueIdents(spec.types.map(t => t.name), pascal);
  const lines = [
    ...headerLines(spec, '//', 'github.com/openfga/go-sdk'),
    '',
    'package authz',
    '',
    'import (',
    '\t"context"',
    '\t"fmt"',
    '\t"os"',
    '\t"strings"',
    '',
    '\topenfga "github.com/openfga/go-sdk"',
    '\t"github.com/openfga/go-sdk/client"',
    '\t"github.com/openfga/go-sdk/credentials"',
    ')',
    '',
    '// Types d\'objets du modèle.',
    'const (',
  ];
  lines.push(...constBlock(spec.types.map(t => [`Type${typeIdents.get(t.name)}`, str(t.name)])));
  lines.push(')', '');

  for (const t of spec.types) {
    if (!t.relations.length) continue;
    const prefix = typeIdents.get(t.name);
    const relIdents = uniqueIdents(t.relations.map(r => r.name), pascal);
    lines.push(`// Relations du type ${t.name}.`, 'const (');
    lines.push(...constBlock(t.relations.map(r => [`${prefix}${relIdents.get(r.name)}`, str(r.name), r.summary])));
    lines.push(')', '');
  }

  lines.push(
    '// Ref construit l\'identifiant OpenFGA "type:id".',
    'func Ref(objectType, id string) string { return objectType + ":" + id }',
    '',
    '// NewClient configure le SDK par les variables d\'environnement.',
    'func NewClient() (*client.OpenFgaClient, error) {',
    '\tcfg := &client.ClientConfiguration{',
    `\t\tApiUrl:               env("FGA_API_URL", ${str(spec.apiUrl)}),`,
    `\t\tStoreId:              env("FGA_STORE_ID", ${str(spec.storeId)}),`,
    `\t\tAuthorizationModelId: env("FGA_MODEL_ID", ${str(spec.modelId)}),`,
    '\t}',
    '\tif token := os.Getenv("FGA_API_TOKEN"); token != "" {',
    '\t\tcfg.Credentials = &credentials.Credentials{',
    '\t\t\tMethod: credentials.CredentialsMethodApiToken,',
    '\t\t\tConfig: &credentials.Config{ApiToken: token},',
    '\t\t}',
    '\t}',
    '\treturn client.NewSdkClient(cfg)',
    '}',
    '',
    'func env(key, fallback string) string {',
    '\tif v := os.Getenv(key); v != "" {',
    '\t\treturn v',
    '\t}',
    '\treturn fallback',
    '}',
    '',
    '// Authz simplifie les appels courants.',
    'type Authz struct{ FGA *client.OpenFgaClient }',
    '',
    '// Check indique si user a relation sur object.',
    'func (a Authz) Check(ctx context.Context, user, relation, object string) (bool, error) {',
    '\tresp, err := a.FGA.Check(ctx).Body(client.ClientCheckRequest{User: user, Relation: relation, Object: object}).Execute()',
    '\tif err != nil {',
    '\t\treturn false, fmt.Errorf("check %s %s %s: %w", user, relation, object, err)',
    '\t}',
    '\treturn resp.GetAllowed(), nil',
    '}',
    '',
    '// Grant écrit le tuple (user, relation, object).',
    'func (a Authz) Grant(ctx context.Context, user, relation, object string) error {',
    '\t_, err := a.FGA.Write(ctx).Body(client.ClientWriteRequest{',
    '\t\tWrites: []client.ClientTupleKey{{User: user, Relation: relation, Object: object}},',
    '\t}).Execute()',
    '\treturn err',
    '}',
    '',
    '// Revoke supprime le tuple (user, relation, object).',
    'func (a Authz) Revoke(ctx context.Context, user, relation, object string) error {',
    '\t_, err := a.FGA.Write(ctx).Body(client.ClientWriteRequest{',
    '\t\tDeletes: []client.ClientTupleKeyWithoutCondition{{User: user, Relation: relation, Object: object}},',
    '\t}).Execute()',
    '\treturn err',
    '}',
    '',
    '// ListObjects renvoie les objets de type objectType sur lesquels user a relation.',
    'func (a Authz) ListObjects(ctx context.Context, user, relation, objectType string) ([]string, error) {',
    '\tresp, err := a.FGA.ListObjects(ctx).Body(client.ClientListObjectsRequest{User: user, Relation: relation, Type: objectType}).Execute()',
    '\tif err != nil {',
    '\t\treturn nil, err',
    '\t}',
    '\treturn resp.GetObjects(), nil',
    '}',
    '',
    '// ListUsers renvoie les sujets de type userType qui ont relation sur object',
    '// ("type:id", "type:*" ou "type:id#relation").',
    'func (a Authz) ListUsers(ctx context.Context, object, relation, userType string) ([]string, error) {',
    '\tobjectType, id, _ := strings.Cut(object, ":")',
    '\tresp, err := a.FGA.ListUsers(ctx).Body(client.ClientListUsersRequest{',
    '\t\tObject:      openfga.FgaObject{Type: objectType, Id: id},',
    '\t\tRelation:    relation,',
    '\t\tUserFilters: []openfga.UserTypeFilter{{Type: userType}},',
    '\t}).Execute()',
    '\tif err != nil {',
    '\t\treturn nil, err',
    '\t}',
    '\tusers := make([]string, 0, len(resp.GetUsers()))',
    '\tfor _, u := range resp.GetUsers() {',
    '\t\tswitch {',
    '\t\tcase u.Object != nil:',
    '\t\t\tusers = append(users, u.Object.Type+":"+u.Object.Id)',
    '\t\tcase u.Userset != nil:',
    '\t\t\tusers = append(users, u.Userset.Type+":"+u.Userset.Id+"#"+u.Userset.Relation)',
    '\t\tcase u.Wildcard != nil:',
    '\t\t\tusers = append(users, u.Wildcard.Type+":*")',
    '\t\t}',
    '\t}',
    '\treturn users, nil',
    '}',
  );

  const ex = spec.example;
  if (ex) {
    const t = spec.types.find(x => x.name === ex.type);
    const rels = uniqueIdents(t.relations.map(r => r.name), pascal);
    const prefix = typeIdents.get(ex.type);
    const object = `Ref(Type${prefix}, "demo")`;
    lines.push(
      '',
      '// Exemple :',
      '//',
      '//\tfga, err := authz.NewClient()',
      '//\ta := authz.Authz{FGA: fga}',
      `//\terr = a.Grant(ctx, ${str(ex.user)}, authz.${prefix}${rels.get(ex.writeRelation)}, authz.${object})`,
      `//\tok, err := a.Check(ctx, ${str(ex.user)}, authz.${prefix}${rels.get(ex.checkRelation)}, authz.${object})`,
    );
  }
  return lines.join('\n') + '\n';
}
