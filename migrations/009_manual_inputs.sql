-- Migration: 009_manual_inputs.sql
-- Manual input tables for uncoded bank statement lines and client metadata.
--
-- Purpose:
--   Some transactions can't be reconciled automatically against Xero data.
--   This schema captures CSV uploads of unmatched bank statement lines and
--   stores client-specific metadata used by Tool 5 (statement coding tool).
--
-- Flow:
--   1. User uploads CSV  → manual_inputs.upload_batches (header)
--                        → manual_inputs.uncoded_statement_line_uploads (raw rows)
--   2. Tool 5 processes  → manual_inputs.uncoded_statement_lines (normalised, enriched)
--   3. Accountant codes  → lines get a category, account code, and approved flag
--   4. Downstream tools  → query uncoded_statement_lines WHERE approved = true
--
-- Table map:
--   client_business_types        → lookup: business type labels
--   client_metadata              → per-tenant settings (currency, fiscal year, etc.)
--   upload_batches               → one row per file upload
--   uncoded_statement_line_uploads → raw CSV rows verbatim (JSONB)
--   uncoded_statement_lines      → normalised, codeable rows (Tool 5 primary table)

CREATE SCHEMA IF NOT EXISTS manual_inputs;

-- ─── client_business_types ───────────────────────────────────────────────────
-- Lookup table: business type labels used for category suggestions in Tool 5.
-- Created first so client_metadata can reference it.

