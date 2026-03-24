/**
 * fact_invoice_line transform.
 * Bulk upsert from raw_xero.invoice_lines → warehouse.fact_invoice_line.
 *
 * fact_invoice_id resolved via LEFT JOIN on (tenant_id, xero_id = xero_invoice_id).
 * dim_account_id resolved via LEFT JOIN on (tenant_id, code = account_code).
 * Must run after fact_invoice and dim_account transforms.
 */
import { sql } from "../../../db/client.js";
import type { TransformResult } from "../transform.types.js";

export async function transformFactInvoiceLine(
  connectionId: string,
  _tenantId: string,
): Promise<TransformResult> {
  const start = Date.now();

  const [{ count }] = await sql<{ count: string }[]>`
    WITH upserted AS (
      INSERT INTO warehouse.fact_invoice_line (
        tenant_id, fact_invoice_id, dim_account_id,
        xero_invoice_id, xero_id,
        description, quantity, unit_amount, line_amount,
        account_code, tax_type, tax_amount, item_code,
        warehouse_updated_at
      )
      SELECT
        ril.tenant_id,
        fi.id   AS fact_invoice_id,
        da.id   AS dim_account_id,
        ril.xero_invoice_id, ril.xero_id,
        ril.description, ril.quantity, ril.unit_amount, ril.line_amount,
        ril.account_code, ril.tax_type, ril.tax_amount, ril.item_code,
        now()
      FROM raw_xero.invoice_lines ril
      LEFT JOIN warehouse.fact_invoice fi
        ON fi.tenant_id = ril.tenant_id AND fi.xero_id = ril.xero_invoice_id
      LEFT JOIN warehouse.dim_account da
        ON da.tenant_id = ril.tenant_id AND da.code = ril.account_code
      WHERE ril.connection_id = ${connectionId}
      ON CONFLICT (tenant_id, xero_invoice_id, xero_id) DO UPDATE SET
        fact_invoice_id      = EXCLUDED.fact_invoice_id,
        dim_account_id       = EXCLUDED.dim_account_id,
        description          = EXCLUDED.description,
        quantity             = EXCLUDED.quantity,
        unit_amount          = EXCLUDED.unit_amount,
        line_amount          = EXCLUDED.line_amount,
        account_code         = EXCLUDED.account_code,
        tax_type             = EXCLUDED.tax_type,
        tax_amount           = EXCLUDED.tax_amount,
        item_code            = EXCLUDED.item_code,
        warehouse_updated_at = now()
      RETURNING id
    )
    SELECT COUNT(*) AS count FROM upserted
  `;

  return { entity: "fact_invoice_line", upserted: Number(count), durationMs: Date.now() - start };
}
