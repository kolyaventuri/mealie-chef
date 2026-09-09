# Setup Guide

This guide covers local development, LAN testing on iPads, production serving,
Docker, Dokku, persistence, and common failure modes.

## Requirements

- Node.js 24 LTS or another supported Node release. The application uses Node's
  built-in SQLite support, and the production Docker image uses
  `node:24-alpine`.
- pnpm 10.x. Use the shell-configured Node version, then enable pnpm with
  Corepack if needed.
- A Mealie instance reachable from this app.
- A Mealie API token with access to recipes and household meal plans.
- An OpenAI API key if the recipe importer is enabled.

Check your local versions:

```sh
node -v
pnpm -v
```

If `node -v` is below `v24`, upgrade before installing dependencies. Prefer
Node 24 LTS for parity with the production image.

## Configuration

Copy the example environment file:

```sh
cp .env.example .env
```

Set these variables in `.env` for local use, or in the process environment for
production:

| Variable | Required | Default | Notes |
| --- | --- | --- | --- |
| `MEALIE_BASE_URL` | Yes | none | Base URL for Mealie, such as `https://mealie.example.com`. Trailing slashes are stripped. |
| `MEALIE_API_TOKEN` | Yes | none | Bearer token sent to Mealie. Do not commit it. |
| `OPENAI_API_KEY` | No | none | Enables `/import`; kept on the server and never sent to the browser. |
| `OPENAI_RECIPE_MODEL` | No | `gpt-5.6-luna` | OpenAI model used for recipe extraction. |
| `OPENAI_RECIPE_REASONING_EFFORT` | No | `medium` | Responses API reasoning effort for recipe extraction. |
| `PORT` | No | `3100` | Fastify server port. |
| `APP_TIME_ZONE` | No | host default | IANA time zone used to decide planner `Today`, such as `America/Phoenix`. Set this explicitly in production. |
| `DATABASE_PATH` | No | `data/mealie-ipad-sync.sqlite` | SQLite database path. Parent directories are created automatically. |
| `SESSION_MAX_AGE_HOURS` | No | `6` | Maximum age, based on `sessions.updated_at`, before the global session pointer stops auto-resuming. Historical rows are not deleted. |
| `LOG_LEVEL` | No | `info` | Fastify logger level. |

The app will start without Mealie credentials, but Mealie-backed routes return
`503` until `MEALIE_BASE_URL` and `MEALIE_API_TOKEN` are set.

The `/import` page requires `OPENAI_API_KEY`. It accepts one source mode at a
time: a public HTTP(S) recipe URL, pasted text, or up to eight PNG/JPEG/WebP
screenshots. URL fetching is server-side and rejects private or local targets;
screenshots are held in memory only. The parser returns a Schema.org Recipe
draft and review notes. The browser must acknowledge notes and confirm the
editable draft before the server calls Mealie. On confirmation, the final
ingredient strings also go through Mealie's ingredient parser so existing
foods, units, and aliases are reused where possible; the full food list is not
sent to OpenAI. If Mealie leaves a line unmatched, the server may send only
those unmatched lines in one structured LLM cleanup request, then runs the
normalized result through Mealie again before creating any missing food or unit.

Import logs include the request ID, input mode and size metadata, parser stage,
OpenAI request ID/token counts when available, and Mealie verification status.
Source URLs, pasted text, screenshots, prompts, and recipe contents are not
logged. The browser includes the request ID in `/import/*` error messages so a
failed attempt can be matched to the server log.

## Local Development

Install dependencies:

```sh
pnpm install
```

Run the client and server in watch mode:

```sh
pnpm dev
```

Development mode starts:

- Vite client: `http://localhost:5173`
- Fastify API and WebSockets: `http://localhost:3100`

In this mode, the browser client sends API requests to
`http://localhost:3100`. Use it from the same machine. For iPad testing, use the
production serving flow below so requests and WebSockets stay on the same LAN
origin.

## LAN iPad Testing

Build and run the production server:

```sh
pnpm build
pnpm start
```

Find the Mac's LAN address, for example on Wi-Fi:

```sh
ipconfig getifaddr en0
```

Open `http://<lan-ip>:3100` on the first iPad, start a recipe from the planner
or recipe search, then open `http://<lan-ip>:3100/session` on the second iPad.
The setup panel on the cooking screen also provides a QR code and copyable link.

If the iPads cannot connect, check that the Mac and iPads are on the same
network and that macOS firewall settings allow inbound connections to Node.

## Production Build

Build client and server:

```sh
pnpm build
```

Run the built server:

```sh
pnpm start
```

`pnpm start` serves static files from `dist/client`, API routes under `/api`,
the protected importer API under `/import/parse` and `/import/confirm`, and
WebSockets under `/ws`. Any non-API route falls back to `index.html`, so `/`,
`/session`, and `/import` can all be loaded directly.

## Docker

Build the image:

```sh
docker build -t mealie-ipad-sync .
```

Run it with an env file and persistent SQLite storage:

```sh
docker run --rm \
  --env-file .env \
  -p 3100:3100 \
  -v "$PWD/data:/app/data" \
  mealie-ipad-sync
```

The container defaults to `PORT=3100` and `DATABASE_PATH=data/mealie-ipad-sync.sqlite`,
which resolves to `/app/data/mealie-ipad-sync.sqlite` in the image.

## Dokku

The existing deployment for this repo has used the Dokku app name `chef`.
Replace `chef` if you are creating a separate deployment.

Create the app and persistent storage:

```sh
dokku apps:create chef
dokku storage:ensure-directory chef
dokku storage:mount chef /var/lib/dokku/data/storage/chef:/app/data
```

