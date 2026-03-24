/**
 * dim_contact transform.
 * Bulk upsert from raw_xero.contacts → warehouse.dim_contact.
 * One row per (tenant_id, xero_id). Safe to re-run.
 */
import { sql } from "../../../db/client.js";
import type { TransformResult } from "../transform.types.js";

export async function transformDimContact(
  connectionId: string,
  _tenantId: string,
): Promise<TransformResult> {
  const start = Date.now();

  const [{ count }] = await sql<{ count: string }[]>`
    WITH upserted AS (
      INSERT INTO warehouse.dim_contact (
        tenant_id, xero_id,
        name, first_name, last_name, email_address,
        contact_status, is_supplier, is_customer,
        tax_number, default_currency,
        xero_updated_at, warehouse_updated_at
      )
      SELECT
        tenant_id, xero_id,
        name, first_name, last_name, email_address,
        contact_status, is_supplier, is_customer,
        tax_number, default_currency,
        updated_date_utc, now()
      FROM raw_xero.contacts
      WHERE connection_id = ${connectionId}
      ON CONFLICT (tenant_id, xero_id) DO UPDATE SET
        name                 = EXCLUDED.name,
        first_name           = EXCLUDED.first_name,
        last_name            = EXCLUDED.last_name,
        email_address        = EXCLUDED.email_address,
        contact_status       = EXCLUDED.contact_status,
        is_supplier          = EXCLUDED.is_supplier,
        is_customer          = EXCLUDED.is_customer,
        tax_number           = EXCLUDED.tax_number,
        default_currency     = EXCLUDED.default_currency,
        xero_updated_at      = EXCLUDED.xero_updated_at,
        warehouse_updated_at = now()
      RETURNING id
    )
    SELECT COUNT(*) AS count FROM upserted
  `;

  return { entity: "dim_contact", upserted: Number(count), durationMs: Date.now() - start };
}
