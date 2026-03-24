/**
 * Xero OAuth2 helpers.
 *
 * Flow:
 *   1. generateAuthUrl()  → redirect user to Xero
 *   2. exchangeCode()     → on callback, trade code for tokens
 *   3. getTenants()       → get the list of Xero orgs the grant covers
 *   4. refreshTokens()    → call before each API request when token is close to expiry
 *
 * State is signed with APP_SECRET so it is stateless and works across multiple instances.
 */
import crypto from "crypto";
import { env } from "../../config/env.js";

const XERO_AUTH_URL = "https://login.xero.com/identity/connect/authorize";
const XERO_TOKEN_URL = "https://identity.xero.com/connect/token";
const XERO_CONNECTIONS_URL = "https://api.xero.com/connections";

// Note: accounting.transactions is invalid for apps created on or after March 2, 2026.
// Use granular read-only scopes instead (warehouse only needs to read, not write).
const SCOPES = [
  "openid",
  "profile",
  "email",
  "offline_access",
  "accounting.settings.read",
  "accounting.contacts.read",
  "accounting.invoices.read",
  "accounting.payments.read",
  "accounting.banktransactions.read",
].join(" ");

export interface XeroTokenSet {
  access_token: string;
  refresh_token: string;
  expires_in: number;   // seconds
  id_token?: string;
  token_type: string;
}

export interface XeroTenant {
  id: string;           // connection UUID (not the org UUID)
  tenantId: string;     // the Xero org UUID — use this as Xero-Tenant-Id header
  tenantName: string;
  tenantType: string;
}

// ─── State signing ────────────────────────────────────────────────────────────

export function createOAuthState(): string {
  const nonce = crypto.randomBytes(16).toString("hex");
  const hmac = crypto
    .createHmac("sha256", env.APP_SECRET)
    .update(nonce)
    .digest("hex");
  return Buffer.from(`${nonce}.${hmac}`).toString("base64url");
}

export function verifyOAuthState(state: string): boolean {
  try {
    const decoded = Buffer.from(state, "base64url").toString();
    const dotIndex = decoded.indexOf(".");
    if (dotIndex === -1) return false;
    const nonce = decoded.slice(0, dotIndex);
    const hmac = decoded.slice(dotIndex + 1);
    const expected = crypto
      .createHmac("sha256", env.APP_SECRET)
      .update(nonce)
      .digest("hex");
    return crypto.timingSafeEqual(Buffer.from(hmac), Buffer.from(expected));
  } catch {
    return false;
  }
}

// ─── Auth URL ─────────────────────────────────────────────────────────────────

export function generateAuthUrl(state: string): string {
  const params = new URLSearchParams({
    response_type: "code",
    client_id: env.XERO_CLIENT_ID,
    redirect_uri: env.XERO_REDIRECT_URI,
    scope: SCOPES,
    state,
  });
  return `${XERO_AUTH_URL}?${params}`;
}

// ─── Token exchange ───────────────────────────────────────────────────────────

function basicAuth(): string {
  return Buffer.from(
    `${env.XERO_CLIENT_ID}:${env.XERO_CLIENT_SECRET}`
  ).toString("base64");
}

async function postToTokenEndpoint(body: Record<string, string>): Promise<XeroTokenSet> {
  const res = await fetch(XERO_TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: `Basic ${basicAuth()}`,
    },
    body: new URLSearchParams(body).toString(),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Xero token endpoint error ${res.status}: ${text}`);
  }

  return res.json() as Promise<XeroTokenSet>;
}

export async function exchangeCode(code: string): Promise<XeroTokenSet> {
  return postToTokenEndpoint({
    grant_type: "authorization_code",
    code,
    redirect_uri: env.XERO_REDIRECT_URI,
  });
}

export async function refreshTokens(refreshToken: string): Promise<XeroTokenSet> {
  return postToTokenEndpoint({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
  });
}

// ─── Tenants ──────────────────────────────────────────────────────────────────

export async function getTenants(accessToken: string): Promise<XeroTenant[]> {
  const res = await fetch(XERO_CONNECTIONS_URL, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Xero connections error ${res.status}: ${text}`);
  }

  return res.json() as Promise<XeroTenant[]>;
}
