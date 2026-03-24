/**
 * Manual inputs API routes.
 *
 * POST /manual-inputs/upload
 *   Body: { tenantId, filename, rows: RawCsvRow[], currencyCode? }
 *   Runs both phases (store + process) and returns the batch result.
 *
 * GET /manual-inputs/:batchId/lines
 *   Returns normalised lines for a batch (for review UI / Tool 5).
 *
 * PATCH /manual-inputs/lines/:lineId
 *   Updates coding fields (account_code, category, etc.) and/or approves a line.
 */
import type { FastifyInstance } from "fastify";
import { sql } from "../../db/client.js";
import { createBatch, storeRawRows, processUpload } from "./manual-inputs.service.js";

export async function manualInputsRoutes(app: FastifyInstance) {
  // ── POST /manual-inputs/upload ──────────────────────────────────────────────
  app.post<{
    Body: {
      tenantId: string;
      filename: string;
      rows: Record<string, string>[];
      currencyCode?: string;
    };
  }>("/manual-inputs/upload", async (req, reply) => {
    const { tenantId, filename, rows, currencyCode } = req.body;

    if (!tenantId || !filename || !Array.isArray(rows) || rows.length === 0) {
      return reply.code(400).send({ error: "tenantId, filename, and rows are required" });
    }

    const batchId = await createBatch(tenantId, filename, rows.length);
    await storeRawRows(batchId, tenantId, rows);
    const result = await processUpload(batchId, currencyCode);

    return reply.code(201).send({ batchId, ...result });
  });

  // ── GET /manual-inputs/:batchId/lines ───────────────────────────────────────
  app.get<{ Params: { batchId: string } }>(
    "/manual-inputs/:batchId/lines",
    async (req, reply) => {
      const { batchId } = req.params;

      const lines = await sql`
        SELECT
          id, tenant_id, date, description, amount, reference, currency_code,
          account_code, account_name, category, tax_type, notes,
          is_suggested, approved, approved_at, dedup_hash, created_at
        FROM manual_inputs.uncoded_statement_lines
        WHERE batch_id = ${batchId}
        ORDER BY date, description
      `;

      return reply.send({ lines });
    },
  );

  // ── PATCH /manual-inputs/lines/:lineId ──────────────────────────────────────
  app.patch<{
    Params: { lineId: string };
    Body: {
      accountCode?: string;
      accountName?: string;
      category?: string;
      taxType?: string;
      notes?: string;
      approved?: boolean;
      approvedBy?: string;
    };
  }>("/manual-inputs/lines/:lineId", async (req, reply) => {
    const { lineId } = req.params;
    const { accountCode, accountName, category, taxType, notes, approved, approvedBy } = req.body;

    const [line] = await sql<{ id: string }[]>`
      UPDATE manual_inputs.uncoded_statement_lines
      SET
        account_code  = COALESCE(${accountCode ?? null}, account_code),
        account_name  = COALESCE(${accountName ?? null}, account_name),
        category      = COALESCE(${category ?? null}, category),
        tax_type      = COALESCE(${taxType ?? null}, tax_type),
        notes         = COALESCE(${notes ?? null}, notes),
        approved      = COALESCE(${approved ?? null}, approved),
        approved_by   = COALESCE(${approvedBy ?? null}, approved_by),
        approved_at   = CASE WHEN ${approved ?? null} = true THEN now() ELSE approved_at END,
        updated_at    = now()
      WHERE id = ${lineId}
      RETURNING id
    `;

    if (!line) return reply.code(404).send({ error: "Line not found" });

    return reply.send({ id: line.id, updated: true });
  });
}
