# HTTP API Reference

Every public HTTP endpoint exposed by the OpenFGA Explorer backend.

> **Conventions**
> - All non-`/api/*` and non-`/auth/*` paths serve the SPA (`/`, `/dashboard`, `/dsl`, …).
> - Auth is enforced unless `AUTH_DISABLED=1`.
> - JSON in, JSON out. Errors are `{"error": "human message"}` with the appropriate
>   HTTP status code.
> - The backend proxies requests to OpenFGA on `OPENFGA_URL`. The active store is the
>   one currently selected via [`POST /api/stores/select`](#post-apistoresselect).
> - Mutating routes (`POST`, `PUT`, `PATCH`, `DELETE`) require the `X-CSRF-Token`
>   header (issued by [`GET /api/me`](#get-apime)).

---

## Health

Three endpoints with different scopes:

### `GET /api/health/live`

Minimal liveness probe. Always returns `200 {"status":"ok"}` while the process
runs. No I/O. **This is what Kubernetes liveness probes should use** — a failing
OpenFGA must NOT cause the Pod to be restarted.

### `GET /api/health`

Public readiness probe with no sensitive fields. Returns `200` if the explorer
is up; `503` if OpenFGA is configured and unreachable.

**Response 200**:

```json
{ "status": "ok", "openfga": "up" }
```

**Response 200** (OpenFGA not configured):

```json
{ "status": "ok", "openfga": "skipped" }
```

**Response 503** (OpenFGA down):

```json
{ "status": "degraded", "openfga": "down" }
```

### `GET /api/health/detail`

Auth-gated. Returns the full payload (including `storeId`, `openfgaUrl`,
`authDisabled`, and `openfgaError` on failure) for monitoring tools that have a
session cookie.

**Response 200**:

```json
{
  "status": "ok",
  "configured": true,
  "storeId": "01HABCDEFG…",
  "openfgaUrl": "http://openfga:8080",
  "authDisabled": false,
  "openfga": "up"
}
```

**Response 503**:

```json
{
  "status": "degraded",
  "configured": true,
  "storeId": "01HABCDEFG…",
  "openfgaUrl": "http://openfga:8080",
  "authDisabled": false,
  "openfga": "down",
  "openfgaError": "connection refused"
}
```

---

## Session

### `GET /api/me`

Returns the authenticated user and the CSRF token linked to the session. The
frontend caches this token and attaches it as `X-CSRF-Token` on every mutating
request (see [`csrf` middleware](#csrf)).

Route is **not** behind `auth.Middleware`: when no cookie is present, the response
is `{authenticated: false, user: null}` without erroring.

**Response 200** (authenticated):

```json
{
  "authenticated": true,
  "user": {
    "sub": "local:admin",
    "email": "admin@local",
    "email_verified": true,
    "name": "Default Administrator",
    "preferred_username": "admin",
    "roles": [],
    "groups": [],
    "source": "local",
    "role": "admin"
  },
  "csrf_token": "abc123…",
  "store_id": "01HABCDEFG…"
}
```

**Response 200** (anonymous):

```json
{ "authenticated": false, "user": null }
```

---

## Stores

### `GET /api/stores`

Lists all stores on the configured OpenFGA instance. The active store is marked.

**Response 200**:

```json
{
  "stores": [
    { "id": "01HABCDEFG…", "name": "production", "active": true },
    { "id": "01HIJKLMNO…", "name": "staging",    "active": false }
  ]
}
```

### `POST /api/stores/select`

Switch the active store at runtime. Validates that `storeId` exists.

The choice belongs to the browser: it is kept in the session, or in the
`openfga_explorer_store` cookie when authentication is disabled. Until a browser
picks one, it uses the first store found at startup. An empty `storeId`
clears the choice.

**Request**:

```json
{ "storeId": "01HABCDEFG…" }
```

Pass `storeId: ""` to deselect (the UI will show "Aucun store sélectionné").

**Response 200**:

```json
{ "storeId": "01HABCDEFG…", "storeName": "production" }
```

**Response 404**: `{"error": "store introuvable: <id>"}`

---

## Theme

### `GET /api/config/theme`

Returns the active theme (merged from defaults + `config.yaml`).
**Unauthenticated** (theme is cosmetic, not sensitive).

**Response 200**:

```json
{
  "types": {
    "user": { "icon": "ti-user", "bg": "#E6F1FB", "text": "#0C447C", "border": "#85B7EB" },
    "organization": { "icon": "ti-building-community", "bg": "#EFE8F4", "text": "#3F2A6B", "border": "#9F88C2" }
  },
  "palette": [ { "icon": "ti-circle", "bg": "#E6F1FB", "text": "#0C447C", "border": "#85B7EB" } ],
  "default": { "icon": "ti-circle-dot", "bg": "#F1EFE8", "text": "#444441", "border": "#B4B2A9" }
}
```

---

## Tuples

### `GET /api/tuples`

Reads every tuple in the active store (paginated server-side, single response).
For large stores this materialises everything in memory — see
[Known limitations](README.md#known-limitations).

**Response 200**:

```json
{
  "tuples": [
    { "user": "user:alice", "relation": "viewer", "object": "document:readme" },
    { "user": "team:eng#member", "relation": "editor", "object": "document:design" }
  ]
}
```

### `POST /api/tuples`

Write tuples in one batch.

**Request**:

```json
{
  "tuples":  [ { "user": "user:alice", "relation": "viewer", "object": "document:readme" } ]
}
```

**Response 200**:

```json
{ "written": 1 }
```

### `DELETE /api/tuples`

Delete tuples in one batch.

**Request**:

```json
{
  "tuples":  [ { "user": "user:bob", "relation": "viewer", "object": "document:readme" } ]
}
```

**Response 200**:

```json
{ "deleted": 1 }
```

---

## Authorization model

### `GET /api/dsl`

Returns the active authorization model as the JSON OpenFGA returns (the wire
format from `ReadAuthorizationModels`, first entry).

**Response 200**: see `controllers/dsl.go` (forwards OpenFGA's body unchanged).

### `POST /api/dsl/parse`

Parse a DSL `.fga` body into the JSON OpenFGA wire format. Used by the editor for
its live preview.

**Request** (`Content-Type: application/json`):

```json
{ "text": "model\n  schema 1.1\n\ntype user\n" }
```

Or send the DSL as the raw request body (form-encoded `text=` also accepted).

**Response 200**: `{type_definitions, conditions, schema_version, errors, types, error_count}`.
On parser errors, `errors` is non-empty and the other fields may be partial.

### `POST /api/dsl/apply`

Push a new authorization model from DSL or JSON. Requires CSRF.

**Request — DSL**: same shape as `POST /api/dsl/parse` (`{"text": "..."}`).

**Request — JSON**: pass the OpenFGA JSON wire format directly as the body.

**Response 200**:

```json
{
  "authorization_model_id": "01HNEW…",
  "schema_version": "1.1",
  "types": 4,
  "conditions": 0
}
```

### `POST /api/dsl/lint`

Static lint of a DSL payload (semantic checks on the parsed model — orphan
relations, cycles).

**Request**:

```json
{ "model": { "type_definitions": [...], "conditions": {...} } }
```

**Response 200**: `{ "warnings": [{ "code", "severity", "type", "relation", "message", "cycle?" }] }`

### `GET /api/dsl/versions`

List past authorization model versions, newest first.

**Response 200**:

```json
{ "versions": [ { "id": "01H…", "schema_version": "1.1", "type_definitions": [...], "conditions": {...} }, ... ] }
```

### `GET /api/dsl/versions/{id}`

Read a specific historical model by ID.

**Response 200**: same shape as one entry of `versions` above.
**Response 404**: `{"error": "modèle introuvable: <id>"}` (returned by the underlying OpenFGA SDK call).

---

## Audit

### `POST /api/audit/check`

Check if a user has a relation on an object.

**Request**:

```json
{
  "user":     "user:alice",
  "relation": "viewer",
  "object":   "document:readme",
  "context":  { "ip": "10.0.0.1" }
}
```

`context` is optional (CEL conditions).

All three query endpoints (`check`, `list-objects`, `list-users`) also accept
`contextual_tuples`: tuples that hold for this request only and are never
stored. The Access page uses them the way the Kubernetes webhook does, for
group membership taken from the token and for the namespace → cluster link:

```json
{
  "user": "user:alice", "relation": "can_exec", "object": "namespace:team-a",
  "contextual_tuples": [
    { "user": "cluster:prod", "relation": "cluster", "object": "namespace:team-a" },
    { "user": "user:alice", "relation": "member", "object": "group:team-a" }
  ]
}
```

**Response 200**: `{ "allowed": true|false, "tuple": { ... } }`

### `POST /api/audit/list-objects`

List objects of a type that a user can reach via a relation.

**Request**:

```json
{
  "user":     "user:alice",
  "relation": "viewer",
  "type":     "document",
  "context":  { }
}
```

**Response 200**: `{ "objects": ["document:readme", "document:design"], "count": 2 }`

### `POST /api/audit/list-users`

List users that have a relation on an object.

**Request**:

```json
{
  "object":   "document:readme",
  "relation": "viewer",
  "user_type": "user"
}
```

`user_relation` (optional) filters on a userset instead of plain objects:
`"user_type": "group", "user_relation": "member"` returns `group:x#member`
subjects. `context` and `contextual_tuples` work as for `check`.

**Response 200**: `{ "users": [{ "object": { "type": "user", "id": "alice" } }, ...], "count": N }`

### `POST /api/audit/expand`

Native OpenFGA expand — returns the resolution tree of tuples that explain
why `user#relation@object` is allowed.

**Request**:

```json
{ "user": "user:alice", "relation": "viewer", "object": "document:readme" }
```

**Response 200**: `{ "tuples": [...], "resolved": true|false }`

---

## Assertions

### `GET /api/assertions?authorization_model_id=…`

List assertions for a model. Without the query param, uses the active model.

**Response 200**: `{ "assertions": [ { "tuple_key": {...}, "expectation": true|false } ] }`

### `POST /api/assertions`

Replace assertions on a model. Requires CSRF.

**Request**:

```json
{
  "authorization_model_id": "01HMODEL…",
  "assertions": [
    { "tuple_key": { "user": "user:alice", "relation": "viewer", "object": "document:readme" }, "expectation": true }
  ]
}
```

`expectation`: `true` (allowed) or `false` (denied).

**Response 200**: `{ "written": N }`

### `POST /api/assertions/check`

Evaluate a single assertion via `Check` (does not write it).

**Request**:

```json
{
  "user":     "user:alice",
  "relation": "viewer",
  "object":   "document:readme",
  "context":  { "ip": "10.0.0.1" }
}
```

**Response 200**: `{ "user": "...", "relation": "...", "object": "...", "allowed": true|false }`

---

## Import / Export

### `GET /api/export/tuples`

Export tuples of the active store as JSONL (one tuple per line).

**Response 200**: `Content-Type: application/jsonl`, `Content-Disposition: attachment; filename="openfga-tuples-<count>.jsonl"`.

```
{"user":"user:alice","relation":"viewer","object":"document:readme"}
{"user":"user:bob","relation":"viewer","object":"document:readme"}
```

### `POST /api/import/preview`

Parse + dedupe a JSONL payload **without** writing. Lets the UI display a
confirmation modal before commit.

**Request**: body is the raw JSONL (one tuple per line). `Content-Type: text/plain`
or `application/jsonl`.

**Response 200**:

```json
{
  "will_import": 12,
  "duplicates_in_batch": 1,
  "failed": [ { "line": 7, "error": "JSON invalide: ..." } ]
}
```

### `POST /api/import/tuples`

Import JSONL tuples in the active store. Requires CSRF. Batched in chunks of 50;
each failed batch is reported with the original line numbers.

**Request**: same shape as `POST /api/import/preview`.

**Response 200**:

```json
{
  "imported": 10,
  "failed": [ { "line": 3, "error": "..." } ]
}
```

> Note: not transactional — a batch that partially applies is rolled back via a
> compensating delete, but if that delete also fails the partial state may remain
> in OpenFGA. Use the `preview` endpoint first for non-trivial imports.

---

## Authorization model diff

### `POST /api/diff`

Compute the structural difference between two authorization models (by ID)
within the active store.

**Request**:

```json
{ "model_a_id": "01HA…", "model_b_id": "01HB…" }
```

**Response 200**:

```json
{
  "added_types":        [{ "type": "...", "added": true }],
  "removed_types":      [{ "type": "...", "removed": true }],
  "changed_types":      [{ "type": "...", "changed_relations": { "added": [...], "removed": [...], "changed": {...} } }],
  "added_conditions":   [{ "condition": "...", "added": true }],
  "removed_conditions": [{ "condition": "...", "removed": true }],
  "changed_conditions": [{ "condition": "...", "changed": { "a": {...}, "b": {...} } }]
}
```

**Note**: this endpoint compares **authorization models**, not stores. To compare
two stores' tuple sets, use the **Compare** button in the Tuples toolbar (calls
the dedicated `/api/stores/diff` family — see
[docs/web-ui.md](web-ui.md#tuples--cards-view)). The store-level diff is
implemented client-side over `/api/tuples`.

---

## Events (SSE)

### `GET /api/events`

Server-Sent Events stream. The frontend subscribes for live updates (tuple writes,
model changes).

**Query params**:

- `store_id` — filter events for a specific store (currently accepted but the
  server-side filtering is not yet implemented; the frontend filters on `store_id`
  client-side).
- `types` — comma-separated event types (`tuples.write`, `dsl.apply`, …).
  Also accepted but not yet implemented server-side.

**Response**: `text/event-stream`.

Heartbeats every 25 seconds. Max subscribers: `tuning.sse_max_subscribers` (default 100).

---

## Auth

### `GET /auth/login`

If OIDC is configured, redirects to the OIDC provider's authorization endpoint.
Otherwise redirects to `/` (the local login form is rendered on `/login`).

### `GET /auth/callback`

OIDC callback. Exchanges code for tokens, sets session cookie, redirects to `/`.

### `POST /auth/local`

Form-based login (always available as break-glass, even when OIDC is the primary).

**Request** (`application/x-www-form-urlencoded`):

```
username=admin&password=…
```

**Response 302**: sets session cookie, redirects to `/`.
**Response 302**: redirects to `/login?error=Identifiants%20invalides` on bad credentials.
**Response 429**: too many requests (rate limit, see `RATE_LIMIT_PER_MIN`).

### `POST /auth/logout`

Deletes the session and clears its cookie. Requires the `X-CSRF-Token` header,
so a third-party page cannot sign the user out.

**Response 204**: signed out. **Response 403**: missing or invalid CSRF token.

---

## Views

### `GET /login`

Renders the login HTML page. If OIDC is configured, shows a "Login with OIDC"
button. Otherwise shows the username/password form.

Query params:
- `username` — pre-fill the username field.
- `error` — display an error message.

---

## Roles

`user.role` in `GET /api/me` is `admin` (read and write) or `viewer` (read only).
Local accounts are always `admin`. OIDC users get their role from the `groups`
claim of the ID token, through `OIDC_ADMIN_GROUPS` and `OIDC_VIEWER_GROUPS`
(see [environment-variables.md](environment-variables.md#oidc_admin_groups--oidc_viewer_groups)).

These routes answer `403 {"error": "lecture seule : …"}` to a `viewer`:

- `POST /api/tuples`, `DELETE /api/tuples`
- `POST /api/import/tuples`
- `POST /api/dsl/apply`
- `POST /api/assertions`

Every other route, including Check, ListObjects, ListUsers, Expand, diff, export
and import preview, is open to both roles. The UI hides write actions for a
`viewer`.

---

## CSRF

Mutating routes (`POST`, `PUT`, `PATCH`, `DELETE`) require the `X-CSRF-Token`
header. The token is returned by `GET /api/me` and is stable for the session
lifetime. Without it (or with a wrong token), the response is `403 Forbidden`.

GET, HEAD, OPTIONS pass through without CSRF check.

---

## Error format

All errors share the same shape:

```json
{ "error": "human-readable message" }
```

HTTP status codes:

| Code | When |
|---|---|
| `200` | OK (also redirect-less success). |
| `302` | Auth redirects (OIDC, login form success/failure, logout). |
| `400` | Malformed request body / missing required field. |
| `401` | Not authenticated (and `AUTH_DISABLED` is not `1`). |
| `403` | CSRF token missing or invalid (mutating routes), write route called by a `viewer`, or OIDC login refused because the user is in no allowed group. |
| `404` | Resource not found (e.g., unknown store ID, unknown model ID). |
| `429` | Rate-limited (login attempts). |
| `502` | OpenFGA is unreachable / returned an upstream error. |
| `503` | Health endpoint: OpenFGA is configured but down. |
| `500` | Internal server error. |
