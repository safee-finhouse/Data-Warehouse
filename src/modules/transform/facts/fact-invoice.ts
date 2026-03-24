/**
 * fact_invoice transform.
 * Bulk upsert from raw_xero.invoices → warehouse.fact_invoice.
 *
 * dim_contact_id resolved via LEFT JOIN on (tenant_id, xero_id = contact_id).
 * A missing contact dim row leaves dim_contact_id NULL — the invoice still lands.
 *
 * is_overdue and days_overdue are computed against CURRENT_DATE at transform time.
 * Re-run the transform to refresh these as time passes.
 */
import { sql } from "../../../db/client.js";
import type { TransformResult } from "../transform.types.js";

export async function transformFactInvoice(
  connectionId: string,
  _tenantId: string,
): Promise<TransformResult> {
  const start = Date.now();

  const [{ count }] = await sql<{ count: string }[]>`
    WITH source AS (
      SELECT
        ri.*,
        dc.id AS dim_contact_id,
        ri.status NOT IN ('PAID','VOIDED','DELETED')
          AND ri.due_date IS NOT NULL
          AND ri.due_date < CURRENT_DATE                                AS is_overdue,
        CASE
          WHEN ri.status NOT IN ('PAID','VOIDED','DELETED')
            AND ri.due_date IS NOT NULL
            AND ri.due_date < CURRENT_DATE
          THEN GREATEST(0, CURRENT_DATE - ri.due_date)
        END                                                             AS days_overdue
      FROM raw_xero.invoices ri
      LEFT JOIN warehouse.dim_contact dc
        ON dc.tenant_id = ri.tenant_id AND dc.xero_id = ri.contact_id
      WHERE ri.connection_id = ${connectionId}
    ),
    upserted AS (
      INSERT INTO warehouse.fact_invoice (
        tenant_id, dim_contact_id, xero_id,
        invoice_number, type, status,
        date, due_date,
        amount_due, amount_paid, amount_credited,
        subtotal, total_tax, total,
        currency_code, currency_rate, reference,
        is_overdue, days_overdue,
        xero_updated_at, warehouse_updated_at
      )
      SELECT
        tenant_id, dim_contact_id, xero_id,
        invoice_number, type, status,
        date, due_date,
        amount_due, amount_paid, amount_credited,
        subtotal, total_tax, total,
        currency_code, currency_rate, reference,
        is_overdue, days_overdue,
        updated_date_utc, now()
      FROM source
      ON CONFLICT (tenant_id, xero_id) DO UPDATE SET
        dim_contact_id       = EXCLUDED.dim_contact_id,
        invoice_number       = EXCLUDED.invoice_number,
        status               = EXCLUDED.status,
        date                 = EXCLUDED.date,
        due_date             = EXCLUDED.due_date,
        amount_due           = EXCLUDED.amount_due,
        amount_paid          = EXCLUDED.amount_paid,
        amount_credited      = EXCLUDED.amount_credited,
        subtotal             = EXCLUDED.subtotal,
        total_tax            = EXCLUDED.total_tax,
        total                = EXCLUDED.total,
        currency_code        = EXCLUDED.currency_code,
        currency_rate        = EXCLUDED.currency_rate,
        reference            = EXCLUDED.reference,
        is_overdue           = EXCLUDED.is_overdue,
        days_overdue         = EXCLUDED.days_overdue,
        xero_updated_at      = EXCLUDED.xero_updated_at,
        warehouse_updated_at = now()
      RETURNING id
    )
    SELECT COUNT(*) AS count FROM upserted
  `;

  return { entity: "fact_invoice", upserted: Number(count), durationMs: Date.now() - start };
}
