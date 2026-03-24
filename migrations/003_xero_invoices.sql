-- Migration: 003_xero_invoices.sql
-- Raw invoice data pulled from Xero, stored as-received with key columns extracted.

CREATE TABLE xero_invoices (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  connection_id    UUID        NOT NULL REFERENCES xero_connections(id),
  xero_invoice_id  TEXT        NOT NULL,
  invoice_number   TEXT,
  type             TEXT        NOT NULL,  -- ACCREC | ACCPAY
  status           TEXT        NOT NULL,
  contact_id       TEXT,
  contact_name     TEXT,
  date             DATE,
  due_date         DATE,
  amount_due       NUMERIC(15, 2),
  amount_paid      NUMERIC(15, 2),
  subtotal         NUMERIC(15, 2),
  total_tax        NUMERIC(15, 2),
  total            NUMERIC(15, 2),
  currency_code    TEXT,
  updated_date_utc TIMESTAMPTZ,
  raw              JSONB       NOT NULL,
  synced_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (connection_id, xero_invoice_id)
);

CREATE INDEX xero_invoices_connection_id_idx  ON xero_invoices (connection_id);
CREATE INDEX xero_invoices_updated_date_idx   ON xero_invoices (updated_date_utc);
CREATE INDEX xero_invoices_status_idx         ON xero_invoices (status);
CREATE INDEX xero_invoices_type_idx           ON xero_invoices (type);
