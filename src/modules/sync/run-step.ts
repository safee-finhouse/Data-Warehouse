/**
 * Wraps an entity sync function in ops.sync_run_steps lifecycle management.
 *
 * Creates the step record, runs the work function, then marks it
 * completed or failed. Throws on failure after recording the error.
 */
import { sql } from "../../db/client.js";
import { logger } from "../../lib/logger.js";

export interface StepResult {
  synced: number;
  durationMs: number;
}

/**
 * @param syncRunId  Parent run ID
 * @param entity     Entity name (e.g. "contacts", "payments")
 * @param work       Async function that fetches/processes records and returns a count
 */
export async function runStep(
  syncRunId: string,
  entity: string,
  work: () => Promise<number>,
): Promise<StepResult> {
  const [step] = await sql<{ id: string }[]>`
    INSERT INTO ops.sync_run_steps (sync_run_id, entity, status, started_at)
    VALUES (${syncRunId}, ${entity}, 'running', now())
    RETURNING id
  `;

  const start = Date.now();

  try {
    const synced = await work();
    const durationMs = Date.now() - start;

    await sql`
      UPDATE ops.sync_run_steps
      SET status = 'completed', records_synced = ${synced}, completed_at = now()
      WHERE id = ${step.id}
    `;

    logger.info(`${entity}: step complete`, { syncRunId, synced, durationMs });
    return { synced, durationMs };
  } catch (err) {
    const durationMs = Date.now() - start;
    const errorMsg = err instanceof Error ? err.message : String(err);

    await sql`
      UPDATE ops.sync_run_steps
      SET status = 'failed', error = ${errorMsg}, completed_at = now()
      WHERE id = ${step.id}
    `;

    logger.error(`${entity}: step failed`, { syncRunId, error: errorMsg, durationMs });
    throw err;
  }
}