CREATE TABLE manual_inputs.client_business_types (
  id          SERIAL      PRIMARY KEY,
  name        TEXT        NOT NULL UNIQUE,
  description TEXT        NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO manual_inputs.client_business_types (name, description) VALUES
  ('Retail',                 'Product sales to consumers'),
  ('E-commerce',             'Online product sales'),
  ('Professional Services',  'Consulting, legal, accountancy'),
  ('Construction',           'Building, trades, contracting'),
  ('Hospitality',            'Restaurants, cafes, hotels'),
  ('Healthcare',             'Medical, dental, therapy practices'),
  ('Technology',             'Software, SaaS, IT services'),
  ('Manufacturing',          'Production and assembly'),
  ('Property',               'Lettings, estate agents, developers'),
  ('Charity / Non-profit',   'Registered charities and social enterprises'),
  ('Other',                  'Catch-all for uncategorised businesses');

-- ─── client_metadata ─────────────────────────────────────────────────────────
-- Per-tenant configuration used by Tool 5 and downstream reporting tools.
-- One row per tenant. Upserted whenever a tenant updates their settings.

CREATE TABLE manual_inputs.client_metadata (
  tenant_id             UUID        PRIMARY KEY REFERENCES core.tenants(id) ON DELETE CASCADE,
  business_type_id      INTEGER     NULL REFERENCES manual_inputs.client_business_types(id),
  base_currency         TEXT        NOT NULL DEFAULT 'GBP',
  fiscal_year_end_month INTEGER     NOT NULL DEFAULT 3   -- 3 = March (UK default)
                        CHECK (fiscal_year_end_month BETWEEN 1 AND 12),
  vat_registered        BOOLEAN     NOT NULL DEFAULT false,
  vat_scheme            TEXT        NULL,   -- 'standard', 'flat_rate', 'cash'
  primary_bank_account  TEXT        NULL,   -- Xero account code for primary bank
  notes                 TEXT        NULL,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ─── upload_batches ──────────────────────────────────────────────────────────
-- One record per CSV file upload.
-- Tracks upload state so partial failures can be retried without duplicating rows.

CREATE TABLE manual_inputs.upload_batches (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID        NOT NULL REFERENCES core.tenants(id) ON DELETE CASCADE,
  uploaded_by     UUID        NULL,                       -- auth user id (nullable until auth wired)
  filename        TEXT        NOT NULL,
  file_size_bytes INTEGER     NULL,
  row_count       INTEGER     NULL,                       -- populated after parsing
  status          TEXT        NOT NULL DEFAULT 'pending'
                              CHECK (status IN ('pending','processing','completed','failed')),
  error           TEXT        NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at    TIMESTAMPTZ NULL
);

CREATE INDEX ON manual_inputs.upload_batches (tenant_id);
CREATE INDEX ON manual_inputs.upload_batches (status) WHERE status IN ('pending','processing');

-- ─── uncoded_statement_line_uploads ──────────────────────────────────────────
-- Raw CSV rows stored as JSONB immediately after upload.
-- Preserves the original data verbatim before normalisation.
-- Keyed by (batch_id, row_index) so re-runs are idempotent.

CREATE TABLE manual_inputs.uncoded_statement_line_uploads (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id    UUID        NOT NULL REFERENCES manual_inputs.upload_batches(id) ON DELETE CASCADE,
  tenant_id   UUID        NOT NULL REFERENCES core.tenants(id) ON DELETE CASCADE,
  row_index   INTEGER     NOT NULL,       -- 0-based position in the CSV (excludes header)
  raw         JSONB       NOT NULL,       -- {"Date":"01 Jan 2025","Description":"...","Amount":"-42.50"}
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),

  UNIQUE (batch_id, row_index)
);

CREATE INDEX ON manual_inputs.uncoded_statement_line_uploads (tenant_id);
CREATE INDEX ON manual_inputs.uncoded_statement_line_uploads (batch_id);

-- ─── uncoded_statement_lines ─────────────────────────────────────────────────
-- Normalised, codeable rows — Tool 5's primary working table.
-- Populated from upload rows after type coercion (date parsing, amount as numeric).
-- An accountant assigns account_code + category, then marks approved = true.
-- Approved lines can be exported for Xero import or pushed to the warehouse.

CREATE TABLE manual_inputs.uncoded_statement_lines (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   UUID        NOT NULL REFERENCES core.tenants(id) ON DELETE CASCADE,
  batch_id    UUID        NOT NULL REFERENCES manual_inputs.upload_batches(id) ON DELETE CASCADE,
  upload_id   UUID        NOT NULL REFERENCES manual_inputs.uncoded_statement_line_uploads(id) ON DELETE CASCADE,

  -- Normalised fields from the CSV
  date                DATE          NOT NULL,
  description         TEXT          NOT NULL,
  amount              NUMERIC(15,2) NOT NULL,  -- negative = debit, positive = credit
  reference           TEXT          NULL,
  currency_code       TEXT          NOT NULL DEFAULT 'GBP',

  -- Coding fields — filled by accountant or Tool 5 AI suggestion
  account_code        TEXT          NULL,   -- Xero account code (e.g. '200')
  account_name        TEXT          NULL,   -- denormalised for display
  category            TEXT          NULL,   -- business_type label or freeform
  tax_type            TEXT          NULL,   -- Xero tax type (NONE, TAX20, etc.)
  notes               TEXT          NULL,

  -- Status flags
  is_suggested        BOOLEAN       NOT NULL DEFAULT false,  -- Tool 5 AI suggested this coding
  approved            BOOLEAN       NOT NULL DEFAULT false,  -- accountant approved
  approved_by         UUID          NULL,
  approved_at         TIMESTAMPTZ   NULL,

  -- Dedup: prevent duplicate rows if the same CSV is re-uploaded.
  -- Computed from MD5(tenant_id || date || description || amount) at insert time.
  dedup_hash          TEXT          NOT NULL,

  created_at          TIMESTAMPTZ   NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ   NOT NULL DEFAULT now(),

  UNIQUE (tenant_id, dedup_hash)
);

CREATE INDEX ON manual_inputs.uncoded_statement_lines (tenant_id);
CREATE INDEX ON manual_inputs.uncoded_statement_lines (batch_id);
CREATE INDEX ON manual_inputs.uncoded_statement_lines (tenant_id, approved) WHERE approved = false;
CREATE INDEX ON manual_inputs.uncoded_statement_lines (date);
