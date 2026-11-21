// tests/dsl/k8s.test.mjs — La traduction kubectl → Check du simulateur doit
// rester identique à celle du webhook openfga-k8s-authz
// (internal/authz/translate_test.go, mêmes cas).

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import { translate, kubectlCommand, isKubernetesModel, groupID } from '../../src/web/js/lib/k8s.js';
import { parseDSL } from '../../src/web/js/models/dsl.js';

const req = (verb, namespace, resource, subresource = '') => {
  let group = '';
  if (resource === 'deployments') group = 'apps';
  if (resource === 'rolebindings' || resource === 'clusterroles') group = 'rbac.authorization.k8s.io';
  return {
    user: 'alice', groups: ['viewers'], cluster: 'prod', verb, namespace, resource, subresource, group,
    name: resource === 'namespaces' ? namespace : '',
  };
};

describe('translate (cas du webhook)', () => {
  const cases = [
    ['read in a namespace', req('list', 'billing', 'pods'), 'can_read', 'namespace:billing'],
    ['read across namespaces', req('list', '', 'pods'), 'can_read', 'cluster:prod'],
    ['logs are read', req('get', 'billing', 'pods', 'log'), 'can_read', 'namespace:billing'],
    ['secrets', req('get', 'billing', 'secrets'), 'can_read_secrets', 'namespace:billing'],
    ['write', req('patch', 'billing', 'deployments'), 'can_write', 'namespace:billing'],
    ['scale is a write', req('update', 'billing', 'deployments', 'scale'), 'can_write', 'namespace:billing'],
    ['exec', req('create', 'billing', 'pods', 'exec'), 'can_exec', 'namespace:billing'],
    ['port-forward', req('create', 'billing', 'pods', 'portforward'), 'can_exec', 'namespace:billing'],
    ['service proxy', req('get', 'billing', 'services', 'proxy'), 'can_exec', 'namespace:billing'],
    ['service account token', req('create', 'billing', 'serviceaccounts', 'token'), 'can_admin', 'namespace:billing'],
    ['rbac write', req('create', 'billing', 'rolebindings'), 'can_admin', 'namespace:billing'],
    ['rbac bind', req('bind', 'billing', 'clusterroles'), 'can_admin', 'namespace:billing'],
    ['rbac read', req('list', 'billing', 'rolebindings'), 'can_read', 'namespace:billing'],
    ['cluster-wide write', req('delete', '', 'nodes'), 'can_admin', 'cluster:prod'],
    ['kubelet proxy', req('get', '', 'nodes', 'proxy'), 'can_admin', 'cluster:prod'],
    ['one namespace', req('get', 'billing', 'namespaces'), 'can_read', 'namespace:billing'],
    ['namespace list', req('list', '', 'namespaces'), 'can_read', 'cluster:prod'],
    ['namespace delete', req('delete', 'billing', 'namespaces'), 'can_admin', 'cluster:prod'],
  ];
  for (const [name, r, relation, object] of cases) {
    it(name, () => {
      const { check, reason } = translate(r);
      expect(reason).toBeUndefined();
      expect([check.relation, check.object]).toEqual([relation, object]);
    });
  }

  it('contextual tuples: cluster link and groups, blanks replaced', () => {
    const r = { ...req('get', 'billing', 'pods'), groups: ['authentik Admins', 'viewers', 'bad#group'] };
    expect(translate(r).check.contextual).toEqual([
      { user: 'cluster:prod', relation: 'cluster', object: 'namespace:billing' },
      { user: 'user:alice', relation: 'member', object: 'group:authentik_Admins' },
      { user: 'user:alice', relation: 'member', object: 'group:viewers' },
    ]);
    expect(translate(req('list', '', 'pods')).check.contextual).toEqual([
      { user: 'user:alice', relation: 'member', object: 'group:viewers' },
    ]);
  });

  it('no opinion: non-resource, impersonate, invalid user', () => {
    expect(translate({ ...req('get', '', ''), resource: '' }).reason).toBeTruthy();
    expect(translate({ user: 'alice', verb: 'impersonate', resource: 'users' }).reason).toBeTruthy();
    expect(translate({ ...req('get', 'billing', 'pods'), user: 'a b' }).reason).toBeTruthy();
    expect(groupID('bad#group')).toBe('');
  });

  it('kubectl command with OIDC prefixes', () => {
    const r = { ...req('create', 'billing', 'pods', 'exec'), groups: ['authentik Admins'] };
    expect(kubectlCommand(r)).toBe("kubectl auth can-i create pods --subresource=exec -n billing --as=oidc:alice --as-group='oidc:authentik Admins'");
  });

  it('recognizes the webhook model', () => {
    const model = parseDSL(fs.readFileSync(new URL('./fixtures/kubernetes.fga', import.meta.url), 'utf8'));
    expect(isKubernetesModel(model)).toBe(true);
    expect(isKubernetesModel({ types: [{ name: 'user', relations: [] }] })).toBe(false);
  });
});
