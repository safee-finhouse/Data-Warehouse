/**
 * API route tests using Fastify's inject() — no network required.
 */
import { describe, test, expect, beforeAll, afterAll } from "vitest";
import Fastify, { FastifyInstance } from "fastify";
import sensible from "@fastify/sensible";
import { healthRoutes } from "../../src/modules/health/health.routes.js";
import { xeroRoutes } from "../../src/modules/xero/xero.routes.js";
import { syncRoutes } from "../../src/modules/sync/sync.routes.js";
import { sql } from "../../src/db/client.js";

let app: FastifyInstance;

beforeAll(async () => {
  app = Fastify({ logger: false });
  await app.register(sensible);
  await app.register(healthRoutes);
  await app.register(xeroRoutes, { prefix: "/xero" });
  await app.register(syncRoutes, { prefix: "/sync" });
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await sql.end();
});

// ─── Health ───────────────────────────────────────────────────────────────────

describe("GET /health", () => {
  test("returns 200 with status ok and db ok", async () => {
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.status).toBe("ok");
    expect(body.db).toBe("ok");
    expect(typeof body.uptime).toBe("number");
  });
});

describe("GET /ready", () => {
  test("returns 200 with ready true", async () => {
    const res = await app.inject({ method: "GET", url: "/ready" });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).ready).toBe(true);
  });
});

// ─── Xero OAuth ───────────────────────────────────────────────────────────────

describe("GET /xero/connect", () => {
  test("redirects to Xero login", async () => {
    const res = await app.inject({ method: "GET", url: "/xero/connect" });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toContain("login.xero.com");
  });

  test("redirect URL includes client_id", async () => {
    const res = await app.inject({ method: "GET", url: "/xero/connect" });
    expect(res.headers.location).toContain("client_id=");
  });
});

describe("GET /xero/callback — validation", () => {
  test("returns 400 when code and state are missing", async () => {
    const res = await app.inject({ method: "GET", url: "/xero/callback" });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toContain("Missing");
  });

  test("returns 400 when only code is present", async () => {
    const res = await app.inject({ method: "GET", url: "/xero/callback?code=abc" });
    expect(res.statusCode).toBe(400);
  });

  test("returns 400 when state is invalid", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/xero/callback?code=abc&state=tampered",
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toContain("Invalid state");
  });

  test("returns 400 when Xero sends an error param", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/xero/callback?error=access_denied",
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toContain("Xero declined");
  });
});

describe("GET /xero/connections", () => {
  test("returns array of connections", async () => {
    const res = await app.inject({ method: "GET", url: "/xero/connections" });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(Array.isArray(body)).toBe(true);
  });

  test("includes Shuffle Finance connection", async () => {
    const res = await app.inject({ method: "GET", url: "/xero/connections" });
    const body = JSON.parse(res.body);
    const conn = body.find((c: { xero_tenant_name: string }) =>
      c.xero_tenant_name === "Shuffle Finance"
    );
    expect(conn).toBeDefined();
    expect(conn.is_active).toBe(true);
  });
});

// ─── Sync ─────────────────────────────────────────────────────────────────────

describe("GET /sync/connections", () => {
  test("returns connections with invoice counts", async () => {
    const res = await app.inject({ method: "GET", url: "/sync/connections" });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(Array.isArray(body)).toBe(true);
    expect(Number(body[0].invoice_count)).toBeGreaterThan(0);
  });

  test("includes last run status", async () => {
    const res = await app.inject({ method: "GET", url: "/sync/connections" });
    const body = JSON.parse(res.body);
    expect(body[0].last_run_status).toBe("completed");
  });
});

describe("GET /sync/runs", () => {
  test("returns array of runs", async () => {
    const res = await app.inject({ method: "GET", url: "/sync/runs" });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(Array.isArray(body)).toBe(true);
    expect(body.length).toBeGreaterThan(0);
  });

  test("most recent run is completed", async () => {
    const res = await app.inject({ method: "GET", url: "/sync/runs" });
    const body = JSON.parse(res.body);
    expect(body[0].status).toBe("completed");
  });

  test("respects limit query param", async () => {
    const res = await app.inject({ method: "GET", url: "/sync/runs?limit=1" });
    const body = JSON.parse(res.body);
    expect(body.length).toBe(1);
  });
});

describe("GET /sync/runs/:id", () => {
  test("returns run with steps", async () => {
    const listRes = await app.inject({ method: "GET", url: "/sync/runs" });
    const runId = JSON.parse(listRes.body)[0].id;

    const res = await app.inject({ method: "GET", url: `/sync/runs/${runId}` });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.id).toBe(runId);
    expect(Array.isArray(body.steps)).toBe(true);
    expect(body.steps[0].entity).toBe("invoices");
    expect(body.steps[0].status).toBe("completed");
    expect(Number(body.steps[0].records_synced)).toBeGreaterThan(0);
  });

  test("returns 404 for unknown run id", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/sync/runs/00000000-0000-0000-0000-000000000000",
    });
    expect(res.statusCode).toBe(404);
  });
});
