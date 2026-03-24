-- Migration: 005_raw_xero_schema.sql
-- Raw ingestion layer for Xero data.
--
-- Schema design principles:
--   • Every table stores the full Xero JSON payload in `raw` (JSONB) — nothing is discarded.
--   • Key fields are extracted into typed columns for querying without JSON operators.
--   • Idempotency: every table has UNIQUE (connection_id, xero_id) so upserts are safe to re-run.
--   • invoice_lines uses UNIQUE (connection_id, xero_invoice_id, xero_id) — line items are
--     scoped to their parent invoice.
--   • tenant_id is denormalized from core.xero_connections for query convenience.

CREATE SCHEMA IF NOT EXISTS raw_xero;

-- ─── raw_xero.contacts ────────────────────────────────────────────────────────

CREATE TABLE raw_xero.contacts (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  connection_id    UUID        NOT NULL REFERENCES core.xero_connections(id),
  tenant_id        UUID        NOT NULL REFERENCES core.tenants(id),
  xero_id          TEXT        NOT NULL,   -- ContactID
  name             TEXT        NOT NULL,
  first_name       TEXT,
  last_name        TEXT,
  email_address    TEXT,
  contact_status   TEXT,
  is_supplier      BOOLEAN     NOT NULL DEFAULT false,
  is_customer      BOOLEAN     NOT NULL DEFAULT false,
  tax_number       TEXT,
  default_currency TEXT,
  updated_date_utc TIMESTAMPTZ,
  raw              JSONB       NOT NULL,
  synced_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (connection_id, xero_id)
);

CREATE INDEX raw_xero_contacts_connection_id_idx  ON raw_xero.contacts (connection_id);
CREATE INDEX raw_xero_contacts_tenant_id_idx      ON raw_xero.contacts (tenant_id);
CREATE INDEX raw_xero_contacts_updated_date_idx   ON raw_xero.contacts (updated_date_utc);
CREATE INDEX raw_xero_contacts_name_idx           ON raw_xero.contacts (name);

-- ─── raw_xero.accounts ────────────────────────────────────────────────────────

CREATE TABLE raw_xero.accounts (
  id                      UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  connection_id           UUID        NOT NULL REFERENCES core.xero_connections(id),
  tenant_id               UUID        NOT NULL REFERENCES core.tenants(id),
  xero_id                 TEXT        NOT NULL,   -- AccountID
  code                    TEXT,
  name                    TEXT        NOT NULL,
  type                    TEXT        NOT NULL,   -- e.g. BANK, REVENUE, EXPENSE
  status                  TEXT        NOT NULL,   -- ACTIVE | ARCHIVED
  class                   TEXT,                   -- ASSET | EQUITY | EXPENSE | LIABILITY | REVENUE
  description             TEXT,
  tax_type                TEXT,
  system_account          TEXT,
  enable_payments         BOOLEAN     NOT NULL DEFAULT false,
  updated_date_utc        TIMESTAMPTZ,
  raw                     JSONB       NOT NULL,
  synced_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (connection_id, xero_id)
);

CREATE INDEX raw_xero_accounts_connection_id_idx  ON raw_xero.accounts (connection_id);
CREATE INDEX raw_xero_accounts_tenant_id_idx      ON raw_xero.accounts (tenant_id);
CREATE INDEX raw_xero_accounts_type_idx           ON raw_xero.accounts (type);
CREATE INDEX raw_xero_accounts_class_idx          ON raw_xero.accounts (class);

-- ─── raw_xero.invoices ────────────────────────────────────────────────────────

CREATE TABLE raw_xero.invoices (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  connection_id    UUID        NOT NULL REFERENCES core.xero_connections(id),
  tenant_id        UUID        NOT NULL REFERENCES core.tenants(id),
  xero_id          TEXT        NOT NULL,   -- InvoiceID
  invoice_number   TEXT,
  type             TEXT        NOT NULL,   -- ACCREC (receivable) | ACCPAY (payable)
  status           TEXT        NOT NULL,   -- DRAFT | SUBMITTED | AUTHORISED | PAID | VOIDED | DELETED
  contact_id       TEXT,
  contact_name     TEXT,
  date             DATE,
  due_date         DATE,
  amount_due       NUMERIC(15,2),
  amount_paid      NUMERIC(15,2),
  amount_credited  NUMERIC(15,2),
  subtotal         NUMERIC(15,2),
  total_tax        NUMERIC(15,2),
  total            NUMERIC(15,2),
  currency_code    TEXT,
  currency_rate    NUMERIC(20,10),
  reference        TEXT,
  updated_date_utc TIMESTAMPTZ,
  raw              JSONB       NOT NULL,
  synced_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (connection_id, xero_id)
);

CREATE INDEX raw_xero_invoices_connection_id_idx  ON raw_xero.invoices (connection_id);
CREATE INDEX raw_xero_invoices_tenant_id_idx      ON raw_xero.invoices (tenant_id);
CREATE INDEX raw_xero_invoices_updated_date_idx   ON raw_xero.invoices (updated_date_utc);
CREATE INDEX raw_xero_invoices_status_idx         ON raw_xero.invoices (status);
CREATE INDEX raw_xero_invoices_type_idx           ON raw_xero.invoices (type);
CREATE INDEX raw_xero_invoices_contact_id_idx     ON raw_xero.invoices (contact_id);
CREATE INDEX raw_xero_invoices_date_idx           ON raw_xero.invoices (date);

-- ─── raw_xero.invoice_lines ───────────────────────────────────────────────────
-- Child records of raw_xero.invoices. One row per line item.
-- Linked by xero_invoice_id (text) rather than a UUID FK to keep inserts independent.

