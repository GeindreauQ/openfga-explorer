# Configuration reference (`config.yaml`)

The optional `--config=/path/to/config.yaml` flag lets you override two families of
values without restarting with new env vars:

1. **`tuning.*`** — numeric / duration constants deep in the server.
2. **`theme.*`** — frontend branding (icons and colors per OpenFGA type).

Env vars always win over YAML. Defaults (from `src/server/config/defaults.go`) apply
when neither is set.

The reference file is [`config.yaml.example`](../config.yaml.example) at the repo root.

---

## File location

Pass the path via the `--config` flag:

```bash
./openfga-explorer --config=/etc/openfga-explorer/config.yaml
```

In the bundled Docker compose / Helm chart, the path is wired up automatically — you
just need to mount or template the file.

---

## `tuning` section

All keys are **optional**. A missing key falls back to the default in `defaults.go`.

| Key | Type | Default | Purpose |
|---|---|---|---|
| `session_ttl` | duration | `8h` | Inactivity timeout for a session. |
| `session_gc_interval` | duration | `10m` | How often the session store reaps expired entries. |
| `session_token_bytes` | int | `32` | Random bytes per session ID (≈256 bits of entropy). |
| `session_cookie_name` | string | `openfga_explorer_session` | Browser-side cookie name. |
| `bootstrap_timeout` | duration | `15s` | Timeout for the initial store listing at boot. |
| `oidc_init_timeout` | duration | `10s` | Timeout for the OIDC discovery handshake. |
| `sse_max_subscribers` | int | `100` | Max concurrent Server-Sent-Events clients (above → 503). |
| `sse_channel_buffer` | int | `16` | Per-subscriber event buffer size; events are dropped on overflow. |
| `ratelimit_idle_ttl` | duration | `10m` | Idle TTL for a per-IP bucket in the rate limiter. |
| `ratelimit_default_per_min` | int | `50` | Fallback if `RATE_LIMIT_PER_MIN` env is unset (env wins). |

### Example

```yaml
tuning:
  session_ttl: 4h
  sse_max_subscribers: 250
  bootstrap_timeout: 30s
```

---

## `theme` section

Three sub-keys, all optional and merged field-by-field with the built-in defaults:

- **`types`** — map `<type_name> → {icon, bg, text, border}`. A type listed here overrides
  the built-in styling for that type only. Other types keep their built-in look.
- **`palette`** — list of `{icon, bg, text, border}` entries. Used by the frontend for
  types not in `types` (cycled by hash of the type name). Replacing the list replaces
  the built-in palette entirely.
- **`default`** — single `{icon, bg, text, border}` entry. Fallback for unknown types.

### Visual properties

Each `ThemeEntry` has exactly four string fields:

| Field | Purpose | Example |
|---|---|---|
| `icon` | Tabler Icons class name (loaded from CDN by the frontend). | `ti-user`, `ti-shield-lock` |
| `bg` | Background color of the node badge (hex). | `#E6F1FB` |
| `text` | Foreground color (icon, label). | `#0C447C` |
| `border` | Border color (1px). | `#85B7EB` |

### Example

```yaml
theme:
  types:
    user:
      icon: ti-user
      bg: '#E6F1FB'
      text: '#0C447C'
      border: '#85B7EB'
    organization:
      icon: ti-building-community
      bg: '#EFE8F4'
      text: '#3F2A6B'
      border: '#9F88C2'
    # ... add your custom types here

  palette:
    - { icon: ti-circle,   bg: '#E6F1FB', text: '#0C447C', border: '#85B7EB' }
    - { icon: ti-square,   bg: '#FBEAF0', text: '#72243E', border: '#ED93B1' }
    # ... up to 8 entries

  default:
    icon: ti-circle-dot
    bg: '#F1EFE8'
    text: '#444441'
    border: '#B4B2A9'
```

### How the frontend uses it

The server serves the merged theme on `GET /api/config/theme` at boot. The frontend
also ships its own built-in copy (so the UI still renders if the API is unreachable,
e.g., behind a flaky network). If you set a theme via YAML, the YAML version wins as
soon as the API responds.

---

## Full example with both sections

```yaml
tuning:
  session_ttl: 8h
  sse_max_subscribers: 100
  sse_channel_buffer: 16
  bootstrap_timeout: 15s
  ratelimit_idle_ttl: 10m
  ratelimit_default_per_min: 50

theme:
  types:
    user:
      icon: ti-user
      bg: '#E6F1FB'
      text: '#0C447C'
      border: '#85B7EB'
    # ... your custom types
  palette:
    - { icon: ti-circle,   bg: '#E6F1FB', text: '#0C447C', border: '#85B7EB' }
    # ...
  default:
    icon: ti-circle-dot
    bg: '#F1EFE8'
    text: '#444441'
    border: '#B4B2A9'
```

---

## Precedence summary

For any given key:

```
.env > --config (YAML) > defaults.go (built-in)
```

For the `theme` section, the merge is field-by-field: a YAML `types.user` overrides only
the `user` entry; absent types keep their built-in styling. Same for `palette`
(replace entirely) and `default` (replace entirely).