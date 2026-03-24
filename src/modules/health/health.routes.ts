import { FastifyInstance } from "fastify";
import { sql } from "../../db/client.js";

export async function healthRoutes(app: FastifyInstance) {

  // ── GET /health ─────────────────────────────────────────────────────────────
  // Full liveness check: DB connectivity + warehouse schema reachability.
  // Used by Railway as the deployment healthcheck endpoint.
  app.get("/health", async (_req, reply) => {
    let dbOk = false;
    let warehouseOk = false;
    let migrationsApplied = 0;

    try {
      await sql`SELECT 1`;
      dbOk = true;

      // Verify warehouse schema is queryable (catches incomplete migrations)
      await sql`SELECT COUNT(*) FROM warehouse.dim_tenant`;
      warehouseOk = true;

      const [mig] = await sql<{ c: string }[]>`
        SELECT COUNT(*)::text AS c FROM schema_migrations
      `;
      migrationsApplied = Number(mig.c);
    } catch {
      // intentionally swallowed — status flags reflect the failure
    }

    const status = dbOk && warehouseOk ? "ok" : "degraded";
    const code   = dbOk && warehouseOk ? 200 : 503;

    return reply.code(code).send({
      status,
      version:            process.env.npm_package_version ?? "unknown",
      uptime:             process.uptime(),
      db:                 dbOk        ? "ok" : "unavailable",
      warehouse:          warehouseOk ? "ok" : "unavailable",
      migrations_applied: migrationsApplied,
    });
  });

  // ── GET /ready ──────────────────────────────────────────────────────────────
  // Lightweight readiness probe — does not check DB.
  app.get("/ready", async (_req, reply) => {
    return reply.send({ ready: true });
  });
}