Set configuration without printing secrets in logs or committed files:

```sh
dokku config:set chef \
  MEALIE_BASE_URL=https://mealie.example.com \
  MEALIE_API_TOKEN=replace-with-real-token \
  APP_TIME_ZONE=America/Phoenix \
  SESSION_MAX_AGE_HOURS=6
```

For imports behind Dokku nginx, set `TRUSTED_PROXIES` to the proxy peer IP
shown as `req.remoteAddress` in the app logs (the existing `chef` deployment
uses `172.17.0.1`):

```sh
dokku config:set chef TRUSTED_PROXIES=172.17.0.1
```

This comma-separated IP/CIDR allowlist lets Fastify use nginx's
`X-Forwarded-For` header for client IPs. Leave it unset for direct access.
Only include proxies you control that overwrite or safely append forwarded
headers. With another proxy ahead of nginx, nginx must also be configured to
forward the correct client address; trusting the Docker gateway alone cannot
recover an address nginx has discarded.

Deploy:

```sh
git remote add dokku dokku@<dokku-host>:chef
git push dokku main
```

For the existing `chef` deployment, the host database path is expected to be:

```text
/var/lib/dokku/data/storage/chef/mealie-ipad-sync.sqlite
```

Inside the container it is:

```text
/app/data/mealie-ipad-sync.sqlite
```

## Persistence and Backups

SQLite stores three main tables:

- `sessions`: recipe slug, name, active step, revision, and update timestamps.
- `ingredient_checks`: per-session ingredient checked state.
- `app_state`: app-level state, including the `global_session_id` pointer.

The current shared cooking session is only the `app_state.global_session_id`
pointer. When `SESSION_MAX_AGE_HOURS` expires, the app clears that pointer on
read and stops auto-resuming the old session. It does not delete `sessions` or
`ingredient_checks`.

Back up the database and its WAL sidecar files together when possible:

```text
data/mealie-ipad-sync.sqlite
data/mealie-ipad-sync.sqlite-shm
data/mealie-ipad-sync.sqlite-wal
```

When inspecting the database on a server, use `sqlite3`, not the legacy `sqlite`
binary:

```sh
sqlite3 /var/lib/dokku/data/storage/chef/mealie-ipad-sync.sqlite '.tables'
```

## Useful Routes

- `/`: planner and recipe search.
- `/session`: current global cooking session.
- `/api/planner/week`: current week planner data.
- `/api/recipes?query=...`: Mealie recipe search.
- `/api/recipes/:slug`: normalized recipe detail.
- `/api/global-session`: current shared cooking session.
- `/import`: recipe import UI.
- `/import/parse`: parse a URL, text payload, or screenshot multipart request.
- `/import/confirm`: validate an edited Schema.org draft and verify the Mealie write.
- `/ws`: global cooking-session WebSocket.
- `/ws/sessions/:sessionId`: direct session WebSocket.

The importer is intentionally not under `/api`. Put a Cloudflare Access or
reverse-proxy policy on `/import/*` to protect both parser and confirmation
requests. Configure the policy before exposing the server outside the trusted
LAN; the app itself does not provide authentication.

## Troubleshooting

Recipe import fails at `stage: "openai_request"`.

The toast distinguishes a rejected API key, model/resource access, invalid
request configuration, exhausted quota, upstream rate limiting, and transport
failures. These return 502 for rejected requests, 503 for temporary upstream
or quota failures, and 504 for timeouts. Internal errors return 500. Logs retain
`openaiStatus`, `openaiErrorCode`, `openaiErrorType`, `openaiErrorParam`,
`openaiErrorName`, and `openaiRequestId` when provided by the SDK. Use the
OpenAI request ID to correlate provider diagnostics; the app request ID still
appears in the toast. Raw provider messages, headers, credentials, and recipe
content are not logged.

Recipe import returns HTTP 429 with `stage: "rate_limit"`.

This is the app's local limit of five parse attempts per client IP per
15-minute window, including failed attempts. The request is rejected before
fetching a recipe page or calling OpenAI. Behind Dokku, configure
`TRUSTED_PROXIES` as above so all requests do not share the Docker gateway's
quota. Clients sharing a public IP still share a quota. The response includes
`Retry-After` in seconds and the error message gives the remaining wait in
minutes. Logs include the limit, request count, window, and remaining wait.
Rejected attempts do not extend the window. Earlier failures may have consumed
the quota; inspect earlier `recipe import failed` entries for their stage and
error code. The limiter is held in memory per app process and resets on restart.

`Mealie is not configured. Set MEALIE_BASE_URL and MEALIE_API_TOKEN.`

Set both required Mealie variables and restart the server.

`No recipe is active yet. Start one from the planner.`

Open `/`, start a recipe from the weekly planner or recipe search, then join
`/session` on the other iPad.

Planner `Today` is wrong.

Set `APP_TIME_ZONE` to the kitchen's IANA time zone, for example
`America/Phoenix`, then restart.

The page loads on an iPad but API calls or sync fail.

Use the production serving flow for LAN testing: `pnpm build` then `pnpm start`,
and open `http://<lan-ip>:3100`. The Vite dev client is intended for the same
machine because it points API calls at `localhost:3100`.

WebSockets connect and then drop later.

The server sends heartbeat messages every 25 seconds and the client reconnects
automatically. If drops still happen in production, check reverse proxy or
platform idle timeouts and make sure `/ws` supports WebSocket upgrades.

SQLite says the file is encrypted or is not a database.

Confirm you are using `sqlite3` and inspecting the mounted database path, not
the older `sqlite` binary or an empty file outside the persistent mount.
