/**
 * fact_payment transform.
 * Bulk upsert from raw_xero.payments → warehouse.fact_payment.
 *
 * fact_invoice_id resolved via LEFT JOIN on (tenant_id, xero_id = invoice_id).
 * dim_account_id resolved via LEFT JOIN on (tenant_id, xero_id = account_id).
 * Must run after fact_invoice and dim_account transforms.
 */
import { sql } from "../../../db/client.js";
import type { TransformResult } from "../transform.types.js";

export async function transformFactPayment(
  connectionId: string,
  _tenantId: string,
): Promise<TransformResult> {
  const start = Date.now();

  const [{ count }] = await sql<{ count: string }[]>`
    WITH upserted AS (
      INSERT INTO warehouse.fact_payment (
        tenant_id, fact_invoice_id, dim_account_id,
        xero_id, date, amount, reference,
        is_reconciled, status, payment_type, currency_rate,
        xero_updated_at, warehouse_updated_at
      )
      SELECT
        rp.tenant_id,
        fi.id AS fact_invoice_id,
        da.id AS dim_account_id,
        rp.xero_id, rp.date, rp.amount, rp.reference,
        rp.is_reconciled, rp.status, rp.payment_type, rp.currency_rate,
        rp.updated_date_utc, now()
      FROM raw_xero.payments rp
      LEFT JOIN warehouse.fact_invoice fi
        ON fi.tenant_id = rp.tenant_id AND fi.xero_id = rp.invoice_id
      LEFT JOIN warehouse.dim_account da
        ON da.tenant_id = rp.tenant_id AND da.xero_id = rp.account_id
      WHERE rp.connection_id = ${connectionId}
      ON CONFLICT (tenant_id, xero_id) DO UPDATE SET
        fact_invoice_id      = EXCLUDED.fact_invoice_id,
        dim_account_id       = EXCLUDED.dim_account_id,
        date                 = EXCLUDED.date,
        amount               = EXCLUDED.amount,
        reference            = EXCLUDED.reference,
        is_reconciled        = EXCLUDED.is_reconciled,
        status               = EXCLUDED.status,
        payment_type         = EXCLUDED.payment_type,
        currency_rate        = EXCLUDED.currency_rate,
        xero_updated_at      = EXCLUDED.xero_updated_at,
        warehouse_updated_at = now()
      RETURNING id
    )
    SELECT COUNT(*) AS count FROM upserted
  `;

  return { entity: "fact_payment", upserted: Number(count), durationMs: Date.now() - start };
}
