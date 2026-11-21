# Environment Variables

Every environment variable the OpenFGA Explorer server reads, with default, purpose,
and security notes. The reference file is [`.env.example`](../.env.example) at the repo root.

> The store is selected at runtime from the UI toolbar (see
> [web-ui.md](web-ui.md#store-selector)), so there's no need to preset it.

---

## Summary table

| Variable | Default | Required? | Section |
|---|---|---|---|
| `ADDR` | `:8000` | no | [Server](#server) |
| `WEB_DIR` | `../web` | no | [Server](#server) |
| `OPENFGA_URL` | _(none)_ | **yes for non-demo** | [OpenFGA](#openfga) |
| `OPENFGA_TOKEN` | _(empty)_ | no | [OpenFGA](#openfga) |
| `OPENFGA_OIDC_TOKEN_URL` | _(empty)_ | no | [OpenFGA — OIDC client credentials](#openfga--oidc-client-credentials) |
| `OPENFGA_OIDC_CLIENT_ID` | _(empty)_ | with `OPENFGA_OIDC_TOKEN_URL` | [OpenFGA — OIDC client credentials](#openfga--oidc-client-credentials) |
| `OPENFGA_OIDC_CLIENT_SECRET` | _(empty)_ | see section | [OpenFGA — OIDC client credentials](#openfga--oidc-client-credentials) |
| `OPENFGA_OIDC_USERNAME` | _(empty)_ | see section | [OpenFGA — OIDC client credentials](#openfga--oidc-client-credentials) |
| `OPENFGA_OIDC_PASSWORD` | _(empty)_ | with `OPENFGA_OIDC_USERNAME` | [OpenFGA — OIDC client credentials](#openfga--oidc-client-credentials) |
| `OPENFGA_OIDC_SCOPE` | _(empty)_ | no | [OpenFGA — OIDC client credentials](#openfga--oidc-client-credentials) |
| `OIDC_ISSUER_URL` | _(empty)_ | no | [Auth — OIDC](#auth--oidc) |
| `OIDC_CLIENT_ID` | _(empty)_ | with OIDC | [Auth — OIDC](#auth--oidc) |
| `OIDC_CLIENT_SECRET` | _(empty)_ | with OIDC | [Auth — OIDC](#auth--oidc) |
| `OIDC_REDIRECT_URL` | `http://localhost:8000/auth/callback` | with OIDC | [Auth — OIDC](#auth--oidc) |
| `OIDC_SCOPES` | `openid,profile,email` | no | [Auth — OIDC](#auth--oidc) |
| `OIDC_ADMIN_GROUPS` | _(empty)_ | no | [Roles](#oidc_admin_groups--oidc_viewer_groups) |
| `OIDC_VIEWER_GROUPS` | _(empty)_ | no | [Roles](#oidc_admin_groups--oidc_viewer_groups) |
| `OIDC_ALLOW_INSECURE_URL` | _(empty)_ | no | [OIDC_ALLOW_INSECURE_URL](#oidc_allow_insecure_url) |
| `SESSION_SECRET` | `dev-only-insecure-change-me` | **yes for prod** | [Auth — Sessions](#auth--sessions) |
| `ADMIN_PASSWORD` | _(random 24 chars)_ | no | [Auth — Local admin](#auth--local-admin) |
| `AUTH_DISABLED` | _(empty)_ | no | [Auth — Modes](#auth--modes) |
| `LOCAL_LOGIN_DISABLED` | _(empty)_ | no | [Auth — Modes](#auth--modes) |
| `SECURE_COOKIES` | _(empty)_ | no | [Auth — Cookies](#auth--cookies) |
| `RATE_LIMIT_PER_MIN` | `50` | no | [Auth — Rate limit](#auth--rate-limit) |
| `TRUSTED_PROXY_CIDRS` | _(empty)_ | no | [Trusted proxies](#trusted-proxy-cidrs) |

---

## Server

### `ADDR`

- **Default**: `:8000`
- **Purpose**: TCP address the HTTP server listens on.
- **Notes**: Accepts the standard Go `net.Listen` syntax. Use `127.0.0.1:8000` to bind
  loopback only (e.g., behind a reverse proxy). Use `:8000` (empty host) to accept on
  all interfaces — which is what the bundled Helm chart and Docker image expect.

```bash
ADDR=:8000
```

### `WEB_DIR`

- **Default**: `../web`
- **Purpose**: Filesystem path to the static frontend assets served on `/`.
- **Notes**: Relative to the binary's working directory. The Docker image sets this to
  `/app/web` (absolute). You almost never need to override this in practice.

```bash
WEB_DIR=../web
```

---

## OpenFGA

### `OPENFGA_URL`

- **Default**: _(none)_
- **Required?** **Yes**, unless you want the app to start in "OpenFGA non configuré" mode
  (the UI will display a banner; all API calls will return errors until configured).
- **Purpose**: Base URL of the OpenFGA server the Explorer should connect to.
- **Notes**: Seen from the **Explorer process**, not from your shell. From inside Docker,
  use the container/service name (e.g., `http://openfga:8080`). From a local binary,
  use `http://localhost:8080`. The trailing `/` is trimmed automatically.

```bash
# Inside Docker (compose stack)
OPENFGA_URL=http://openfga:8080

# Inside Kubernetes (same namespace)
OPENFGA_URL=http://openfga.openfga.svc.cluster.local:8080

# Local binary against local OpenFGA
OPENFGA_URL=http://localhost:8080
```

### `OPENFGA_TOKEN`

- **Default**: _(empty)_
- **Required?** No.
- **Purpose**: Bearer token sent on every request to OpenFGA.
- **Notes**: Use this when OpenFGA sits behind an auth proxy, or when you've configured
  OpenFGA's `OPENFGA_AUTHN_METHOD=preshared` with a preshared key. The `Bearer ` prefix
  is optional — the server adds it if missing.

```bash
OPENFGA_TOKEN=my-preshared-key
```

> **Security**: prefer `helm install --set openfga.token.existingSecret=…` over passing
> the value inline. See [deployment.md](deployment.md#token-secret).

---

## OpenFGA — OIDC client credentials

When OpenFGA runs with `OPENFGA_AUTHN_METHOD=oidc`, it only accepts JWTs issued by
your identity provider. Instead of a static `OPENFGA_TOKEN`, the explorer can fetch
an access token with the OAuth2 `client_credentials` grant, cache it until one minute
before it expires, and renew it automatically.

| Variable | Purpose |
|---|---|
| `OPENFGA_OIDC_TOKEN_URL` | Token endpoint of the identity provider. Setting it enables this mode. |
| `OPENFGA_OIDC_CLIENT_ID` | OAuth2 client id. Required. |
| `OPENFGA_OIDC_CLIENT_SECRET` | Client secret, for a confidential client. |
| `OPENFGA_OIDC_USERNAME` / `OPENFGA_OIDC_PASSWORD` | Service account and its app password, sent with the grant (Authentik's way of issuing tokens to a service account). |
| `OPENFGA_OIDC_SCOPE` | Optional scopes, space separated. |

Either a client secret or a username is required. With Authentik:

```bash
OPENFGA_OIDC_TOKEN_URL=https://auth.example.com/application/o/token/
OPENFGA_OIDC_CLIENT_ID=openfga
OPENFGA_OIDC_USERNAME=openfga-explorer      # service account
OPENFGA_OIDC_PASSWORD=<app password token>  # from a Secret, never inline
```

The token's audience must match OpenFGA's `OPENFGA_AUTHN_OIDC_AUDIENCE`.

---

## Auth — OIDC

When **all three** of `OIDC_ISSUER_URL`, `OIDC_CLIENT_ID`, `OIDC_REDIRECT_URL` are set,
the Explorer wires up OpenID Connect (Keycloak, Auth0, Okta, Google, …) as the primary
login. The local admin login stays available as a break-glass fallback unless you
explicitly disable it.

### `OIDC_ISSUER_URL`

- **Default**: _(empty)_
- **Required?** With OIDC, yes.
- **Purpose**: Issuer URL of the OpenID Connect provider. The server does a discovery
  request (`/.well-known/openid-configuration`) at boot.

```bash
# Keycloak
OIDC_ISSUER_URL=http://keycloak:8080/realms/demo

# Auth0
OIDC_ISSUER_URL=https://your-tenant.eu.auth0.com/

# Okta
OIDC_ISSUER_URL=https://example.okta.com/oauth2/default
```

### `OIDC_CLIENT_ID`

- **Default**: _(empty)_
- **Required?** With OIDC, yes.
- **Purpose**: OAuth2 client identifier registered on the provider.

```bash
OIDC_CLIENT_ID=openfga-explorer
```

### `OIDC_CLIENT_SECRET`

- **Default**: _(empty)_
- **Required?** With OIDC, yes (unless your provider uses PKCE without a secret).
- **Purpose**: OAuth2 client secret.
- **Security**: never commit. Inject via Kubernetes Secret or Docker Secret.

### `OIDC_REDIRECT_URL`

- **Default**: `http://localhost:8000/auth/callback`
- **Required?** With OIDC, yes (and must exactly match the URL registered on the provider).
- **Purpose**: OAuth2 callback URL the provider redirects to after login.

```bash
# Production
OIDC_REDIRECT_URL=https://explorer.example.com/auth/callback
```

### `OIDC_SCOPES`

- **Default**: `openid,profile,email`
- **Required?** No.
- **Purpose**: OAuth2 scopes requested at login.
- **Notes**: `openid` is always prepended if missing — the OIDC spec requires it.
  Scopes can be separated by commas or spaces.

```bash
OIDC_SCOPES=openid,profile,email,groups
```

### `OIDC_ADMIN_GROUPS` / `OIDC_VIEWER_GROUPS`

- **Default**: _(empty)_ → every OIDC user is `admin`.
- **Format**: comma-separated group names, as found in the ID token's `groups` claim.
  Spaces are kept inside names (`authentik Admins`).
- **Purpose**: role of an OIDC user, decided at login:
  1. member of an `OIDC_ADMIN_GROUPS` group (or the list is empty) → `admin`, read and write;
  2. otherwise, member of an `OIDC_VIEWER_GROUPS` group, or that list is empty → `viewer`,
     read only (write routes answer 403, the UI hides write actions);
  3. otherwise → login refused (403).
- **Notes**: request the scope that carries `groups` (`profile` with Authentik, `groups`
  with Keycloak or Okta). Local accounts are always `admin`. The role is fixed for the
  session: log out and in again after a group change.

```bash
OIDC_ADMIN_GROUPS=authentik Admins,openfga-admins
OIDC_VIEWER_GROUPS=openfga-viewers
```

### `OIDC_ALLOW_INSECURE_URL`

- **Default**: _(empty)_
- **Purpose**: Override the SSRF guard on `OIDC_ISSUER_URL`. Set to `1` to
  allow pointing the issuer at a loopback or RFC 1918 address (Keycloak
  in `docker compose`, IdP on `10.x`).
- **Notes**: Without this var, the server refuses to start if the issuer
  URL is an IP literal in `127.0.0.0/8`, `::1/128`, `10.0.0.0/8`,
  `172.16.0.0/12`, `192.168.0.0/16`, `169.254.0.0/16` (cloud metadata)
  or `0.0.0.0/8`. Hostnames are always accepted. Only set this in
  development / trusted environments.

```bash
# Local Keycloak in docker-compose
OIDC_ALLOW_INSECURE_URL=1
```

---

## Auth — Sessions

### `SESSION_SECRET`

- **Default**: `dev-only-insecure-change-me`
- **Required?** **Yes for production.**
- **Purpose**: HMAC key used to sign session cookies.
- **Min length**: 32 characters. A warning is logged at startup if it's shorter.
- **Notes**: rotate carefully — rotating invalidates all active sessions.
- **Security**: never reuse across environments. Inject via Kubernetes Secret.

```bash
# Generate a strong one with:
openssl rand -hex 32
SESSION_SECRET=<paste-here>
```

---

## Auth — Local admin

### `ADMIN_PASSWORD`

- **Default**: _(empty)_ — if empty, a random 24-character password is generated and
  printed in the container logs at first boot (look for the `SECURITY` block).
- **Required?** No.
- **Purpose**: Password for the local `admin` account (always seeded at boot).
- **Notes**: For production, set this explicitly so you don't depend on log scraping.

```bash
ADMIN_PASSWORD=$(openssl rand -hex 16)
```

---

## Auth — Modes

### `AUTH_DISABLED`

- **Default**: _(empty)_ → auth is **enabled**.
- **Values**: set to `1` to disable all auth.
- **Purpose**: Demo / local-dev escape hatch — open the UI without logging in.
- **Security**: **never** set this in production. The Docker image's default user is
  non-root and the chart defaults to `AUTH_DISABLED` empty for a reason.

```bash
# Local demo only
AUTH_DISABLED=1
```

### `LOCAL_LOGIN_DISABLED`

- **Default**: _(empty)_ → the local `admin` account is available.
- **Values**: set to `1` to keep OIDC as the only way to log in.
- **Purpose**: With SSO configured, removes the local admin account and its password form.
- **Validation**: the server refuses to start if this is set without `OIDC_ISSUER_URL`,
  since nobody could log in.

```bash
OIDC_ISSUER_URL=https://auth.example.com/application/o/openfga/
LOCAL_LOGIN_DISABLED=1
```

---

## Auth — Cookies

### `SECURE_COOKIES`

- **Default**: _(empty)_ → `Secure` attribute is **not** set on cookies.
- **Values**: set to `1` to set the `Secure` flag.
- **Purpose**: When the Explorer is reached over HTTPS, you want `Secure` cookies so the
  browser refuses to send them back over plain HTTP.
- **Notes**: There is no auto-detection. It's your call based on your deployment.

```bash
# Behind HTTPS (recommended)
SECURE_COOKIES=1
```

---

## Auth — Rate limit

### `RATE_LIMIT_PER_MIN`

- **Default**: `50`
- **Purpose**: Maximum number of `POST /auth/local` requests per IP per minute.
- **Notes**: Anti brute-force on the local login form. Above the threshold, the server
  returns HTTP `429` with `Retry-After: 60`.

```bash
# Tighten if you're behind a shared reverse proxy with many users
RATE_LIMIT_PER_MIN=10
```

### `TRUSTED_PROXY_CIDRS`

- **Default**: _(empty)_
- **Purpose**: CSV list of CIDRs that are allowed to forward the real client
  IP via the `X-Forwarded-For` header. Used by the rate limiter to bucket
  per real client instead of per reverse proxy.
- **Notes**: Without this set, the rate limiter keys on `r.RemoteAddr` only —
  which is the LB's IP behind an Ingress. Set this to your reverse proxy's
  CIDR (e.g. `10.0.0.0/8` for an in-cluster proxy, `172.16.0.0/12` for a
  Docker bridge network). Malformed CIDRs are ignored; an empty value
  disables the feature.

```bash
# Trust the cluster-internal proxy, key on real client IPs
TRUSTED_PROXY_CIDRS=10.0.0.0/8
```

---

## OpenFGA

## Precedence

Environment variables always win over `config.yaml` (the optional `--config` YAML file
covering only `tuning.*` and `theme.*` knobs). For values not set by either, defaults
from `src/server/config/defaults.go` apply.

See [configuration.md](configuration.md) for the YAML reference.