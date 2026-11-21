# Deployment Guide

Three supported deployment paths:

1. [Docker Compose](#docker-compose) — local dev / single-host demo.
2. [Helm chart](#helm-chart) — production Kubernetes.
3. [Bare binary](#bare-binary) — systemd / VM / anything with a Linux box.

---

## Docker Compose

The bundled [`docker-compose.yml`](../docker-compose.yml) brings up:

| Service | Image | Port | Purpose |
|---|---|---|---|
| `openfga` | `openfga/openfga:v1.22.1` | `8080` (HTTP), `8081` (gRPC) | The OpenFGA server, in-memory datastore. |
| `explorer` | `openfga-explorer:v1` (built locally) | `8000` | The Explorer web UI. |

The optional overlay [`examples/seeder.yml`](../examples/seeder.yml) adds a `seeder`
service (`node:24-alpine`), a one-shot job that creates the demo stores.

### Start

```bash
docker compose up --build                                          # empty OpenFGA
docker compose -f docker-compose.yml -f examples/seeder.yml up --build  # with demo stores
```

Open <http://localhost:8000>. With the overlay, the seeder creates the
`example-*` stores on first run; they're listed in the toolbar dropdown.

### Customisation

Override env in your own `docker-compose.override.yml`:

```yaml
services:
  explorer:
    environment:
      OPENFGA_URL: http://openfga:8080
      OIDC_ISSUER_URL: http://keycloak:8080/realms/demo
      OIDC_CLIENT_ID: openfga-explorer
      OIDC_CLIENT_SECRET: ${OIDC_CLIENT_SECRET}
      SESSION_SECRET: ${SESSION_SECRET}
      SECURE_COOKIES: "1"
```

### Persistent state

`openfga` uses in-memory storage by default (lost on restart). To persist tuples,
set:

```yaml
services:
  openfga:
    command: ["run"]
    environment:
      OPENFGA_DATASTORE_ENGINE: postgres
      OPENFGA_DATASTORE_URI: postgres://openfga:password@db:5432/openfga?sslmode=disable
    depends_on:
      - db
  db:
    image: postgres:16-alpine
    environment:
      POSTGRES_USER: openfga
      POSTGRES_PASSWORD: password
      POSTGRES_DB: openfga
    volumes:
      - openfga_pg:/var/lib/postgresql/data
volumes:
  openfga_pg:
```

See [openfga.dev/docs/storage](https://openfga.dev/docs/storage) for the full storage
matrix (Postgres, MySQL, SQLite).

### Production checklist (compose)

- [ ] Set a real `SESSION_SECRET` (`openssl rand -hex 32`).
- [ ] Set `SECURE_COOKIES=1` and put the Explorer behind HTTPS (Traefik, Caddy, …).
- [ ] Set `OIDC_*` to your IdP, **don't** rely on `AUTH_DISABLED`.
- [ ] Configure OpenFGA with persistent storage (Postgres).
- [ ] Add a reverse proxy in front of the Explorer for TLS termination.

---

## Helm chart

The chart in [`charts/openfga-explorer/`](../charts/openfga-explorer/) is production-ready
out of the box:

- distroless image (no shell, no package manager)
- `runAsNonRoot: true`, `readOnlyRootFilesystem: true`
- `seccompProfile: RuntimeDefault`, all capabilities dropped
- `livenessProbe` + `readinessProbe` on `/api/health`
- `ServiceAccount` with `automountServiceAccountToken: false`

### Install

```bash
helm repo add openfga-explorer https://GeindreauQ.github.io/openfga-explorer  # if published
helm install openfga-explorer ./charts/openfga-explorer \
  --set openfga.url=http://openfga.openfga.svc.cluster.local:8080
```

Or from a local clone:

```bash
git clone https://github.com/GeindreauQ/openfga-explorer.git
cd openfga-explorer
helm install openfga-explorer ./charts/openfga-explorer \
  --set openfga.url=http://openfga.openfga.svc.cluster.local:8080
```

### Required values

You need at least `openfga.url`. Everything else has sane defaults.

```yaml
openfga:
  url: "http://openfga.openfga.svc.cluster.local:8080"
```

### Token secret

For OpenFGA instances that need a Bearer token, **always** use an existing Secret:

```bash
kubectl create secret generic my-openfga-token --from-literal=token=YOUR_TOKEN
helm upgrade --install openfga-explorer ./charts/openfga-explorer \
  --set openfga.url=http://openfga:8080 \
  --set openfga.token.existingSecret=my-openfga-token \
  --set openfga.token.existingSecretKey=token
```

### OIDC integration

The `oidc.*` block is injected into the container only when `oidc.issuerUrl`
is non-empty, so the chart works out of the box without OIDC. The client
secret goes into a Secret: an existing one (`oidc.existingSecret`), or one the
chart creates from `oidc.clientSecret`.

```yaml
openfga:
  url: http://openfga.openfga.svc.cluster.local:8080

oidc:
  issuerUrl:   https://keycloak.example.com/realms/prod
  clientId:    openfga-explorer
  redirectUrl: https://explorer.example.com/auth/callback
  scopes:      "openid,profile,email,groups"
  existingSecret:    explorer-oidc        # key client-secret
  # Roles from the groups claim (comma separated)
  adminGroups:  "fga-admins"
  viewerGroups: "fga-auditors"
  localLoginDisabled: true                # SSO only

auth:
  secureCookies:  true
  secret:
    sessionSecret:
      existingSecret: explorer-session    # key session-secret
```

### OpenFGA with OIDC authentication

When OpenFGA runs with `authn.method: oidc`, give the explorer a client of the
identity provider instead of a static token. It fetches a token with the
`client_credentials` grant and renews it before it expires.

```yaml
openfga:
  url: http://openfga:8080
  oidc:
    tokenUrl: https://auth.example.com/application/o/token/
    clientId: openfga
    username: openfga-explorer           # Authentik service account (optional)
    existingSecret: explorer-openfga-sso # keys client-secret and/or password
```

### All values

| Key | Default | Notes |
|---|---|---|
| `replicaCount` | `1` | Stateless — scale freely (with sticky sessions). |
| `image.repository` | `openfga-explorer` | |
| `image.tag` | `.Chart.AppVersion` (`1.0.0`) | |
| `image.pullPolicy` | `IfNotPresent` | |
| `serviceAccount.create` | `true` | |
| `openfga.url` | `http://openfga.openfga.svc.cluster.local:8080` | |
| `openfga.token.value` | `""` | Inline token (use `existingSecret` instead). |
| `openfga.token.existingSecret` | `""` | If set, mount this Secret. |
| `openfga.token.existingSecretKey` | `token` | Key inside the Secret. |
| `oidc.issuerUrl` | `""` | Enables OIDC when set. |
| `oidc.clientId` | `""` | |
| `oidc.clientSecret` | `""` | Inline value, stored in a chart-managed Secret. |
| `oidc.redirectUrl` | `""` | Must match the provider. |
| `oidc.scopes` | `openid,profile,email` | Add the scope that carries `groups` for roles. |
| `oidc.existingSecret` / `existingSecretKey` | `""` / `client-secret` | Secret holding the client secret. |
| `oidc.adminGroups` | `""` | Groups with read and write access. Empty: every OIDC user is admin. |
| `oidc.viewerGroups` | `""` | Groups with read-only access. Set: users in neither list are refused. |
| `oidc.localLoginDisabled` | `false` | Removes the local admin account. |
| `openfga.oidc.tokenUrl` | `""` | Enables client_credentials tokens towards OpenFGA. |
| `openfga.oidc.clientId` / `username` / `scope` | `""` | |
| `openfga.oidc.clientSecret` / `password` | `""` | Inline values (use `existingSecret` instead). |
| `openfga.oidc.existingSecret` | `""` | Keys `client-secret` and `password` (configurable). |
| `auth.secret.sessionSecret.value` | `""` | **Required for prod** (≥ 32 chars). |
| `auth.secret.sessionSecret.existingSecret` | `""` | If set, mount this Secret. |
| `auth.secret.sessionSecret.existingSecretKey` | `session-secret` | Key inside the Secret. |
| `auth.secret.adminPassword.value` | `""` | If empty, a random one is generated and printed. |
| `auth.secret.adminPassword.existingSecret` | `""` | If set, mount this Secret. |
| `auth.secret.adminPassword.existingSecretKey` | `admin-password` | Key inside the Secret. |
| `auth.disabled` | `false` | Bypasses all auth (demo only). |
| `auth.secureCookies` | `false` | Set `true` behind HTTPS. |
| `auth.rateLimitPerMin` | `50` | |
| `addr` | `:8000` | |
| `service.type` | `ClusterIP` | |
| `service.port` | `8000` | |
| `tuning.*` | _see [configuration.md](configuration.md)_ | Optional YAML overrides for tuning values. |
| `livenessProbe.*` | `/api/health` every 15s | |
| `readinessProbe.*` | `/api/health` every 10s | |
| `resources.requests` | `25m / 32Mi` | |
| `resources.limits` | `250m / 128Mi` | |
| `podSecurityContext` | non-root (uid 65532), seccomp RuntimeDefault | |
| `securityContext` | no escalation, RO FS, no caps | |

> The keys `sessionSecret`, `adminPassword`, `authDisabled`, `secureCookies`,
> `rateLimitPerMin` shown in older versions of this doc are now nested under
> `auth.secret.*` and `auth.*`. See [`values.yaml`](../charts/openfga-explorer/values.yaml)
> for the canonical structure.

### Ingress

A minimal Ingress (nginx) for HTTPS termination:

```yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: openfga-explorer
  annotations:
    cert-manager.io/cluster-issuer: letsencrypt-prod
spec:
  ingressClassName: nginx
  tls:
    - hosts: [explorer.example.com]
      secretName: explorer-tls
  rules:
    - host: explorer.example.com
      http:
        paths:
          - path: /
            pathType: Prefix
            backend:
              service:
                name: openfga-explorer
                port:
                  number: 8000
```

Don't forget `OIDC_REDIRECT_URL=https://explorer.example.com/auth/callback` and
`SECURE_COOKIES=1`.

### Upgrade

```bash
helm upgrade openfga-explorer ./charts/openfga-explorer \
  --reuse-values \
  --set image.tag=v2
```

State lives in OpenFGA (not the Explorer), so upgrades are zero-downtime.

---

## Bare binary

Build once, run anywhere with a POSIX shell.

```bash
cd src/server
CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o openfga-explorer .
cp ../../config.yaml.example ./config.yaml   # optional
./openfga-explorer --config=./config.yaml
```

### systemd unit

```ini
# /etc/systemd/system/openfga-explorer.service
[Unit]
Description=OpenFGA Explorer
After=network.target

[Service]
Type=simple
User=openfga-explorer
Group=openfga-explorer
EnvironmentFile=/etc/openfga-explorer/env
ExecStart=/usr/local/bin/openfga-explorer --config=/etc/openfga-explorer/config.yaml
Restart=on-failure
RestartSec=5
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
ReadWritePaths=/var/lib/openfga-explorer

[Install]
WantedBy=multi-user.target
```

`/etc/openfga-explorer/env`:

```bash
ADDR=:8000
OPENFGA_URL=http://localhost:8080
SESSION_SECRET=…
ADMIN_PASSWORD=…
SECURE_COOKIES=1
```

```bash
sudo useradd --system --no-create-home --shell /usr/sbin/nologin openfga-explorer
sudo systemctl daemon-reload
sudo systemctl enable --now openfga-explorer
```

---

## TLS / reverse proxy

The Explorer doesn't terminate TLS itself. Put a reverse proxy in front:

### nginx

```nginx
server {
    listen 443 ssl http2;
    server_name explorer.example.com;

    ssl_certificate     /etc/letsencrypt/live/explorer.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/explorer.example.com/privkey.pem;

    # SSE: disable buffering, increase read timeout
    proxy_buffering off;
    proxy_read_timeout 1h;

    location / {
        proxy_pass         http://127.0.0.1:8000;
        proxy_set_header   Host              $host;
        proxy_set_header   X-Real-IP         $remote_addr;
        proxy_set_header   X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header   X-Forwarded-Proto $scheme;
    }
}
```

### Caddy

```caddy
explorer.example.com {
    reverse_proxy 127.0.0.1:8000 {
        flush_interval -1   # for SSE
    }
}
```

Remember `SECURE_COOKIES=1` once you're behind HTTPS.

---

## Backup / disaster recovery

- **Explorer**: stateless. No backup needed.
- **OpenFGA**: backing up the datastore (Postgres, MySQL) is enough. The Explorer
  re-reads everything on each request.
- **Authorization models**: viewable from `GET /api/dsl` and
  `GET /api/dsl/versions`. Snapshots can be exported via the **Import / Export**
  page in the UI.

---

## Health probes

For Kubernetes / Docker Compose:

- **Liveness**: `GET /api/health` — restart on failure.
- **Readiness**: `GET /api/health` — remove from service on failure (especially when
  `openfga: "down"`).

The chart already configures both with sensible defaults (periodSeconds: 15/10,
initialDelaySeconds: 5/3).