# maplescouter-sync

Save [MapleScouter](https://maplescouter.com/en/input) input presets to your own self-hosted server and import them on any machine.

MapleScouter keeps its `/input` presets purely client-side, so they are trapped in a single browser profile. This repo contains:

- **`extension/`** — a Chrome Manifest V3 extension (no build step, load unpacked) that reads/writes the site's preset storage and talks to the sync server.
- **`server/`** — a tiny sync API (Node 22 + Hono + SQLite, single container) that stores presets per user with last-write-wins semantics plus version history, and full-state backups.

> Status: code complete; **not deployed anywhere yet**. The server is designed to run as a Docker stack behind Traefik + Authentik forward-auth (see [Deployment](#deployment)).

## How it works

MapleScouter persists its `/input` state as Zustand `persist` stores in `localStorage` (verified against the site's own bundles, 2026-07):

| localStorage key | Contents |
| --- | --- |
| `preset` | `{"state":{"preset":{"<slot>":{"data":…,"label":"…"}}},"version":N}` — the saved preset slots |
| `character-store` | Live input state |
| `charBookmarkList` | Character bookmarks |
| `region` | Region setting |

The site's own "Recall Saved Preset" writes the store and reloads the page — the extension's import does exactly the same, so it stays compatible with the site's normal flow. The extension never calls MapleScouter's API and only touches data already in your browser.

```
popup ──▶ content script (isolated world) ──▶ page localStorage
  │
  └────▶ service worker ──HTTPS + Basic (Authentik app password)──▶ Traefik ▶ Authentik forward-auth ▶ sync server
```

Two sync shapes:

- **Individual presets** — upload a slot to the cloud library; import any cloud preset into any slot on any machine (with a warning if the site's storage `version` differs).
- **Full-state backups** — snapshot/restore all four keys at once (moving to a new browser/machine).

## Extension

### Install (unpacked)

1. `chrome://extensions` → enable **Developer mode** → **Load unpacked** → pick the `extension/` folder (or the CI `extension-unpacked` artifact, unzipped). Chrome 133+ keeps unpacked extensions enabled only while developer mode stays on.
2. Open the extension **options**: set the server URL, your Authentik username, and an Authentik **app password** (User settings → Tokens and App passwords — an account password will not work; the proxy validates app passwords via Authentik's M2M flow).
3. "Save & grant host access" (Chrome will prompt for the server origin), then "Test connection".

### Why these permissions

- `host_permissions: maplescouter.com` — the content script reads/writes the site's localStorage (an isolated-world script shares the page origin's storage).
- `optional_host_permissions` — the service worker fetches your server cross-origin under a host permission granted at options-save time, which is why the server needs **no CORS configuration** (content scripts can't do this — they fetch under the page's origin).
- `storage` — config lives in `chrome.storage.local`; the MV3 worker is killed after ~30 s idle and must be stateless.
- `scripting` — re-inject the content script into tabs that predate the install.

## Server

### API

All `/api/*` routes require the `X-authentik-username` header, which the Authentik forward-auth proxy injects after validating the extension's `Authorization: Basic <user>:<app-password>` header. The container is meant to sit on the internal proxy network only — with `ALLOWED_USERS` as an app-level allowlist on top.

| Method & path | Purpose |
| --- | --- |
| `GET /healthz` | Liveness (no auth) |
| `GET /api/v1/presets` | List preset metadata |
| `POST /api/v1/presets` | Create `{label?, entry, envelopeVersion?, device?}` |
| `GET/PUT/DELETE /api/v1/presets/:id` | Fetch / overwrite (previous revision kept) / delete |
| `GET /api/v1/presets/:id/versions` | Version history metadata |
| `GET /api/v1/presets/:id/versions/:versionId` | Fetch an old revision |
| `POST /api/v1/backups` | Store a full-state snapshot `{payload, device?}` |
| `GET /api/v1/backups` / `/latest` / `/:id` | List / newest / specific backup |

### Configuration

| Env | Default | Meaning |
| --- | --- | --- |
| `PORT` | `8080` | Listen port |
| `DB_PATH` | `/app/data/sync.db` | SQLite file (WAL mode) |
| `ALLOWED_USERS` | *(empty = any authenticated user)* | Comma-separated Authentik usernames |
| `MAX_BODY_BYTES` | `8388608` | Request body cap |
| `BACKUP_KEEP` | `30` | Full-state backups kept per user |
| `VERSION_KEEP` | `20` | Old revisions kept per preset |
| `LOG_REQUESTS` | `true` | Request logging |

### Run

```bash
docker run -p 8080:8080 -v ./data:/app/data ghcr.io/tomerh2001/maplescouter-sync:latest

# local development
cd server && npm install && npm run dev   # tests: npm test
```

## Deployment

Intended shape (not yet applied): Docker stack on the home server behind the standard Traefik middleware chain (`cloudflarewarp,crowdsec,auth`), with an Authentik application + proxy provider for the sync hostname. Authentik's default "Intercept header authentication" accepts the extension's Basic app-password header with **no route bypass**: invalid credentials get `401`, absent credentials fall through to the normal login redirect. Requires Authentik ≥ 2025.10.4 / 2025.12.4 (CVE-2026-25748). CI publishes `ghcr.io/tomerh2001/maplescouter-sync:latest` for the stack to consume.

## Notes

- Presets are stored verbatim (opaque JSON) — a site-side format change bumps the Zustand `version`, which the extension surfaces as an import warning rather than corrupting anything.
- The extension holds the app password in plain `chrome.storage.local`; use a dedicated app password so it can be revoked independently.
