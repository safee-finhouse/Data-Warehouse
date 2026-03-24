-- Migration: 007_report_snapshots.sql
-- Report snapshot ingestion: Trial Balance, Profit & Loss, Balance Sheet.
--
-- Two-layer design (matches the rest of the warehouse):
--
--   raw_xero.report_snapshots         — one row per fetch, full JSONB payload
--   warehouse.fact_trial_balance_snapshot
--   warehouse.fact_profit_and_loss_snapshot
--   warehouse.fact_balance_sheet_snapshot
--
-- Snapshot semantics:
--   Each row in raw_xero.report_snapshots represents a point-in-time fetch of a
--   report for a specific period. UNIQUE (connection_id, report_type, period_date)
--   means one stored snapshot per period — re-fetching the same period overwrites it.
--   Historical comparison is achieved by fetching different periods (e.g. every
--   month-end), each producing its own snapshot row with a distinct period_date.
--
-- Warehouse rows:
--   Each warehouse fact table has UNIQUE (snapshot_id, row_order) so the transform
--   can re-run safely without creating duplicates.

-- ─── raw_xero.report_snapshots ────────────────────────────────────────────────

CREATE TABLE raw_xero.report_snapshots (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  connection_id UUID        NOT NULL REFERENCES core.xero_connections(id),
  tenant_id    UUID        NOT NULL REFERENCES core.tenants(id),
  report_type  TEXT        NOT NULL
               CHECK (report_type IN ('trial_balance', 'profit_and_loss', 'balance_sheet')),
  period_date  DATE        NOT NULL,   -- as-at date (TB/BS) or period-end date (P&L)
  period_from  DATE,                   -- period-start date for P&L; NULL for TB/BS
  report_name  TEXT,
  raw          JSONB       NOT NULL,   -- full Xero Reports response
  captured_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (connection_id, report_type, period_date)
);

CREATE INDEX raw_xero_report_snapshots_connection_id_idx ON raw_xero.report_snapshots (connection_id);
CREATE INDEX raw_xero_report_snapshots_tenant_id_idx     ON raw_xero.report_snapshots (tenant_id);
CREATE INDEX raw_xero_report_snapshots_type_date_idx     ON raw_xero.report_snapshots (report_type, period_date);

-- ─── warehouse.fact_trial_balance_snapshot ────────────────────────────────────
-- One row per account (and summary row) per snapshot.
-- Columns: the five standard TB columns from Xero.

CREATE TABLE warehouse.fact_trial_balance_snapshot (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  snapshot_id     UUID        NOT NULL REFERENCES raw_xero.report_snapshots(id),
  tenant_id       UUID        NOT NULL REFERENCES warehouse.dim_tenant(id),
  period_date     DATE        NOT NULL,
  row_order       INT         NOT NULL,   -- position in parsed output, used as conflict key
  account_xero_id TEXT,                   -- NULL for summary rows
  account_name    TEXT        NOT NULL,
  debit           NUMERIC(15,2),
  credit          NUMERIC(15,2),
  ytd_debit       NUMERIC(15,2),
  ytd_credit      NUMERIC(15,2),
  row_type        TEXT        NOT NULL CHECK (row_type IN ('row', 'summary')),
  UNIQUE (snapshot_id, row_order)
);

CREATE INDEX wh_tb_snapshot_tenant_id_idx    ON warehouse.fact_trial_balance_snapshot (tenant_id);
CREATE INDEX wh_tb_snapshot_period_date_idx  ON warehouse.fact_trial_balance_snapshot (tenant_id, period_date);

-- ─── warehouse.fact_profit_and_loss_snapshot ──────────────────────────────────
-- One row per account (and summary) per section per snapshot.

CREATE TABLE warehouse.fact_profit_and_loss_snapshot (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  snapshot_id     UUID        NOT NULL REFERENCES raw_xero.report_snapshots(id),
  tenant_id       UUID        NOT NULL REFERENCES warehouse.dim_tenant(id),
  period_from     DATE,
  period_to       DATE        NOT NULL,
  row_order       INT         NOT NULL,
  section         TEXT,                   -- e.g. 'Income', 'Less Operating Expenses'
  account_xero_id TEXT,
  account_name    TEXT        NOT NULL,
  value           NUMERIC(15,2),
  row_type        TEXT        NOT NULL CHECK (row_type IN ('row', 'summary')),
  UNIQUE (snapshot_id, row_order)
);

CREATE INDEX wh_pl_snapshot_tenant_id_idx   ON warehouse.fact_profit_and_loss_snapshot (tenant_id);
CREATE INDEX wh_pl_snapshot_period_idx      ON warehouse.fact_profit_and_loss_snapshot (tenant_id, period_to);
CREATE INDEX wh_pl_snapshot_section_idx     ON warehouse.fact_profit_and_loss_snapshot (snapshot_id, section);

-- ─── warehouse.fact_balance_sheet_snapshot ────────────────────────────────────
-- One row per account (and summary) per section/sub-section per snapshot.

CREATE TABLE warehouse.fact_balance_sheet_snapshot (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  snapshot_id     UUID        NOT NULL REFERENCES raw_xero.report_snapshots(id),
  tenant_id       UUID        NOT NULL REFERENCES warehouse.dim_tenant(id),
  period_date     DATE        NOT NULL,
  row_order       INT         NOT NULL,
  section         TEXT,                   -- top-level: 'Assets', 'Liabilities', 'Equity'
  sub_section     TEXT,                   -- e.g. 'Current Assets', 'Non-Current Liabilities'
  account_xero_id TEXT,
  account_name    TEXT        NOT NULL,
  value           NUMERIC(15,2),
  row_type        TEXT        NOT NULL CHECK (row_type IN ('row', 'summary')),
  UNIQUE (snapshot_id, row_order)
);

CREATE INDEX wh_bs_snapshot_tenant_id_idx   ON warehouse.fact_balance_sheet_snapshot (tenant_id);
CREATE INDEX wh_bs_snapshot_period_date_idx ON warehouse.fact_balance_sheet_snapshot (tenant_id, period_date);
CREATE INDEX wh_bs_snapshot_section_idx     ON warehouse.fact_balance_sheet_snapshot (snapshot_id, section);
