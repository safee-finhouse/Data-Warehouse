-- Migration: 004_core_ops_schema.sql
-- Introduces proper schemas (core + ops) and operational tracking tables.
-- Also migrates existing public.xero_connections data into the new schema.

-- ─── Schemas ──────────────────────────────────────────────────────────────────

CREATE SCHEMA IF NOT EXISTS core;
CREATE SCHEMA IF NOT EXISTS ops;

-- ─── core.tenants ─────────────────────────────────────────────────────────────
-- Top-level billing/account unit. One row per business using Finhouse.
-- All other records reference a tenant, enabling multi-tenancy from day one.

CREATE TABLE core.tenants (
  id         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  name       TEXT        NOT NULL,
  slug       TEXT        NOT NULL UNIQUE,  -- URL-safe identifier
  is_active  BOOLEAN     NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ─── core.xero_connections ────────────────────────────────────────────────────
-- One row per Xero organisation connected to a tenant.
-- Replaces public.xero_connections with proper tenant linkage.

CREATE TABLE core.xero_connections (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        UUID        NOT NULL REFERENCES core.tenants(id),
  token_id         UUID        NOT NULL REFERENCES public.xero_tokens(id),
  xero_tenant_id   TEXT        NOT NULL UNIQUE,  -- Xero's org UUID (Xero-Tenant-Id header)
  xero_tenant_name TEXT        NOT NULL,
  xero_tenant_type TEXT        NOT NULL DEFAULT 'ORGANISATION',
  is_active        BOOLEAN     NOT NULL DEFAULT true,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX core_xero_connections_tenant_id_idx ON core.xero_connections (tenant_id);

-- ─── ops.sync_runs ────────────────────────────────────────────────────────────
-- One row per sync execution. Tracks overall status, duration, and errors.
-- Powers the sync history view in the admin dashboard.

CREATE TABLE ops.sync_runs (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  connection_id UUID        NOT NULL REFERENCES core.xero_connections(id),
  tenant_id     UUID        NOT NULL REFERENCES core.tenants(id),
  status        TEXT        NOT NULL DEFAULT 'pending'
                            CHECK (status IN ('pending', 'running', 'completed', 'failed')),
  triggered_by  TEXT        NOT NULL DEFAULT 'manual'
                            CHECK (triggered_by IN ('manual', 'scheduled', 'webhook')),
  started_at    TIMESTAMPTZ,
  completed_at  TIMESTAMPTZ,
  duration_ms   INT,
  error         TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX ops_sync_runs_connection_id_idx ON ops.sync_runs (connection_id);
CREATE INDEX ops_sync_runs_tenant_id_idx     ON ops.sync_runs (tenant_id);
CREATE INDEX ops_sync_runs_status_idx        ON ops.sync_runs (status);
CREATE INDEX ops_sync_runs_created_at_idx    ON ops.sync_runs (created_at DESC);

-- ─── ops.sync_run_steps ───────────────────────────────────────────────────────
-- One row per entity (invoices, contacts, payments…) within a sync run.
-- Allows per-entity progress tracking and granular error reporting.

CREATE TABLE ops.sync_run_steps (
  id             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  sync_run_id    UUID        NOT NULL REFERENCES ops.sync_runs(id) ON DELETE CASCADE,
  entity         TEXT        NOT NULL,  -- e.g. 'invoices', 'contacts', 'payments'
  status         TEXT        NOT NULL DEFAULT 'pending'
                             CHECK (status IN ('pending', 'running', 'completed', 'failed', 'skipped')),
  records_synced INT         NOT NULL DEFAULT 0,
  records_failed INT         NOT NULL DEFAULT 0,
  started_at     TIMESTAMPTZ,
  completed_at   TIMESTAMPTZ,
  error          TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX ops_sync_run_steps_sync_run_id_idx ON ops.sync_run_steps (sync_run_id);

-- ─── ops.sync_checkpoints ────────────────────────────────────────────────────
-- Stores the incremental sync cursor per entity per connection.
-- "last_modified_at" is the timestamp used as If-Modified-Since on the next run.
-- Eliminates the MAX(updated_date_utc) query approach.

CREATE TABLE ops.sync_checkpoints (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  connection_id    UUID        NOT NULL REFERENCES core.xero_connections(id),
  entity           TEXT        NOT NULL,
  last_modified_at TIMESTAMPTZ,                       -- cursor for next incremental sync
  last_run_id      UUID        REFERENCES ops.sync_runs(id),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (connection_id, entity)
);

CREATE INDEX ops_sync_checkpoints_connection_id_idx ON ops.sync_checkpoints (connection_id);

-- ─── ops.upload_batches ───────────────────────────────────────────────────────
-- Tracks batches of records being loaded into the warehouse.
-- Covers both Xero sync batches and future manual CSV/API uploads.
-- Useful for audit trails and dashboard data freshness indicators.

CREATE TABLE ops.upload_batches (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    UUID        NOT NULL REFERENCES core.tenants(id),
  sync_run_id  UUID        REFERENCES ops.sync_runs(id),
  entity       TEXT        NOT NULL,
  status       TEXT        NOT NULL DEFAULT 'pending'
               CHECK (status IN ('pending', 'processing', 'completed', 'failed')),
  record_count INT         NOT NULL DEFAULT 0,
  source       TEXT        NOT NULL DEFAULT 'xero'
               CHECK (source IN ('xero', 'csv', 'api')),
  metadata     JSONB,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX ops_upload_batches_tenant_id_idx   ON ops.upload_batches (tenant_id);
CREATE INDEX ops_upload_batches_sync_run_id_idx ON ops.upload_batches (sync_run_id);
CREATE INDEX ops_upload_batches_status_idx      ON ops.upload_batches (status);

-- ─── Migrate existing data ────────────────────────────────────────────────────
-- Promote existing public.xero_connections rows into the new schema.
-- Creates one core.tenant per distinct Xero organisation already connected.

-- Drop the FK so we can re-point xero_invoices.connection_id to core.xero_connections
ALTER TABLE public.xero_invoices
  DROP CONSTRAINT IF EXISTS xero_invoices_connection_id_fkey;

-- Create a tenant for each existing connection
INSERT INTO core.tenants (name, slug)
SELECT
  tenant_name,
  lower(regexp_replace(tenant_name, '[^a-zA-Z0-9]+', '-', 'g'))
FROM public.xero_connections
ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name, updated_at = now();

-- Migrate connections, linking to their new tenant rows
INSERT INTO core.xero_connections
  (tenant_id, token_id, xero_tenant_id, xero_tenant_name, xero_tenant_type, is_active, created_at, updated_at)
SELECT
  t.id,
  xc.token_id,
  xc.tenant_id,       -- xc.tenant_id is Xero's org UUID
  xc.tenant_name,
  xc.tenant_type,
  xc.is_active,
  xc.created_at,
  xc.updated_at
FROM public.xero_connections xc
JOIN core.tenants t
  ON t.slug = lower(regexp_replace(xc.tenant_name, '[^a-zA-Z0-9]+', '-', 'g'))
ON CONFLICT (xero_tenant_id) DO NOTHING;

-- Re-point xero_invoices.connection_id to new core.xero_connections IDs
UPDATE public.xero_invoices xi
SET connection_id = cxc.id
FROM public.xero_connections pxc
JOIN core.xero_connections cxc ON cxc.xero_tenant_id = pxc.tenant_id
WHERE xi.connection_id = pxc.id;

-- Re-add FK now pointing at core schema
ALTER TABLE public.xero_invoices
  ADD CONSTRAINT xero_invoices_connection_id_fkey
  FOREIGN KEY (connection_id) REFERENCES core.xero_connections(id);
