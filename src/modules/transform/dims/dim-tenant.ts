/**
 * dim_tenant transform.
 * Sourced from core.tenants — not raw_xero. Uses the same UUID as core.tenants.id
 * so cross-schema joins are free and no surrogate key translation is needed.
 */
import { sql } from "../../../db/client.js";
import type { TransformResult } from "../transform.types.js";

export async function transformDimTenant(tenantId: string): Promise<TransformResult> {
  const start = Date.now();

  const [{ count }] = await sql<{ count: string }[]>`
    WITH upserted AS (
      INSERT INTO warehouse.dim_tenant (id, name, slug, is_active, warehouse_updated_at)
      SELECT id, name, slug, is_active, now()
      FROM core.tenants
      WHERE id = ${tenantId}
      ON CONFLICT (id) DO UPDATE SET
        name                 = EXCLUDED.name,
        slug                 = EXCLUDED.slug,
        is_active            = EXCLUDED.is_active,
        warehouse_updated_at = now()
      RETURNING id
    )
    SELECT COUNT(*) AS count FROM upserted
  `;

  return { entity: "dim_tenant", upserted: Number(count), durationMs: Date.now() - start };
}
