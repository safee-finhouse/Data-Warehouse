-- Migration: 008_warehouse_views.sql
-- Queryable views over the warehouse layer for downstream tools.
--
-- Tools should query views, not tables directly. Views:
--   • hide join complexity
--   • enforce tenant-safe column selection
--   • give stable query surfaces that survive schema changes behind them
--
-- Tool mapping:
--   vw_overdue_invoices          → aged debt dashboard, collections workflow
--   vw_invoice_ageing            → ageing buckets (0-30, 31-60, 61-90, 90+)
--   vw_payment_history           → cash flow / payment reconciliation tools
--   vw_profit_and_loss_by_period → P&L comparison across months
--   vw_balance_sheet_by_period   → BS point-in-time tracking
--   vw_trial_balance_by_period   → TB used for audit / reconciliation tools

-- ─── vw_overdue_invoices ──────────────────────────────────────────────────────
-- All AUTHORISED invoices past their due date, not yet fully paid.
-- Used by: aged debt dashboard, collections workflow, client billing tool.
-- Query: WHERE tenant_id = $1 ORDER BY days_overdue DESC

CREATE VIEW warehouse.vw_overdue_invoices AS
SELECT
  fi.id,
  fi.tenant_id,
  dt.name                                      AS tenant_name,
  fi.xero_id,
  fi.invoice_number,
  fi.type,                                     -- ACCREC (owed to us) | ACCPAY (we owe)
  fi.status,
  fi.date                                      AS invoice_date,
  fi.due_date,
  fi.days_overdue,
  dc.name                                      AS contact_name,
  dc.email_address                             AS contact_email,
  fi.total,
  fi.amount_paid,
  fi.amount_due,
  fi.currency_code,
  fi.warehouse_updated_at
FROM warehouse.fact_invoice fi
JOIN warehouse.dim_tenant  dt ON dt.id = fi.tenant_id
LEFT JOIN warehouse.dim_contact dc ON dc.id = fi.dim_contact_id
WHERE fi.is_overdue = true
  AND fi.status NOT IN ('VOIDED', 'DELETED');

-- ─── vw_invoice_ageing ────────────────────────────────────────────────────────
-- Buckets outstanding invoices by how many days they are overdue.
-- Used by: aged receivables / payables reports, finance dashboards.
-- Query: WHERE tenant_id = $1 AND type = 'ACCREC'

CREATE VIEW warehouse.vw_invoice_ageing AS
SELECT
  fi.id,
  fi.tenant_id,
  dt.name                                      AS tenant_name,
  fi.xero_id,
  fi.invoice_number,
  fi.type,
  fi.status,
  fi.date                                      AS invoice_date,
  fi.due_date,
  fi.amount_due,
  fi.currency_code,
  dc.name                                      AS contact_name,
  CASE
    WHEN fi.amount_due <= 0                    THEN 'current'
    WHEN fi.days_overdue IS NULL
      OR fi.days_overdue = 0                   THEN 'current'
    WHEN fi.days_overdue <= 30                 THEN '1-30'
    WHEN fi.days_overdue <= 60                 THEN '31-60'
    WHEN fi.days_overdue <= 90                 THEN '61-90'
    ELSE                                            '90+'
  END                                          AS ageing_bucket,
  COALESCE(fi.days_overdue, 0)                 AS days_overdue,
  fi.warehouse_updated_at
FROM warehouse.fact_invoice fi
JOIN warehouse.dim_tenant  dt ON dt.id = fi.tenant_id
LEFT JOIN warehouse.dim_contact dc ON dc.id = fi.dim_contact_id
WHERE fi.status NOT IN ('VOIDED', 'DELETED', 'DRAFT');

-- ─── vw_payment_history ───────────────────────────────────────────────────────
-- All payments with linked invoice and account details.
-- Used by: cash flow tools, payment reconciliation, bank matching.
-- Query: WHERE tenant_id = $1 AND date BETWEEN $2 AND $3

