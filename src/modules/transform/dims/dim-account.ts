/**
 * dim_account transform.
 * Bulk upsert from raw_xero.accounts → warehouse.dim_account.
 * Derives is_bank_account from type = 'BANK'.
 */
import { sql } from "../../../db/client.js";
import type { TransformResult } from "../transform.types.js";

export async function transformDimAccount(
  connectionId: string,
  _tenantId: string,
): Promise<TransformResult> {
  const start = Date.now();

  const [{ count }] = await sql<{ count: string }[]>`
    WITH upserted AS (
      INSERT INTO warehouse.dim_account (
        tenant_id, xero_id,
        code, name, type, status, class,
        description, tax_type,
        is_bank_account,
        xero_updated_at, warehouse_updated_at
      )
      SELECT
        tenant_id, xero_id,
        code, name, type, status, class,
        description, tax_type,
        (type = 'BANK'),
        updated_date_utc, now()
      FROM raw_xero.accounts
      WHERE connection_id = ${connectionId}
      ON CONFLICT (tenant_id, xero_id) DO UPDATE SET
        code                 = EXCLUDED.code,
        name                 = EXCLUDED.name,
        type                 = EXCLUDED.type,
        status               = EXCLUDED.status,
        class                = EXCLUDED.class,
        description          = EXCLUDED.description,
        tax_type             = EXCLUDED.tax_type,
        is_bank_account      = EXCLUDED.is_bank_account,
        xero_updated_at      = EXCLUDED.xero_updated_at,
        warehouse_updated_at = now()
      RETURNING id
    )
    SELECT COUNT(*) AS count FROM upserted
  `;

  return { entity: "dim_account", upserted: Number(count), durationMs: Date.now() - start };
}
