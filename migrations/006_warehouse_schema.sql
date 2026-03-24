-- Migration: 006_warehouse_schema.sql
-- Clean analytics warehouse layer. Sourced from raw_xero.* via transformation queries.
--
-- Design principles:
--   • No raw JSONB columns — every field is a typed SQL column.
--   • Star schema: dim_* tables hold entities, fact_* tables hold measurements.
--   • All tables carry tenant_id for row-level multi-tenancy.
--   • xero_id is preserved on every table for traceability back to raw_xero.
--   • Dim FKs on fact tables are nullable (LEFT JOINs during transform) so a
--     missing dim never blocks a fact row from being written.
--   • is_overdue / days_overdue are stored at transform time — re-run transform
--     to refresh overdue status as time passes.
--   • warehouse_updated_at tracks when the transform last touched each row.

CREATE SCHEMA IF NOT EXISTS warehouse;

-- ─── warehouse.dim_tenant ─────────────────────────────────────────────────────
-- Mirrors core.tenants. Uses the same UUID so joins to other schemas are free.

CREATE TABLE warehouse.dim_tenant (
  id                  UUID        PRIMARY KEY REFERENCES core.tenants(id),
  name                TEXT        NOT NULL,
  slug                TEXT        NOT NULL,
  is_active           BOOLEAN     NOT NULL DEFAULT true,
  warehouse_updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ─── warehouse.dim_contact ────────────────────────────────────────────────────

CREATE TABLE warehouse.dim_contact (
  id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           UUID        NOT NULL REFERENCES warehouse.dim_tenant(id),
  xero_id             TEXT        NOT NULL,   -- ContactID
  name                TEXT        NOT NULL,
  first_name          TEXT,
  last_name           TEXT,
  email_address       TEXT,
  contact_status      TEXT,                   -- ACTIVE | ARCHIVED | GDPRREQUEST
  is_supplier         BOOLEAN     NOT NULL DEFAULT false,
  is_customer         BOOLEAN     NOT NULL DEFAULT false,
  tax_number          TEXT,
  default_currency    TEXT,
  xero_updated_at     TIMESTAMPTZ,
  warehouse_updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, xero_id)
);

CREATE INDEX wh_dim_contact_tenant_id_idx ON warehouse.dim_contact (tenant_id);
CREATE INDEX wh_dim_contact_name_idx      ON warehouse.dim_contact (name);

-- ─── warehouse.dim_account ────────────────────────────────────────────────────

CREATE TABLE warehouse.dim_account (
  id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           UUID        NOT NULL REFERENCES warehouse.dim_tenant(id),
  xero_id             TEXT        NOT NULL,   -- AccountID
  code                TEXT,
  name                TEXT        NOT NULL,
  type                TEXT        NOT NULL,   -- BANK | REVENUE | EXPENSE | etc.
  status              TEXT        NOT NULL,   -- ACTIVE | ARCHIVED
  class               TEXT,                   -- ASSET | EQUITY | EXPENSE | LIABILITY | REVENUE
  description         TEXT,
  tax_type            TEXT,
  is_bank_account     BOOLEAN     NOT NULL DEFAULT false,  -- derived: type = 'BANK'
  xero_updated_at     TIMESTAMPTZ,
  warehouse_updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, xero_id)
);

CREATE INDEX wh_dim_account_tenant_id_idx ON warehouse.dim_account (tenant_id);
CREATE INDEX wh_dim_account_code_idx      ON warehouse.dim_account (tenant_id, code);
CREATE INDEX wh_dim_account_class_idx     ON warehouse.dim_account (class);

-- ─── warehouse.fact_invoice ───────────────────────────────────────────────────

CREATE TABLE warehouse.fact_invoice (
  id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           UUID        NOT NULL REFERENCES warehouse.dim_tenant(id),
  dim_contact_id      UUID        REFERENCES warehouse.dim_contact(id),  -- nullable
  xero_id             TEXT        NOT NULL,   -- InvoiceID
  invoice_number      TEXT,
  type                TEXT        NOT NULL,   -- ACCREC | ACCPAY
  status              TEXT        NOT NULL,   -- DRAFT | SUBMITTED | AUTHORISED | PAID | VOIDED | DELETED
  date                DATE,
  due_date            DATE,
  amount_due          NUMERIC(15,2),
  amount_paid         NUMERIC(15,2),
  amount_credited     NUMERIC(15,2),
  subtotal            NUMERIC(15,2),
  total_tax           NUMERIC(15,2),
  total               NUMERIC(15,2),
  currency_code       TEXT,
  currency_rate       NUMERIC(20,10),
  reference           TEXT,
  is_overdue          BOOLEAN     NOT NULL DEFAULT false,   -- computed at transform time
  days_overdue        INT,                                  -- NULL if not overdue
  xero_updated_at     TIMESTAMPTZ,
  warehouse_updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, xero_id)
);

CREATE INDEX wh_fact_invoice_tenant_id_idx     ON warehouse.fact_invoice (tenant_id);
CREATE INDEX wh_fact_invoice_contact_id_idx    ON warehouse.fact_invoice (dim_contact_id);
CREATE INDEX wh_fact_invoice_status_idx        ON warehouse.fact_invoice (tenant_id, status);
CREATE INDEX wh_fact_invoice_type_idx          ON warehouse.fact_invoice (tenant_id, type);
CREATE INDEX wh_fact_invoice_date_idx          ON warehouse.fact_invoice (date);
CREATE INDEX wh_fact_invoice_due_date_idx      ON warehouse.fact_invoice (due_date);
CREATE INDEX wh_fact_invoice_is_overdue_idx    ON warehouse.fact_invoice (tenant_id, is_overdue);

