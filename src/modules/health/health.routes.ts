import { FastifyInstance } from "fastify";
import { sql } from "../../db/client.js";

export async function healthRoutes(app: FastifyInstance) {
  app.get("/health", async (_req, reply) => {
    // Quick DB liveness check
    let dbOk = false;
    try {
      await sql`SELECT 1`;
      dbOk = true;
    } catch {
      // db unavailable
    }

    const status = dbOk ? "ok" : "degraded";
    const code = dbOk ? 200 : 503;

    return reply.code(code).send({
      status,
      version: process.env.npm_package_version ?? "unknown",
      uptime: process.uptime(),
      db: dbOk ? "ok" : "unavailable",
    });
  });

  app.get("/ready", async (_req, reply) => {
    return reply.send({ ready: true });
  });
}
