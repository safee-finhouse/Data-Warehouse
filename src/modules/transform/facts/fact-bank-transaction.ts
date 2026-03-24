/**
 * fact_bank_transaction transform.
 * Bulk upsert from raw_xero.bank_transactions → warehouse.fact_bank_transaction.
 *
 * dim_contact_id resolved via LEFT JOIN on (tenant_id, xero_id = contact_id).
 * dim_account_id resolved via LEFT JOIN on (tenant_id, xero_id = bank_account_id).
 * Must run after dim_contact and dim_account transforms.
 */
import { sql } from "../../../db/client.js";
import type { TransformResult } from "../transform.types.js";

export async function transformFactBankTransaction(
  connectionId: string,
  _tenantId: string,
): Promise<TransformResult> {
  const start = Date.now();

  const [{ count }] = await sql<{ count: string }[]>`
    WITH upserted AS (
      INSERT INTO warehouse.fact_bank_transaction (
        tenant_id, dim_contact_id, dim_account_id,
        xero_id, type, status, reference, is_reconciled, date,
        subtotal, total_tax, total,
        currency_code, currency_rate,
        xero_updated_at, warehouse_updated_at
      )
      SELECT
        rbt.tenant_id,
        dc.id AS dim_contact_id,
        da.id AS dim_account_id,
        rbt.xero_id, rbt.type, rbt.status, rbt.reference,
        rbt.is_reconciled, rbt.date,
        rbt.subtotal, rbt.total_tax, rbt.total,
        rbt.currency_code, rbt.currency_rate,
        rbt.updated_date_utc, now()
      FROM raw_xero.bank_transactions rbt
      LEFT JOIN warehouse.dim_contact dc
        ON dc.tenant_id = rbt.tenant_id AND dc.xero_id = rbt.contact_id
      LEFT JOIN warehouse.dim_account da
        ON da.tenant_id = rbt.tenant_id AND da.xero_id = rbt.bank_account_id
      WHERE rbt.connection_id = ${connectionId}
      ON CONFLICT (tenant_id, xero_id) DO UPDATE SET
        dim_contact_id       = EXCLUDED.dim_contact_id,
        dim_account_id       = EXCLUDED.dim_account_id,
        type                 = EXCLUDED.type,
        status               = EXCLUDED.status,
        reference            = EXCLUDED.reference,
        is_reconciled        = EXCLUDED.is_reconciled,
        date                 = EXCLUDED.date,
        subtotal             = EXCLUDED.subtotal,
        total_tax            = EXCLUDED.total_tax,
        total                = EXCLUDED.total,
        currency_code        = EXCLUDED.currency_code,
        currency_rate        = EXCLUDED.currency_rate,
        xero_updated_at      = EXCLUDED.xero_updated_at,
        warehouse_updated_at = now()
      RETURNING id
    )
    SELECT COUNT(*) AS count FROM upserted
  `;

  return { entity: "fact_bank_transaction", upserted: Number(count), durationMs: Date.now() - start };
}
