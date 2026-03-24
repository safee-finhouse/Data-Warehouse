# Finhouse Warehouse

The data warehouse and Xero sync service for Finhouse. Pulls financial data from Xero into a structured PostgreSQL warehouse, exposes it via a typed REST API, and serves an admin dashboard for operational visibility.

Deployed on Railway. This is the single source of truth for all accounting data in Finhouse.

---

## Architecture

```
Xero API
   │
   ▼  xero.client.ts      typed async-generator client (paginated, retry, backoff)
      xero.auth.ts        OAuth2 PKCE flow + HMAC-signed state
      token.store.ts      token persistence + auto-refresh
   │
   ▼  sync/               incremental sync engine
      sync.service.ts     orchestrates entity syncs, writes ops schema records
      entities/           invoices, contacts, payments, accounts, bank tx, journals
      reports.ts          Trial Balance, P&L, Balance Sheet snapshots
   │
   ▼  raw_xero.*          JSONB + extracted columns, one table per entity
   │
   ▼  transform/          bulk INSERT…SELECT transforms, idempotent
      dims/               dim_tenant, dim_contact, dim_account
      facts/              fact_invoice, fact_invoice_line, fact_payment, …
      reports/            fact_trial_balance_snapshot, fact_profit_and_loss_snapshot, …
   │
   ▼  warehouse.*         typed star schema — no raw JSON
   │
   ▼  warehouse views     vw_overdue_invoices, vw_invoice_ageing, vw_payment_history,
                          vw_profit_and_loss_by_period, vw_balance_sheet_by_period,
                          vw_trial_balance_by_period
   │
   ▼  Downstream tools    query views, never tables directly
```

**Three-layer data model**

| Layer | Schema | Contents | Consumers |
|---|---|---|---|
| Raw | `raw_xero.*` | JSONB payloads + extracted columns, append-only | Transform only |
| Warehouse | `warehouse.*` | Typed star schema (dims + facts), no JSON | Views only |
| Views | `warehouse.vw_*` | Pre-joined, tenant-safe query surfaces | Tools, dashboard |

**Stack**

| Layer | Choice |
|---|---|
| Runtime | Node.js 20 + TypeScript |
| Server | Fastify + @fastify/sensible |
| Database | PostgreSQL via `postgres` driver (no ORM) |
| Validation | Zod (env vars) |
| Testing | Vitest — 110 tests (unit + integration) |
| Deployment | Railway (Docker, multi-stage) |

---

## Local setup

**Prerequisites:** Node.js 20+, PostgreSQL 14+

```bash
# 1. Clone and install
git clone https://github.com/safee-finhouse/Data-Warehouse.git
cd Data-Warehouse
npm install

# 2. Configure environment
cp .env.example .env
# Edit .env — fill in DATABASE_URL, Xero credentials, APP_SECRET

# 3. Create the database
createdb finhouse

# 4. Run all migrations
npm run migrate

# 5. Start dev server
npm run dev
# → http://localhost:3000/health
```

---

## Environment variables

Copy `.env.example` → `.env`. Never commit `.env`.

| Variable | Required | Description |
|---|---|---|
| `NODE_ENV` | — | `development` or `production` (default: `development`) |
| `PORT` | — | HTTP port (default: `3000`) |
| `APP_SECRET` | ✓ | Min 32 chars — signs Xero OAuth state. `openssl rand -hex 32` |
| `DATABASE_URL` | ✓ | PostgreSQL connection string. Railway provides this automatically. |
| `XERO_CLIENT_ID` | ✓ | From your Xero developer app |
| `XERO_CLIENT_SECRET` | ✓ | From your Xero developer app |
| `XERO_REDIRECT_URI` | ✓ | Must match your Xero app settings. Prod: `https://<domain>/xero/callback` |
| `SCHEDULER_ENABLED` | — | `true`/`false` — disable in staging (default: `true`) |
| `SYNC_FULL_CRON` | — | Cron for nightly full sync (default: `0 2 * * *` — 2 AM UTC) |
| `SYNC_INCREMENTAL_CRON` | — | Cron for incremental sync (default: `*/20 * * * *` — every 20 min) |
| `LOG_LEVEL` | — | `debug`/`info`/`warn`/`error` (default: `info`) |

