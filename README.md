# Finhouse Warehouse

The shared data warehouse and Xero sync service for Finhouse. Pulls financial data from Xero into a structured PostgreSQL warehouse and exposes it via a typed REST API.

Deployed on Railway. Designed to be the single source of truth for Finhouse's accounting data.

---

## Architecture

```
Xero API
   │
   ▼
xero.client.ts       ← typed async-generator API client (paginated, retry/backoff)
xero.auth.ts         ← OAuth2 flow (HMAC-signed state, token refresh)
token.store.ts       ← token persistence + auto-refresh
   │
   ▼
sync/                ← incremental sync engine
  invoices.ts        ← paginated invoice sync with If-Modified-Since cursor
  sync.service.ts    ← orchestrates sync runs, writes to ops schema
   │
   ▼
PostgreSQL (Railway)
  core.*             ← tenants, xero_connections
  ops.*              ← sync_runs, sync_run_steps, sync_checkpoints, upload_batches
  public.*           ← xero_invoices (JSONB raw + typed columns)
```

**Stack**

| Layer | Choice |
|---|---|
| Runtime | Node.js 20 + TypeScript |
| Server | Fastify + @fastify/sensible |
| Database | PostgreSQL via `postgres` driver (no ORM) |
| Validation | Zod (env vars) |
| Testing | Vitest (unit + integration) |
| Deployment | Railway (Docker) |

---

## Build status

| Stage | Status |
|---|---|
| 1 — Project scaffolding (Fastify, health endpoint, Dockerfile, Railway config) | Done |
| 2 — Database layer (postgres client, SQL migration runner) | Done |
| 3 — Xero OAuth2 + invoice sync (token store, paginated sync, ops schema) | Done |
| 4 — Core operational schema (core.tenants, core.xero_connections, ops.*) | Done |
| 5 — Xero API client layer (typed generators, retry/backoff, modifiedAfter) | Done |
| 6 — Full entity sync (contacts, payments, bank transactions, accounts) | Planned |
| 7 — Upload pipeline (batch uploads, ops.upload_batches) | Planned |
| 8 — Admin API + reporting queries | Planned |

---

## Local setup

**Prerequisites:** Node.js 20+, PostgreSQL 14+

```bash
# 1. Clone and install
git clone <repo-url>
cd warehouse
npm install

# 2. Configure environment
cp .env.example .env
# Edit .env — see Environment variables section below

# 3. Create the database
createdb finhouse
# (or: psql -U postgres -c "CREATE DATABASE finhouse;")

# 4. Run migrations
npm run migrate

# 5. Start the dev server
npm run dev
# → http://localhost:3000/health
```

---

## Environment variables

Copy `.env.example` to `.env` and fill in real values. Never commit `.env`.

| Variable | Description |
|---|---|
| `NODE_ENV` | `development` or `production` |
| `PORT` | HTTP port (default `3000`) |
| `APP_SECRET` | Min 32-char secret for HMAC state signing |
| `DATABASE_URL` | PostgreSQL connection string |
| `XERO_CLIENT_ID` | From your Xero developer app |
| `XERO_CLIENT_SECRET` | From your Xero developer app |
| `XERO_REDIRECT_URI` | Must match your Xero app's redirect URI config |

**Xero app setup:** Create an app at https://developer.xero.com/app/manage. Add the redirect URI. The app requires these OAuth2 scopes (configured in code — no action needed):
`openid`, `profile`, `email`, `offline_access`, `accounting.settings.read`, `accounting.contacts.read`, `accounting.invoices.read`, `accounting.payments.read`, `accounting.banktransactions.read`

---

## Scripts

| Command | Description |
|---|---|
| `npm run dev` | Start dev server with hot reload (`tsx watch`) |
| `npm run build` | Compile TypeScript → `dist/` |
| `npm start` | Run compiled production build |
| `npm run typecheck` | Type-check without emitting |
| `npm test` | Run all tests (unit + integration) |
| `npm run test:watch` | Run tests in watch mode |
| `npm run migrate` | Apply pending SQL migrations |
| `npm run migrate:create` | Scaffold the next numbered migration file |
| `npm run lint` | Run ESLint |

---

## Database migrations

Migrations live in `migrations/` as sequential SQL files (`001_*.sql`, `002_*.sql`, ...).

The runner applies them in alphabetical order and tracks applied migrations in a `schema_migrations` table. Migrations are wrapped in a transaction — if one fails, it rolls back cleanly.

```bash
# Apply pending migrations
npm run migrate

# Create a new migration file
npm run migrate:create name_of_migration
# → creates migrations/005_name_of_migration.sql
```

Current migrations:
- `001_initial.sql` — baseline organisations table
- `002_xero_connections.sql` — xero_tokens, public.xero_connections
- `003_xero_invoices.sql` — xero_invoices with JSONB raw column
- `004_core_ops_schema.sql` — core.tenants, core.xero_connections, ops.* schema

---

## API routes

```
GET  /health                          → { status, db, uptime }
GET  /ready                           → { ready: true }

GET  /xero/connect                    → redirect to Xero OAuth
GET  /xero/callback                   → OAuth callback handler
GET  /xero/connections                → list connected Xero orgs
DELETE /xero/connections/:id          → disconnect an org

POST /sync/connections/:id/run        → trigger a sync for a connection
GET  /sync/connections                → list connections with sync stats
GET  /sync/runs                       → list recent sync runs
GET  /sync/runs/:id                   → sync run detail with steps
```

---

## Deployment (Railway)

1. Create a Railway project and add a PostgreSQL service.
2. Link your GitHub repo — Railway builds via `Dockerfile`.
3. Set environment variables from `.env.example` in the Railway dashboard.
   Railway provides `DATABASE_URL` automatically.
4. After each deploy, run migrations:
   ```bash
   railway run npm run migrate
   ```
5. The healthcheck endpoint is `GET /health` — Railway polls this to confirm deployment.

---

## Project structure

```
src/
  config/           env validation (Zod)
  db/               postgres client, migration runner, migration scaffolder
  lib/              shared utilities (structured logger)
  modules/
    health/         /health and /ready endpoints
    xero/           OAuth2 flow, token store, API client, typed generators
    sync/           sync orchestration, invoice sync, ops schema writes
  types/            shared TypeScript types (common + Xero API shapes)
migrations/         sequential .sql files applied by the migration runner
tests/
  unit/             pure function tests (parseXeroDate, OAuth state)
  integration/      Fastify inject() API tests + real-DB schema tests
```
