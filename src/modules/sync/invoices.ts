/**
 * Syncs invoices from Xero into xero_invoices.
 *
 * - Uses ops.sync_checkpoints for the incremental cursor (If-Modified-Since)
 * - Creates an ops.sync_run_steps record for per-entity tracking
 * - Upserts by (connection_id, xero_invoice_id) — safe to re-run
 */
import { sql } from "../../db/client.js";
import { logger } from "../../lib/logger.js";
import { xeroGet, parseXeroDate } from "../xero/xero.api.js";

const PAGE_SIZE = 100;

interface XeroInvoiceContact {
  ContactID: string;
  Name: string;
}

interface XeroInvoice {
  InvoiceID: string;
  InvoiceNumber: string;
  Type: string;
  Status: string;
  Contact?: XeroInvoiceContact;
  DateString?: string;
  Date?: string;
  DueDateString?: string;
  DueDate?: string;
  AmountDue: number;
  AmountPaid: number;
  SubTotal: number;
  TotalTax: number;
  Total: number;
  CurrencyCode: string;
  UpdatedDateUTC: string;
}

interface XeroInvoicesResponse {
  Invoices: XeroInvoice[];
}

export async function syncInvoices(
  connectionId: string,
  tenantId: string,
  syncRunId: string
): Promise<{ synced: number }> {
  // Create step record
  const [step] = await sql<{ id: string }[]>`
    INSERT INTO ops.sync_run_steps (sync_run_id, entity, status, started_at)
    VALUES (${syncRunId}, 'invoices', 'running', now())
    RETURNING id
  `;

  try {
    // Get incremental cursor from checkpoints
    const [checkpoint] = await sql<{ last_modified_at: Date | null }[]>`
      SELECT last_modified_at
      FROM ops.sync_checkpoints
      WHERE connection_id = ${connectionId} AND entity = 'invoices'
    `;
    const sinceDate = checkpoint?.last_modified_at ?? null;

    // Record the sync start time — this becomes the next checkpoint cursor
    const syncStartedAt = new Date();

    logger.info("Syncing invoices", {
      connectionId,
      since: sinceDate?.toISOString() ?? "beginning",
    });

    let page = 1;
    let totalSynced = 0;

    while (true) {
      const ifModifiedSinceHeader = sinceDate
        ? { "If-Modified-Since": sinceDate.toUTCString() }
        : undefined;

      const data = await xeroGet<XeroInvoicesResponse>(
        connectionId,
        tenantId,
        "Invoices",
        { page: String(page), pageSize: String(PAGE_SIZE) },
        ifModifiedSinceHeader
      );

      const invoices = data.Invoices ?? [];
      if (invoices.length === 0) break;

      for (const inv of invoices) {
        const date      = parseXeroDate(inv.DateString ?? inv.Date);
        const dueDate   = parseXeroDate(inv.DueDateString ?? inv.DueDate);
        const updatedAt = parseXeroDate(inv.UpdatedDateUTC);

        await sql`
          INSERT INTO xero_invoices (
            connection_id, xero_invoice_id, invoice_number, type, status,
            contact_id, contact_name, date, due_date,
            amount_due, amount_paid, subtotal, total_tax, total,
            currency_code, updated_date_utc, raw, synced_at
          ) VALUES (
            ${connectionId}, ${inv.InvoiceID}, ${inv.InvoiceNumber ?? null},
            ${inv.Type}, ${inv.Status},
            ${inv.Contact?.ContactID ?? null}, ${inv.Contact?.Name ?? null},
            ${date}, ${dueDate},
            ${inv.AmountDue}, ${inv.AmountPaid}, ${inv.SubTotal}, ${inv.TotalTax}, ${inv.Total},
            ${inv.CurrencyCode ?? null}, ${updatedAt}, ${JSON.stringify(inv)}, now()
          )
          ON CONFLICT (connection_id, xero_invoice_id) DO UPDATE SET
            invoice_number   = EXCLUDED.invoice_number,
            type             = EXCLUDED.type,
            status           = EXCLUDED.status,
            contact_id       = EXCLUDED.contact_id,
            contact_name     = EXCLUDED.contact_name,
            date             = EXCLUDED.date,
            due_date         = EXCLUDED.due_date,
            amount_due       = EXCLUDED.amount_due,
            amount_paid      = EXCLUDED.amount_paid,
            subtotal         = EXCLUDED.subtotal,
            total_tax        = EXCLUDED.total_tax,
            total            = EXCLUDED.total,
            currency_code    = EXCLUDED.currency_code,
            updated_date_utc = EXCLUDED.updated_date_utc,
            raw              = EXCLUDED.raw,
            synced_at        = now()
        `;
      }

      totalSynced += invoices.length;
      logger.info(`Invoices page ${page} done`, { count: invoices.length });

      if (invoices.length < PAGE_SIZE) break;
      page++;
    }

    // Advance the checkpoint cursor to sync start time
    await sql`
      INSERT INTO ops.sync_checkpoints (connection_id, entity, last_modified_at, last_run_id)
      VALUES (${connectionId}, 'invoices', ${syncStartedAt}, ${syncRunId})
      ON CONFLICT (connection_id, entity) DO UPDATE
        SET last_modified_at = EXCLUDED.last_modified_at,
            last_run_id      = EXCLUDED.last_run_id,
            updated_at       = now()
    `;

    // Mark step complete
    await sql`
      UPDATE ops.sync_run_steps
      SET status = 'completed', records_synced = ${totalSynced}, completed_at = now()
      WHERE id = ${step.id}
    `;

    return { synced: totalSynced };
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    await sql`
      UPDATE ops.sync_run_steps
      SET status = 'failed', error = ${errorMsg}, completed_at = now()
      WHERE id = ${step.id}
    `;
    throw err;
  }
}
