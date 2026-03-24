/**
 * Manual inputs service.
 *
 * Handles the two-phase CSV upload pipeline:
 *
 *   Phase 1 — createBatch + storeRawRows
 *     Creates an upload_batch record and persists raw CSV rows as JSONB.
 *     Fast and idempotent — safe to call even if normalisation fails later.
 *
 *   Phase 2 — processUpload
 *     Reads raw rows from the DB, normalises each one, then upserts into
 *     uncoded_statement_lines. Uses ON CONFLICT (tenant_id, dedup_hash) so
 *     re-uploading the same CSV is safe.
 *
 * Typical call sequence:
 *   const batchId = await createBatch(tenantId, filename, rows.length);
 *   await storeRawRows(batchId, tenantId, rows);
 *   await processUpload(batchId);
 */
import { sql } from "../../db/client.js";
import { logger } from "../../lib/logger.js";
import { normaliseRow } from "./normalise.js";
import type { RawCsvRow } from "./manual-inputs.types.js";

export async function createBatch(
  tenantId: string,
  filename: string,
  rowCount: number,
  uploadedBy?: string,
): Promise<string> {
  const [row] = await sql<{ id: string }[]>`
    INSERT INTO manual_inputs.upload_batches
      (tenant_id, uploaded_by, filename, row_count, status)
    VALUES
      (${tenantId}, ${uploadedBy ?? null}, ${filename}, ${rowCount}, 'pending')
    RETURNING id
  `;
  return row.id;
}

export async function storeRawRows(
  batchId: string,
  tenantId: string,
  rows: RawCsvRow[],
): Promise<void> {
  for (let i = 0; i < rows.length; i++) {
    await sql`
      INSERT INTO manual_inputs.uncoded_statement_line_uploads
        (batch_id, tenant_id, row_index, raw)
      VALUES
        (${batchId}, ${tenantId}, ${i}, ${sql.json(rows[i])})
      ON CONFLICT (batch_id, row_index) DO NOTHING
    `;
  }
}

export async function processUpload(
  batchId: string,
  currencyCode = "GBP",
): Promise<{ processed: number; skipped: number; errors: string[] }> {
  await sql`
    UPDATE manual_inputs.upload_batches
    SET status = 'processing'
    WHERE id = ${batchId}
  `;

  const uploads = await sql<{
    id: string;
    tenant_id: string;
    raw: RawCsvRow;
  }[]>`
    SELECT id, tenant_id, raw
    FROM manual_inputs.uncoded_statement_line_uploads
    WHERE batch_id = ${batchId}
    ORDER BY row_index
  `;

  if (uploads.length === 0) {
    await sql`
      UPDATE manual_inputs.upload_batches
      SET status = 'completed', completed_at = now(), row_count = 0
      WHERE id = ${batchId}
    `;
    return { processed: 0, skipped: 0, errors: [] };
  }

  const tenantId = uploads[0].tenant_id;

  let processed = 0;
  let skipped = 0;
  const errors: string[] = [];

  for (const upload of uploads) {
    try {
      const line = normaliseRow(tenantId, upload.raw, currencyCode);

      await sql`
        INSERT INTO manual_inputs.uncoded_statement_lines
          (tenant_id, batch_id, upload_id,
           date, description, amount, reference, currency_code, dedup_hash)
        VALUES
          (${tenantId}, ${batchId}, ${upload.id},
           ${line.date}, ${line.description}, ${line.amount},
           ${line.reference}, ${line.currencyCode}, ${line.dedupHash})
        ON CONFLICT (tenant_id, dedup_hash) DO NOTHING
      `;
      processed++;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      errors.push(msg);
      skipped++;
      logger.warn("manual_inputs: row skipped", { batchId, error: msg });
    }
  }

  const finalStatus = errors.length === uploads.length ? "failed" : "completed";
  const errorSummary = errors.length > 0 ? errors.slice(0, 5).join("; ") : null;

  await sql`
    UPDATE manual_inputs.upload_batches
    SET status = ${finalStatus},
        completed_at = now(),
        row_count = ${processed},
        error = ${errorSummary}
    WHERE id = ${batchId}
  `;

  logger.info("manual_inputs: upload processed", {
    batchId, tenantId, processed, skipped,
  });

  return { processed, skipped, errors };
}
