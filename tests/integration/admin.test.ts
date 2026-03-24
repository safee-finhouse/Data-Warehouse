/**
 * Admin dashboard API route tests.
 * Uses Fastify inject() — no network required.
 */
import { describe, test, expect, beforeAll, afterAll } from "vitest";
import Fastify, { FastifyInstance } from "fastify";
import sensible from "@fastify/sensible";
import { adminRoutes } from "../../src/modules/admin/admin.routes.js";
import { sql } from "../../src/db/client.js";

let app: FastifyInstance;

beforeAll(async () => {
  app = Fastify({ logger: false });
  await app.register(sensible);
  await app.register(adminRoutes, { prefix: "/admin" });
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await sql.end();
});

// ─── /admin/metrics ───────────────────────────────────────────────────────────

describe("GET /admin/metrics", () => {
  test("returns 200", async () => {
    const res = await app.inject({ method: "GET", url: "/admin/metrics" });
    expect(res.statusCode).toBe(200);
  });

  test("has all expected fields", async () => {
    const res = await app.inject({ method: "GET", url: "/admin/metrics" });
    const body = JSON.parse(res.body);
    const required = [
      "total_tenants", "active_tenants",
      "total_connections", "active_connections", "stale_connections",
      "syncs_last_24h", "failed_syncs_last_24h", "syncs_currently_running",
      "total_invoices", "total_payments", "total_contacts",
      "pending_uploads", "generated_at",
    ];
    for (const field of required) {
      expect(body, `missing field: ${field}`).toHaveProperty(field);
    }
  });

  test("active_tenants is a non-negative integer", async () => {
    const res = await app.inject({ method: "GET", url: "/admin/metrics" });
    const { active_tenants } = JSON.parse(res.body);
    expect(Number(active_tenants)).toBeGreaterThanOrEqual(0);
  });
});

// ─── /admin/tenants ───────────────────────────────────────────────────────────

describe("GET /admin/tenants", () => {
  test("returns 200 with an array", async () => {
    const res = await app.inject({ method: "GET", url: "/admin/tenants" });
    expect(res.statusCode).toBe(200);
    expect(Array.isArray(JSON.parse(res.body))).toBe(true);
  });

  test("each entry has required fields", async () => {
    const res = await app.inject({ method: "GET", url: "/admin/tenants" });
    const rows = JSON.parse(res.body);
    if (rows.length === 0) return; // skip if no data in test DB
    const row = rows[0];
    expect(row).toHaveProperty("tenant_id");
    expect(row).toHaveProperty("tenant_name");
    expect(row).toHaveProperty("freshness_status");
    expect(row).toHaveProperty("invoice_count");
  });
});

// ─── /admin/sync/history ─────────────────────────────────────────────────────

describe("GET /admin/sync/history", () => {
  test("returns 200 with an array", async () => {
    const res = await app.inject({ method: "GET", url: "/admin/sync/history" });
    expect(res.statusCode).toBe(200);
    expect(Array.isArray(JSON.parse(res.body))).toBe(true);
  });

  test("respects ?limit param", async () => {
    const res = await app.inject({ method: "GET", url: "/admin/sync/history?limit=1" });
    const body = JSON.parse(res.body);
    expect(body.length).toBeLessThanOrEqual(1);
  });

  test("filters by ?status=completed", async () => {
    const res = await app.inject({ method: "GET", url: "/admin/sync/history?status=completed" });
    const body = JSON.parse(res.body);
    for (const run of body) {
      expect(run.status).toBe("completed");
    }
  });

  test("each entry has step aggregate fields", async () => {
    const res = await app.inject({ method: "GET", url: "/admin/sync/history?limit=1" });
    const body = JSON.parse(res.body);
    if (body.length === 0) return;
    expect(body[0]).toHaveProperty("total_steps");
    expect(body[0]).toHaveProperty("total_records_synced");
  });
});

// ─── /admin/sync/history/:id ──────────────────────────────────────────────────

describe("GET /admin/sync/history/:id", () => {
  test("returns 404 for unknown id", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/admin/sync/history/00000000-0000-0000-0000-000000000000",
    });
    expect(res.statusCode).toBe(404);
  });

  test("returns run with steps for a known id", async () => {
    const listRes = await app.inject({ method: "GET", url: "/admin/sync/history?limit=1" });
    const list = JSON.parse(listRes.body);
    if (list.length === 0) return;

    const res = await app.inject({ method: "GET", url: `/admin/sync/history/${list[0].id}` });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.id).toBe(list[0].id);
    expect(Array.isArray(body.steps)).toBe(true);
  });
});

// ─── /admin/freshness ─────────────────────────────────────────────────────────

describe("GET /admin/freshness", () => {
  test("returns 200 with an array", async () => {
    const res = await app.inject({ method: "GET", url: "/admin/freshness" });
    expect(res.statusCode).toBe(200);
    expect(Array.isArray(JSON.parse(res.body))).toBe(true);
  });

  test("?staleOnly=true returns only stale/never_synced rows", async () => {
    const res = await app.inject({ method: "GET", url: "/admin/freshness?staleOnly=true" });
    const body = JSON.parse(res.body);
    for (const row of body) {
      expect(["stale", "never_synced"]).toContain(row.freshness_status);
    }
  });
});

// ─── /admin/uploads ───────────────────────────────────────────────────────────

describe("GET /admin/uploads", () => {
  test("returns 200 with an array", async () => {
    const res = await app.inject({ method: "GET", url: "/admin/uploads" });
    expect(res.statusCode).toBe(200);
    expect(Array.isArray(JSON.parse(res.body))).toBe(true);
  });
});

// ─── /admin/errors ────────────────────────────────────────────────────────────

describe("GET /admin/errors", () => {
  test("returns 200 with hours and rows", async () => {
    const res = await app.inject({ method: "GET", url: "/admin/errors" });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body).toHaveProperty("hours");
    expect(Array.isArray(body.rows)).toBe(true);
  });

  test("respects ?hours param", async () => {
    const res = await app.inject({ method: "GET", url: "/admin/errors?hours=6" });
    expect(JSON.parse(res.body).hours).toBe(6);
  });
});