**Xero app setup:** Create an app at `https://developer.xero.com/app/manage`. Required scopes (configured in code):
`openid`, `profile`, `email`, `offline_access`, `accounting.settings.read`, `accounting.contacts.read`, `accounting.invoices.read`, `accounting.payments.read`, `accounting.banktransactions.read`

---

## Scripts

| Command | Description |
|---|---|
| `npm run dev` | Dev server with hot reload (`tsx watch`) |
| `npm run build` | Compile TypeScript → `dist/` |
| `npm start` | Run compiled production build |
| `npm test` | Run all 110 tests (unit + integration) |
| `npm run test:watch` | Tests in watch mode |
| `npm run typecheck` | Type-check without emitting |
| `npm run migrate` | Apply pending SQL migrations |
| `npm run migrate:create` | Scaffold next numbered migration file |
| `npm run sync:all` | Manually trigger a full sync for all tenants |
| `npm run lint` | ESLint |

---

## Database migrations

Migrations live in `migrations/` as sequential SQL files. The runner applies them in order and tracks applied files in `schema_migrations`. Each migration runs in a transaction — failures roll back cleanly.

```bash
npm run migrate                          # apply pending
npm run migrate:create add_budget_table  # scaffold migrations/011_add_budget_table.sql
```

| File | Contents |
|---|---|
| `001_initial.sql` | Baseline `organisations` table |
| `002_xero_connections.sql` | `xero_tokens`, `public.xero_connections` |
| `003_xero_invoices.sql` | `xero_invoices` with JSONB raw column |
| `004_core_ops_schema.sql` | `core.tenants`, `core.xero_connections`, `ops.*` |
| `005_raw_xero_schema.sql` | `raw_xero.*` — 7 entity tables with JSONB |
| `006_warehouse_schema.sql` | `warehouse.*` — dims + facts (typed, no JSON) |
| `007_report_snapshots.sql` | `raw_xero.report_snapshots`, warehouse fact tables for TB/P&L/BS |
| `008_warehouse_views.sql` | 6 queryable views over the warehouse layer |
| `009_manual_inputs.sql` | `manual_inputs.*` — CSV upload pipeline tables |
| `010_admin_views.sql` | `ops.vw_dashboard_metrics`, `vw_sync_run_summary`, `vw_tenant_freshness` |

---

## API reference

```
# Health
GET  /health         → { status, db, warehouse, migrations_applied, uptime, version }
GET  /ready          → { ready: true }

# Xero OAuth
GET  /xero/connect                → redirect to Xero OAuth
GET  /xero/callback               → OAuth callback handler
GET  /xero/connections            → list connected Xero orgs
DELETE /xero/connections/:id      → disconnect an org

# Sync (manual triggers)
POST /sync/run/all                → sync all active connections
POST /sync/connections/:id/run   → sync one connection

# Sync history
GET  /sync/connections            → connections with last run stats
GET  /sync/runs                   → recent sync runs (?limit=)
GET  /sync/runs/:id               → run detail with per-entity steps

# Transform (manual trigger)
POST /transform/connections/:id/run

# Manual uploads
POST /manual-inputs/upload        → { tenantId, filename, rows[], currencyCode? }
GET  /manual-inputs/:batchId/lines
PATCH /manual-inputs/lines/:lineId

# Admin dashboard API
GET  /admin/metrics               → system-wide health snapshot
GET  /admin/tenants               → per-connection status + freshness
GET  /admin/sync/history          → paginated runs (?limit, ?status, ?tenantId)
GET  /admin/sync/history/:id      → run detail + steps
GET  /admin/freshness             → per-entity freshness (?tenantId, ?staleOnly=true)
GET  /admin/uploads               → CSV batches (?tenantId, ?status, ?limit)
GET  /admin/errors                → unified failure list (?hours=, ?limit=)
```

---

## Scheduler

On startup the scheduler registers two cron jobs (configurable via env):

| Job | Default | Description |
|---|---|---|
| Full sync | `0 2 * * *` (2 AM UTC) | Syncs all entities for every active connection |
| Incremental | `*/20 * * * *` (every 20 min) | Syncs only changes since the last checkpoint |

An in-memory concurrency guard prevents overlapping runs. Incremental syncs are skipped if a full sync is running.

Set `SCHEDULER_ENABLED=false` to disable both jobs (useful in staging).

