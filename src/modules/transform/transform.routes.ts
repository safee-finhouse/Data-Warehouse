/**
 * Transform routes.
 *
 * POST /transform/connections/:id/run  → run transform for one connection
 */
import { FastifyInstance } from "fastify";
import { sql } from "../../db/client.js";
import { transformConnection } from "./transform.service.js";

export async function transformRoutes(app: FastifyInstance) {
  app.post<{ Params: { id: string } }>(
    "/connections/:id/run",
    async (req, reply) => {
      const [conn] = await sql<{ tenant_id: string }[]>`
        SELECT tenant_id FROM core.xero_connections
        WHERE id = ${req.params.id} AND is_active = true
      `;

      if (!conn) {
        return reply.code(404).send({ error: "Connection not found" });
      }

      const result = await transformConnection(req.params.id, conn.tenant_id);
      return reply.send(result);
    },
  );
}