CREATE TABLE raw_xero.invoice_lines (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  connection_id    UUID        NOT NULL REFERENCES core.xero_connections(id),
  tenant_id        UUID        NOT NULL REFERENCES core.tenants(id),
  xero_invoice_id  TEXT        NOT NULL,   -- Parent InvoiceID
  xero_id          TEXT        NOT NULL,   -- LineItemID
  description      TEXT,
  quantity         NUMERIC(20,6),
  unit_amount      NUMERIC(15,4),
  line_amount      NUMERIC(15,2),
  account_code     TEXT,
  tax_type         TEXT,
  tax_amount       NUMERIC(15,2),
  item_code        TEXT,
  raw              JSONB       NOT NULL,
  synced_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (connection_id, xero_invoice_id, xero_id)
);

CREATE INDEX raw_xero_invoice_lines_connection_id_idx  ON raw_xero.invoice_lines (connection_id);
CREATE INDEX raw_xero_invoice_lines_tenant_id_idx      ON raw_xero.invoice_lines (tenant_id);
CREATE INDEX raw_xero_invoice_lines_invoice_id_idx     ON raw_xero.invoice_lines (xero_invoice_id);
CREATE INDEX raw_xero_invoice_lines_account_code_idx   ON raw_xero.invoice_lines (account_code);

-- ─── raw_xero.payments ────────────────────────────────────────────────────────

CREATE TABLE raw_xero.payments (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  connection_id    UUID        NOT NULL REFERENCES core.xero_connections(id),
  tenant_id        UUID        NOT NULL REFERENCES core.tenants(id),
  xero_id          TEXT        NOT NULL,   -- PaymentID
  date             DATE,
  amount           NUMERIC(15,2),
  reference        TEXT,
  is_reconciled    BOOLEAN     NOT NULL DEFAULT false,
  status           TEXT        NOT NULL,   -- AUTHORISED | DELETED
  payment_type     TEXT        NOT NULL,   -- ACCRECPAYMENT | ACCPAYPAYMENT | etc.
  currency_rate    NUMERIC(20,10),
  invoice_id       TEXT,                   -- Invoice.InvoiceID (if payment applies to an invoice)
  invoice_number   TEXT,
  account_id       TEXT,                   -- Account.AccountID
  account_code     TEXT,
  updated_date_utc TIMESTAMPTZ,
  raw              JSONB       NOT NULL,
  synced_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (connection_id, xero_id)
);

CREATE INDEX raw_xero_payments_connection_id_idx  ON raw_xero.payments (connection_id);
CREATE INDEX raw_xero_payments_tenant_id_idx      ON raw_xero.payments (tenant_id);
CREATE INDEX raw_xero_payments_updated_date_idx   ON raw_xero.payments (updated_date_utc);
CREATE INDEX raw_xero_payments_invoice_id_idx     ON raw_xero.payments (invoice_id);
CREATE INDEX raw_xero_payments_date_idx           ON raw_xero.payments (date);

-- ─── raw_xero.bank_transactions ───────────────────────────────────────────────

CREATE TABLE raw_xero.bank_transactions (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  connection_id     UUID        NOT NULL REFERENCES core.xero_connections(id),
  tenant_id         UUID        NOT NULL REFERENCES core.tenants(id),
  xero_id           TEXT        NOT NULL,   -- BankTransactionID
  type              TEXT        NOT NULL,   -- RECEIVE | SPEND | RECEIVE-TRANSFER | etc.
  status            TEXT        NOT NULL,   -- AUTHORISED | DELETED
  reference         TEXT,
  is_reconciled     BOOLEAN     NOT NULL DEFAULT false,
  date              DATE,
  subtotal          NUMERIC(15,2),
  total_tax         NUMERIC(15,2),
  total             NUMERIC(15,2),
  currency_code     TEXT,
  currency_rate     NUMERIC(20,10),
  bank_account_id   TEXT,
  bank_account_code TEXT,
  bank_account_name TEXT,
  contact_id        TEXT,
  contact_name      TEXT,
  updated_date_utc  TIMESTAMPTZ,
  raw               JSONB       NOT NULL,
  synced_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (connection_id, xero_id)
);

CREATE INDEX raw_xero_bank_txns_connection_id_idx  ON raw_xero.bank_transactions (connection_id);
CREATE INDEX raw_xero_bank_txns_tenant_id_idx      ON raw_xero.bank_transactions (tenant_id);
CREATE INDEX raw_xero_bank_txns_updated_date_idx   ON raw_xero.bank_transactions (updated_date_utc);
CREATE INDEX raw_xero_bank_txns_type_idx           ON raw_xero.bank_transactions (type);
CREATE INDEX raw_xero_bank_txns_date_idx           ON raw_xero.bank_transactions (date);

-- ─── raw_xero.manual_journals ─────────────────────────────────────────────────

CREATE TABLE raw_xero.manual_journals (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  connection_id    UUID        NOT NULL REFERENCES core.xero_connections(id),
  tenant_id        UUID        NOT NULL REFERENCES core.tenants(id),
  xero_id          TEXT        NOT NULL,   -- ManualJournalID
  narration        TEXT,
  date             DATE,
  status           TEXT,                   -- DRAFT | POSTED | DELETED | VOIDED
  updated_date_utc TIMESTAMPTZ,
  raw              JSONB       NOT NULL,
  synced_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (connection_id, xero_id)
);

CREATE INDEX raw_xero_manual_journals_connection_id_idx  ON raw_xero.manual_journals (connection_id);
CREATE INDEX raw_xero_manual_journals_tenant_id_idx      ON raw_xero.manual_journals (tenant_id);
CREATE INDEX raw_xero_manual_journals_updated_date_idx   ON raw_xero.manual_journals (updated_date_utc);
CREATE INDEX raw_xero_manual_journals_status_idx         ON raw_xero.manual_journals (status);