Manual trigger: `npm run sync:all`

---

## Deployment on Railway

### First deploy

1. Create a Railway project. Add a **PostgreSQL** plugin — Railway injects `DATABASE_URL` automatically.
2. Connect your GitHub repo. Railway detects the `Dockerfile` and builds automatically.
3. Set environment variables in the Railway dashboard (all variables from `.env.example`).
4. After the first deploy, run migrations:
   ```bash
   railway run npm run migrate
   ```
5. Connect your Xero org by visiting `https://<your-domain>/xero/connect`.

### Subsequent deploys

Push to `main` — Railway builds and deploys automatically. Migrations run automatically on startup via the `npm run migrate` command if you add it to the start command, **or** run them manually with `railway run npm run migrate`.

### Health checks

Railway polls `GET /health` every 30 seconds. The endpoint checks:
- PostgreSQL connectivity
- `warehouse` schema is queryable
- Returns `503` if either check fails (Railway will not route traffic)

The Dockerfile also includes a `HEALTHCHECK` instruction for container-level health monitoring.

### Rollback

Railway keeps previous deployments. To rollback: open the deployment tab and redeploy the previous version. If a migration was applied, roll it back manually in `railway connect` (psql) before redeploying.

---

## How the team uses this repo

### Connecting a new client to Xero

1. Create a `core.tenants` row for the client (or let the OAuth flow do it).
2. Visit `https://<domain>/xero/connect` and authorise the client's Xero org.
3. The first sync runs automatically after OAuth completes.
4. Check sync status at the admin dashboard: `https://warehouse-admin.<domain>/`.

### Adding a new entity type

1. Add a table to `raw_xero.*` in a new migration.
2. Create a sync file in `src/modules/sync/entities/`.
3. Wire it into `sync.service.ts`.
4. Create the warehouse dim or fact table in a new migration.
5. Write the transform in `src/modules/transform/`.
6. Add the transform step to `transform.service.ts`.
7. Add a view in `warehouse.*` if downstream tools need it.

### Running the tests

```bash
npm test              # run all 110 tests
npm run test:watch    # watch mode during development
```

Tests require a local PostgreSQL database (`DATABASE_URL` in `.env`).

### Debugging a failed sync

1. Check `GET /admin/errors` or the Errors page in the admin dashboard.
2. Find the failed run in `GET /admin/sync/history?status=failed`.
3. Click through to the run detail — step-level errors show exactly which entity failed.
4. Check Railway logs for the full stack trace.

### Adding a new migration

```bash
npm run migrate:create description_of_change
# → creates migrations/011_description_of_change.sql
# Edit the file, then:
npm run migrate
```

---

## How tools query the warehouse

**Rule: tools query views, not tables.**

Views hide join complexity, enforce tenant isolation, and provide a stable query surface that survives schema changes behind them.

### Views and their use cases

| View | Use case | Key filter |
|---|---|---|
| `vw_overdue_invoices` | Aged debt dashboard, collections workflow | `WHERE tenant_id = $1` |
| `vw_invoice_ageing` | Ageing buckets (0–30, 31–60, 61–90, 90+ days) | `WHERE tenant_id = $1 AND type = 'ACCREC'` |
| `vw_payment_history` | Cash flow, payment reconciliation, bank matching | `WHERE tenant_id = $1 AND date BETWEEN $2 AND $3` |
| `vw_profit_and_loss_by_period` | P&L comparison, month-over-month trends | `WHERE tenant_id = $1 ORDER BY period_to, section, row_order` |
| `vw_balance_sheet_by_period` | Net worth tracking, equity monitoring | `WHERE tenant_id = $1 ORDER BY period_date, section, sub_section, row_order` |
| `vw_trial_balance_by_period` | Audit tools, chart-of-accounts reconciliation | `WHERE tenant_id = $1 AND period_date = $2` |

### Tenant isolation

Every view has a `tenant_id` column. **Always filter by `tenant_id`** — this is the boundary between clients' data.

```sql
-- Correct
SELECT * FROM warehouse.vw_overdue_invoices
WHERE tenant_id = '550e8400-e29b-41d4-a716-446655440000';

-- Never do this — exposes all tenants' data
SELECT * FROM warehouse.vw_overdue_invoices;
```

