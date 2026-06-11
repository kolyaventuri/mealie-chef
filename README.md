# Mealie Chef 

LAN-hosted synchronized Mealie cooking display for iPads. The app reads meal
plans and recipes from Mealie, starts a shared cooking session, and keeps joined
screens on the same recipe step with synced ingredient checkoffs.

## Features

- Weekly planner from Mealie, with an app-configured `Today` date.
- Recipe search against Mealie.
- Shared `/session` cooking screen for one or more iPads.
- WebSocket sync for the active step, ingredient checkoffs, presence, and
  reconnects.
- Persistent SQLite session state, including historical sessions and ingredient
  progress.
- QR code and copyable session link for joining another iPad.
- Cook mode using the browser Screen Wake Lock API when available.
- Light and dark themes.

## Stack

- React 19, Vite, and Tailwind CSS for the iPad UI.
- Fastify for the API, static file serving, and WebSockets.
- Node's built-in `node:sqlite` API for local persistence.
- `pnpm` for package management, `xo` for linting, and `vitest` for tests.
- Docker image based on Node 24.

## Quick Start

Requirements:

- Node.js 24 LTS or another supported Node release. The Docker image uses
  `node:24-alpine`.
- pnpm 10.x. This repo pins `pnpm@10.29.3` in `package.json`.
- A reachable Mealie instance and API token.

Install dependencies and create local config:

```sh
pnpm install
cp .env.example .env
```

Edit `.env` with your Mealie URL and token, then start development mode:

```sh
pnpm dev
```

Development mode serves the Vite client at `http://localhost:5173` and the
Fastify API at `http://localhost:3100`.

For actual iPad testing on the LAN, build the client and serve everything from
Fastify so the browser uses the same origin for HTTP and WebSockets:

```sh
pnpm build
pnpm start
```

Then open `http://<your-mac-lan-ip>:3100` on the iPads.

## Common Commands

```sh
pnpm dev          # Run Vite and the Fastify server in watch mode
pnpm build        # Build client and server into dist/
pnpm start        # Run the production server from dist/
pnpm test         # Run Vitest once
pnpm test:watch   # Run Vitest in watch mode
pnpm lint         # Run XO
pnpm typecheck    # Type-check client and server configs
```

## How It Works

The planner page at `/` fetches the current Mealie week and lets you start a
recipe from the planner or recipe search. Starting a recipe creates a global
cooking session and navigates to `/session`.

Every iPad on `/session` joins the current global session. Step changes and
ingredient checkoffs are written to SQLite and broadcast over WebSockets. If a
socket drops, the client reconnects and receives the latest snapshot.

The current shared session is a pointer stored in SQLite `app_state`. The
underlying `sessions` and `ingredient_checks` rows are kept as history. The
`SESSION_MAX_AGE_HOURS` setting only expires the current global-session pointer
when the session has not been updated recently.

## Documentation

See [docs/SETUP.md](docs/SETUP.md) for full setup, configuration, deployment,
persistence, and troubleshooting notes.

## Security

This app has no built-in user authentication. Run it on a trusted LAN or behind
access controls. Keep `MEALIE_API_TOKEN` in environment variables or local
`.env` files, never in committed files.
