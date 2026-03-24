/**
 * Accounts sync — writes to raw_xero.accounts.
 *
 * Idempotency: ON CONFLICT (connection_id, xero_id) DO UPDATE
 * Note: Xero does not support If-Modified-Since for accounts — always a full sync.
 */
import { sql } from "../../../db/client.js";
import { logger } from "../../../lib/logger.js";
import { parseXeroDate } from "../../xero/xero.api.js";
import { listAccounts } from "../../xero/xero.client.js";
import { runStep, type StepResult } from "../run-step.js";

export async function syncAccounts(
  connectionId: string,
  xeroTenantId: string,
  syncRunId: string,
  tenantId: string,
): Promise<StepResult> {
  return runStep(syncRunId, "accounts", async () => {
    logger.info("accounts: starting sync", { connectionId });

    let total = 0;

    for await (const page of listAccounts({ connectionId, xeroTenantId })) {
      for (const a of page) {
        const updatedAt = parseXeroDate(a.UpdatedDateUTC);

        await sql`
          INSERT INTO raw_xero.accounts (
            connection_id, tenant_id, xero_id,
            code, name, type, status, class,
            description, tax_type, system_account,
            enable_payments,
            updated_date_utc, raw
          ) VALUES (
            ${connectionId}, ${tenantId}, ${a.AccountID ?? null},
            ${a.Code ?? null}, ${a.Name ?? null}, ${a.Type ?? null}, ${a.Status ?? null}, ${a.Class ?? null},
            ${a.Description ?? null}, ${a.TaxType ?? null},
            ${a.SystemAccount ?? null},
            ${a.EnablePaymentsToAccount ?? null},
            ${updatedAt}, ${JSON.stringify(a)}
          )
          ON CONFLICT (connection_id, xero_id) DO UPDATE SET
            code             = EXCLUDED.code,
            name             = EXCLUDED.name,
            type             = EXCLUDED.type,
            status           = EXCLUDED.status,
            class            = EXCLUDED.class,
            description      = EXCLUDED.description,
            tax_type         = EXCLUDED.tax_type,
            system_account   = EXCLUDED.system_account,
            enable_payments  = EXCLUDED.enable_payments,
            updated_date_utc = EXCLUDED.updated_date_utc,
            raw              = EXCLUDED.raw,
            synced_at        = now()
        `;
      }

      total += page.length;
      logger.info("accounts: upserted", { count: page.length, total });
    }

    return total;
  });
}