CREATE VIEW warehouse.vw_payment_history AS
SELECT
  fp.id,
  fp.tenant_id,
  dt.name                                      AS tenant_name,
  fp.xero_id,
  fp.date                                      AS payment_date,
  fp.amount,
  fp.reference,
  fp.payment_type,
  fp.is_reconciled,
  fp.status,
  fp.currency_rate,
  fi.invoice_number,
  fi.type                                      AS invoice_type,
  dc.name                                      AS contact_name,
  da.code                                      AS account_code,
  da.name                                      AS account_name,
  da.class                                     AS account_class,
  fp.warehouse_updated_at
FROM warehouse.fact_payment fp
JOIN warehouse.dim_tenant  dt ON dt.id = fp.tenant_id
LEFT JOIN warehouse.fact_invoice  fi ON fi.id = fp.fact_invoice_id
LEFT JOIN warehouse.dim_contact   dc ON dc.id = fi.dim_contact_id
LEFT JOIN warehouse.dim_account   da ON da.id = fp.dim_account_id
WHERE fp.status = 'AUTHORISED';

-- ─── vw_profit_and_loss_by_period ─────────────────────────────────────────────
-- P&L rows flattened with period labels for trend comparison.
-- Used by: P&L dashboard, management accounts tool, month-over-month analysis.
-- Query: WHERE tenant_id = $1 ORDER BY period_to, section, row_order

CREATE VIEW warehouse.vw_profit_and_loss_by_period AS
SELECT
  fp.id,
  fp.tenant_id,
  dt.name                                      AS tenant_name,
  fp.snapshot_id,
  fp.period_from,
  fp.period_to,
  to_char(fp.period_to, 'Mon YYYY')           AS period_label,
  fp.section,
  fp.account_xero_id,
  fp.account_name,
  fp.value,
  fp.row_type,
  fp.row_order
FROM warehouse.fact_profit_and_loss_snapshot fp
JOIN warehouse.dim_tenant dt ON dt.id = fp.tenant_id;

-- ─── vw_balance_sheet_by_period ───────────────────────────────────────────────
-- Balance Sheet rows with period labels for point-in-time tracking.
-- Used by: BS dashboard, net worth tracking, equity monitoring tool.
-- Query: WHERE tenant_id = $1 ORDER BY period_date, section, sub_section, row_order

CREATE VIEW warehouse.vw_balance_sheet_by_period AS
SELECT
  fb.id,
  fb.tenant_id,
  dt.name                                      AS tenant_name,
  fb.snapshot_id,
  fb.period_date,
  to_char(fb.period_date, 'Mon YYYY')         AS period_label,
  fb.section,
  fb.sub_section,
  fb.account_xero_id,
  fb.account_name,
  fb.value,
  fb.row_type,
  fb.row_order
FROM warehouse.fact_balance_sheet_snapshot fb
JOIN warehouse.dim_tenant dt ON dt.id = fb.tenant_id;

-- ─── vw_trial_balance_by_period ───────────────────────────────────────────────
-- Trial Balance rows with period labels.
-- Used by: audit tools, chart-of-accounts reconciliation, accountant portal.
-- Query: WHERE tenant_id = $1 AND period_date = $2

CREATE VIEW warehouse.vw_trial_balance_by_period AS
SELECT
  ft.id,
  ft.tenant_id,
  dt.name                                      AS tenant_name,
  ft.snapshot_id,
  ft.period_date,
  to_char(ft.period_date, 'Mon YYYY')         AS period_label,
  ft.account_xero_id,
  ft.account_name,
  ft.debit,
  ft.credit,
  ft.ytd_debit,
  ft.ytd_credit,
  ft.row_type,
  ft.row_order
FROM warehouse.fact_trial_balance_snapshot ft
JOIN warehouse.dim_tenant dt ON dt.id = ft.tenant_id;