-- ─── warehouse.fact_invoice_line ─────────────────────────────────────────────

CREATE TABLE warehouse.fact_invoice_line (
  id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           UUID        NOT NULL REFERENCES warehouse.dim_tenant(id),
  fact_invoice_id     UUID        REFERENCES warehouse.fact_invoice(id),  -- nullable
  dim_account_id      UUID        REFERENCES warehouse.dim_account(id),   -- nullable
  xero_invoice_id     TEXT        NOT NULL,   -- parent InvoiceID (for traceability)
  xero_id             TEXT        NOT NULL,   -- LineItemID
  description         TEXT,
  quantity            NUMERIC(20,6),
  unit_amount         NUMERIC(15,4),
  line_amount         NUMERIC(15,2),
  account_code        TEXT,
  tax_type            TEXT,
  tax_amount          NUMERIC(15,2),
  item_code           TEXT,
  warehouse_updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, xero_invoice_id, xero_id)
);

CREATE INDEX wh_fact_invoice_line_tenant_id_idx     ON warehouse.fact_invoice_line (tenant_id);
CREATE INDEX wh_fact_invoice_line_invoice_id_idx    ON warehouse.fact_invoice_line (fact_invoice_id);
CREATE INDEX wh_fact_invoice_line_account_id_idx    ON warehouse.fact_invoice_line (dim_account_id);
CREATE INDEX wh_fact_invoice_line_account_code_idx  ON warehouse.fact_invoice_line (tenant_id, account_code);

-- ─── warehouse.fact_payment ───────────────────────────────────────────────────

CREATE TABLE warehouse.fact_payment (
  id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           UUID        NOT NULL REFERENCES warehouse.dim_tenant(id),
  fact_invoice_id     UUID        REFERENCES warehouse.fact_invoice(id),  -- nullable
  dim_account_id      UUID        REFERENCES warehouse.dim_account(id),   -- nullable
  xero_id             TEXT        NOT NULL,   -- PaymentID
  date                DATE,
  amount              NUMERIC(15,2),
  reference           TEXT,
  is_reconciled       BOOLEAN     NOT NULL DEFAULT false,
  status              TEXT        NOT NULL,
  payment_type        TEXT        NOT NULL,
  currency_rate       NUMERIC(20,10),
  xero_updated_at     TIMESTAMPTZ,
  warehouse_updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, xero_id)
);

CREATE INDEX wh_fact_payment_tenant_id_idx   ON warehouse.fact_payment (tenant_id);
CREATE INDEX wh_fact_payment_invoice_id_idx  ON warehouse.fact_payment (fact_invoice_id);
CREATE INDEX wh_fact_payment_date_idx        ON warehouse.fact_payment (date);

-- ─── warehouse.fact_bank_transaction ─────────────────────────────────────────

CREATE TABLE warehouse.fact_bank_transaction (
  id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           UUID        NOT NULL REFERENCES warehouse.dim_tenant(id),
  dim_contact_id      UUID        REFERENCES warehouse.dim_contact(id),   -- nullable
  dim_account_id      UUID        REFERENCES warehouse.dim_account(id),   -- nullable (bank account)
  xero_id             TEXT        NOT NULL,   -- BankTransactionID
  type                TEXT        NOT NULL,   -- RECEIVE | SPEND | RECEIVE-TRANSFER | etc.
  status              TEXT        NOT NULL,
  reference           TEXT,
  is_reconciled       BOOLEAN     NOT NULL DEFAULT false,
  date                DATE,
  subtotal            NUMERIC(15,2),
  total_tax           NUMERIC(15,2),
  total               NUMERIC(15,2),
  currency_code       TEXT,
  currency_rate       NUMERIC(20,10),
  xero_updated_at     TIMESTAMPTZ,
  warehouse_updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, xero_id)
);

CREATE INDEX wh_fact_bank_txn_tenant_id_idx   ON warehouse.fact_bank_transaction (tenant_id);
CREATE INDEX wh_fact_bank_txn_contact_id_idx  ON warehouse.fact_bank_transaction (dim_contact_id);
CREATE INDEX wh_fact_bank_txn_account_id_idx  ON warehouse.fact_bank_transaction (dim_account_id);
CREATE INDEX wh_fact_bank_txn_date_idx        ON warehouse.fact_bank_transaction (date);
CREATE INDEX wh_fact_bank_txn_type_idx        ON warehouse.fact_bank_transaction (tenant_id, type);

-- ─── warehouse.fact_manual_journal ───────────────────────────────────────────

CREATE TABLE warehouse.fact_manual_journal (
  id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           UUID        NOT NULL REFERENCES warehouse.dim_tenant(id),
  xero_id             TEXT        NOT NULL,   -- ManualJournalID
  narration           TEXT,
  date                DATE,
  status              TEXT,                   -- DRAFT | POSTED | DELETED | VOIDED
  xero_updated_at     TIMESTAMPTZ,
  warehouse_updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, xero_id)
);

CREATE INDEX wh_fact_manual_journal_tenant_id_idx ON warehouse.fact_manual_journal (tenant_id);
CREATE INDEX wh_fact_manual_journal_date_idx      ON warehouse.fact_manual_journal (date);
CREATE INDEX wh_fact_manual_journal_status_idx    ON warehouse.fact_manual_journal (status);
