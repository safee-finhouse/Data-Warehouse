/**
 * Xero OAuth2 routes.
 *
 * GET    /xero/connect           → redirects user to Xero login
 * GET    /xero/callback          → handles code exchange, saves tokens + connections
 * GET    /xero/connections       → lists all connected Xero orgs
 * DELETE /xero/connections/:id   → marks a connection inactive
 */
import { FastifyInstance } from "fastify";
import { sql } from "../../db/client.js";
import { logger } from "../../lib/logger.js";
import {
  createOAuthState,
  verifyOAuthState,
  generateAuthUrl,
  exchangeCode,
  getTenants,
} from "./xero.auth.js";
import { saveTokenSet } from "./token.store.js";

export async function xeroRoutes(app: FastifyInstance) {
  // ── GET /xero/connect ────────────────────────────────────────────────────────
  app.get("/connect", async (_req, reply) => {
    const state = createOAuthState();
    return reply.redirect(generateAuthUrl(state));
  });

  // ── GET /xero/callback ───────────────────────────────────────────────────────
  app.get<{
    Querystring: { code?: string; state?: string; error?: string };
  }>("/callback", async (req, reply) => {
    const { code, state, error } = req.query;

    if (error) {
      logger.warn("Xero OAuth error", { error });
      return reply.code(400).send({ error: `Xero declined: ${error}` });
    }
    if (!code || !state) {
      return reply.code(400).send({ error: "Missing code or state" });
    }
    if (!verifyOAuthState(state)) {
      return reply.code(400).send({ error: "Invalid state parameter" });
    }

    const tokenSet = await exchangeCode(code);
    const tokenId  = await saveTokenSet(tokenSet);
    const tenants  = await getTenants(tokenSet.access_token);

    if (tenants.length === 0) {
      return reply.code(400).send({ error: "No Xero organisations found in this grant" });
    }

    const connected: string[] = [];

    for (const tenant of tenants) {
      // Ensure a core.tenant exists for this Xero org
      const slug = tenant.tenantName.toLowerCase().replace(/[^a-z0-9]+/g, "-");
      const [tenantRow] = await sql<{ id: string }[]>`
        INSERT INTO core.tenants (name, slug)
        VALUES (${tenant.tenantName}, ${slug})
        ON CONFLICT (slug) DO UPDATE
          SET name = EXCLUDED.name, updated_at = now()
        RETURNING id
      `;

      await sql`
        INSERT INTO core.xero_connections
          (tenant_id, token_id, xero_tenant_id, xero_tenant_name, xero_tenant_type)
        VALUES
          (${tenantRow.id}, ${tokenId}, ${tenant.tenantId}, ${tenant.tenantName}, ${tenant.tenantType})
        ON CONFLICT (xero_tenant_id) DO UPDATE
          SET token_id         = EXCLUDED.token_id,
              xero_tenant_name = EXCLUDED.xero_tenant_name,
              is_active        = true,
              updated_at       = now()
      `;

      connected.push(tenant.tenantName);
      logger.info("Xero connection saved", { tenantName: tenant.tenantName });
    }

    return reply.send({
      ok: true,
      connected,
      message: `Connected ${connected.length} Xero organisation(s). Use POST /sync/connections/:id/run to sync.`,
    });
  });

  // ── GET /xero/connections ────────────────────────────────────────────────────
  app.get("/connections", async (_req, reply) => {
    const rows = await sql`
      SELECT
        c.id,
        t.name          AS tenant_name,
        c.xero_tenant_id,
        c.xero_tenant_name,
        c.xero_tenant_type,
        c.is_active,
        c.created_at
      FROM core.xero_connections c
      JOIN core.tenants t ON t.id = c.tenant_id
      ORDER BY c.created_at DESC
    `;
    return reply.send(rows);
  });

  // ── DELETE /xero/connections/:id ─────────────────────────────────────────────
  app.delete<{ Params: { id: string } }>("/connections/:id", async (req, reply) => {
    await sql`
      UPDATE core.xero_connections
      SET is_active = false, updated_at = now()
      WHERE id = ${req.params.id}
    `;
    return reply.send({ ok: true });
  });
}
