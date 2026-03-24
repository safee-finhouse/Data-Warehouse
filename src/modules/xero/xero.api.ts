/**
 * Thin Xero REST API client.
 * Automatically injects the Bearer token and Xero-Tenant-Id header.
 * Handles Xero's /Date(timestamp)/ date format.
 * Includes retry/backoff for 429 rate limits and 5xx errors.
 */
import { getValidAccessToken } from "./token.store.js";

const API_BASE = "https://api.xero.com/api.xro/2.0";
const MAX_RETRIES = 3;

// ─── Date parsing ─────────────────────────────────────────────────────────────
// Xero returns some dates as /Date(1234567890000+0000)/ (.NET JSON format)

export function parseXeroDate(value: string | null | undefined): Date | null {
  if (!value) return null;
  const match = value.match(/\/Date\((\d+)([+-]\d{4})?\)\//);
  if (match) return new Date(parseInt(match[1], 10));
  const d = new Date(value);
  return isNaN(d.getTime()) ? null : d;
}

// ─── Error types ──────────────────────────────────────────────────────────────

export class XeroApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly path: string,
    public readonly body: string,
  ) {
    super(`Xero API ${path} error ${status}: ${body}`);
    this.name = "XeroApiError";
  }
}

export class XeroRateLimitError extends Error {
  constructor(public readonly retryAfterMs: number) {
    super(`Xero rate limit hit — retry after ${retryAfterMs}ms`);
    this.name = "XeroRateLimitError";
  }
}

// ─── Retry/backoff ────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchWithRetry(
  url: string,
  init: RequestInit,
  path: string,
): Promise<Response> {
  let attempt = 0;

  while (true) {
    const res = await fetch(url, init);

    if (res.status === 429) {
      const retryAfter = res.headers.get("Retry-After");
      const waitMs = retryAfter ? parseInt(retryAfter, 10) * 1000 : 60_000;
      if (attempt >= MAX_RETRIES) throw new XeroRateLimitError(waitMs);
      await sleep(waitMs);
      attempt++;
      continue;
    }

    if (res.status >= 500 && res.status < 600) {
      if (attempt >= MAX_RETRIES) {
        const text = await res.text();
        throw new XeroApiError(res.status, path, text);
      }
      // Exponential backoff with jitter: 1s, 2s, 4s + up to 500ms jitter
      const backoff = Math.pow(2, attempt) * 1000 + Math.random() * 500;
      await sleep(backoff);
      attempt++;
      continue;
    }

    return res;
  }
}

// ─── HTTP client ──────────────────────────────────────────────────────────────

export async function xeroGet<T>(
  connectionId: string,
  tenantId: string,
  path: string,
  params?: Record<string, string>,
  headers?: Record<string, string>
): Promise<T> {
  const accessToken = await getValidAccessToken(connectionId);

  const url = new URL(`${API_BASE}/${path}`);
  if (params) {
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  }

  const res = await fetchWithRetry(
    url.toString(),
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Xero-Tenant-Id": tenantId,
        Accept: "application/json",
        ...headers,
      },
    },
    path,
  );

  if (!res.ok) {
    const text = await res.text();
    throw new XeroApiError(res.status, path, text);
  }

  return res.json() as Promise<T>;
}