### Example queries

**Aged debt — all overdue invoices for a client, worst first:**
```sql
SELECT
  invoice_number, contact_name, amount_due, days_overdue, due_date
FROM warehouse.vw_overdue_invoices
WHERE tenant_id = $1
  AND type = 'ACCREC'  -- receivables only
ORDER BY days_overdue DESC;
```

**Ageing summary — bucket totals for a receivables report:**
```sql
SELECT
  ageing_bucket,
  COUNT(*)          AS invoice_count,
  SUM(amount_due)   AS total_due
FROM warehouse.vw_invoice_ageing
WHERE tenant_id = $1
  AND type = 'ACCREC'
GROUP BY ageing_bucket
ORDER BY
  CASE ageing_bucket
    WHEN 'current' THEN 0 WHEN '1-30' THEN 1
    WHEN '31-60'   THEN 2 WHEN '61-90' THEN 3 ELSE 4
  END;
```

**P&L for a specific month:**
```sql
SELECT
  section, account_name, value, row_type
FROM warehouse.vw_profit_and_loss_by_period
WHERE tenant_id = $1
  AND period_to = '2025-03-31'
ORDER BY section, row_order;
```

**P&L last 12 months — one column per period:**
```sql
SELECT
  account_name,
  MAX(CASE WHEN period_label = 'Jan 2025' THEN value END) AS jan_25,
  MAX(CASE WHEN period_label = 'Feb 2025' THEN value END) AS feb_25,
  MAX(CASE WHEN period_label = 'Mar 2025' THEN value END) AS mar_25
FROM warehouse.vw_profit_and_loss_by_period
WHERE tenant_id = $1
  AND row_type = 'row'
GROUP BY account_name
ORDER BY account_name;
```

**Trial Balance for a specific date:**
```sql
SELECT
  account_name, debit, credit, ytd_debit, ytd_credit
FROM warehouse.vw_trial_balance_by_period
WHERE tenant_id = $1
  AND period_date = '2025-03-31'
  AND row_type = 'row'
ORDER BY account_name;
```

**Payment history for a date range:**
```sql
SELECT
  payment_date, amount, contact_name, account_code, account_name, reference
FROM warehouse.vw_payment_history
WHERE tenant_id = $1
  AND payment_date BETWEEN '2025-01-01' AND '2025-03-31'
ORDER BY payment_date DESC;
```

### Data freshness

The warehouse is updated after every sync. Syncs run:
- Every 20 minutes (incremental — fetches only changes)
- Nightly at 2 AM UTC (full — all entities)

Check freshness programmatically:
```sql
SELECT entity, last_modified_at, freshness_status
FROM ops.vw_tenant_freshness
WHERE tenant_id = $1
ORDER BY entity;
```

If `freshness_status = 'stale'` (no sync in 25+ hours), the data may be out of date. Surface this in tools that display financial data.

### Manual inputs (uncoded statement lines)

Tool 5 (statement coding) uses `manual_inputs.uncoded_statement_lines`:

```sql
-- Lines awaiting coding for a tenant
SELECT id, date, description, amount, currency_code
FROM manual_inputs.uncoded_statement_lines
WHERE tenant_id = $1
  AND approved = false
ORDER BY date DESC;

-- After the accountant codes a line
UPDATE manual_inputs.uncoded_statement_lines
SET
  account_code  = $2,
  account_name  = $3,
  category      = $4,
  approved      = true,
  approved_by   = $5,
  approved_at   = now()
WHERE id = $1;
```

---

## Project structure

```
src/
  config/               env validation (Zod)
  db/                   postgres client, migration runner, scaffolder
  lib/                  shared utilities (structured logger)
  modules/
    health/             /health and /ready endpoints
    xero/               OAuth2 flow, token store, typed API client
    sync/               sync orchestrator, entity syncers, reports fetcher
    transform/          dims/, facts/, reports/ transforms
    manual-inputs/      CSV upload pipeline (store → normalise → upsert)
    admin/              admin dashboard API routes
  scripts/              sync-all.ts — manual trigger
  types/                shared TypeScript types + Xero API shapes
migrations/             sequential .sql files
tests/
  unit/                 xero.auth, xero.api, normalise, parse-report (61 tests)
  integration/          db schema, API routes, admin API (49 tests)
```
