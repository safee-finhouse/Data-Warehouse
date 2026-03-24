/**
 * Contacts sync — writes to raw_xero.contacts.
 *
 * Idempotency: ON CONFLICT (connection_id, xero_id) DO UPDATE
 * Incremental:  reads/writes ops.sync_checkpoints for If-Modified-Since support
 */
import { sql } from "../../../db/client.js";
import { logger } from "../../../lib/logger.js";
import { parseXeroDate } from "../../xero/xero.api.js";
import { listContacts } from "../../xero/xero.client.js";
import { runStep, type StepResult } from "../run-step.js";

export async function syncContacts(
  connectionId: string,
  xeroTenantId: string,
  syncRunId: string,
  tenantId: string,
): Promise<StepResult> {
  return runStep(syncRunId, "contacts", async () => {
    const [cp] = await sql<{ last_modified_at: Date | null }[]>`
      SELECT last_modified_at FROM ops.sync_checkpoints
      WHERE connection_id = ${connectionId} AND entity = 'contacts'
    `;
    const modifiedAfter = cp?.last_modified_at ?? undefined;
    const syncStartedAt = new Date();

    logger.info("contacts: starting sync", {
      connectionId,
      since: modifiedAfter?.toISOString() ?? "beginning",
    });

    let total = 0;

    for await (const page of listContacts(
      { connectionId, xeroTenantId },
      { modifiedAfter },
    )) {
      for (const c of page) {
        const updatedAt = parseXeroDate(c.UpdatedDateUTC);

        await sql`
          INSERT INTO raw_xero.contacts (
            connection_id, tenant_id, xero_id,
            name, first_name, last_name, email_address,
            contact_status, is_supplier, is_customer,
            tax_number, default_currency,
            updated_date_utc, raw
          ) VALUES (
            ${connectionId}, ${tenantId}, ${c.ContactID ?? null},
            ${c.Name ?? null}, ${c.FirstName ?? null}, ${c.LastName ?? null},
            ${c.EmailAddress ?? null},
            ${c.ContactStatus ?? null}, ${c.IsSupplier ?? null}, ${c.IsCustomer ?? null},
            ${c.TaxNumber ?? null}, ${c.DefaultCurrency ?? null},
            ${updatedAt}, ${JSON.stringify(c)}
          )
          ON CONFLICT (connection_id, xero_id) DO UPDATE SET
            name             = EXCLUDED.name,
            first_name       = EXCLUDED.first_name,
            last_name        = EXCLUDED.last_name,
            email_address    = EXCLUDED.email_address,
            contact_status   = EXCLUDED.contact_status,
            is_supplier      = EXCLUDED.is_supplier,
            is_customer      = EXCLUDED.is_customer,
            tax_number       = EXCLUDED.tax_number,
            default_currency = EXCLUDED.default_currency,
            updated_date_utc = EXCLUDED.updated_date_utc,
            raw              = EXCLUDED.raw,
            synced_at        = now()
        `;
      }

      total += page.length;
      logger.info("contacts: page upserted", { count: page.length, total });
    }

    await sql`
      INSERT INTO ops.sync_checkpoints (connection_id, entity, last_modified_at, last_run_id)
      VALUES (${connectionId}, 'contacts', ${syncStartedAt}, ${syncRunId})
      ON CONFLICT (connection_id, entity) DO UPDATE
        SET last_modified_at = EXCLUDED.last_modified_at,
            last_run_id      = EXCLUDED.last_run_id,
            updated_at       = now()
    `;

    return total;
  });
}
