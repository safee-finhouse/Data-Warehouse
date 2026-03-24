/**
 * Reads and writes Xero tokens from the database.
 * Handles transparent token refresh when the access token is close to expiry.
 */
import { sql } from "../../db/client.js";
import { logger } from "../../lib/logger.js";
import { refreshTokens, type XeroTokenSet } from "./xero.auth.js";

const REFRESH_BUFFER_SECONDS = 300; // refresh if token expires within 5 minutes

export interface StoredToken {
  id: string;
  access_token: string;
  refresh_token: string;
  expires_at: Date;
}

// ─── Persist ──────────────────────────────────────────────────────────────────

export async function saveTokenSet(tokenSet: XeroTokenSet): Promise<string> {
  const expiresAt = new Date(Date.now() + tokenSet.expires_in * 1000);

  const [row] = await sql<{ id: string }[]>`
    INSERT INTO xero_tokens (access_token, refresh_token, expires_at, id_token)
    VALUES (
      ${tokenSet.access_token},
      ${tokenSet.refresh_token},
      ${expiresAt},
      ${tokenSet.id_token ?? null}
    )
    RETURNING id
  `;

  return row.id;
}

export async function updateTokenSet(tokenId: string, tokenSet: XeroTokenSet): Promise<void> {
  const expiresAt = new Date(Date.now() + tokenSet.expires_in * 1000);

  await sql`
    UPDATE xero_tokens
    SET
      access_token  = ${tokenSet.access_token},
      refresh_token = ${tokenSet.refresh_token},
      expires_at    = ${expiresAt},
      id_token      = ${tokenSet.id_token ?? null},
      updated_at    = now()
    WHERE id = ${tokenId}
  `;
}

// ─── Retrieve ─────────────────────────────────────────────────────────────────

export async function getTokenById(tokenId: string): Promise<StoredToken | null> {
  const [row] = await sql<StoredToken[]>`
    SELECT id, access_token, refresh_token, expires_at
    FROM xero_tokens
    WHERE id = ${tokenId}
  `;
  return row ?? null;
}

/**
 * Returns a valid access token for the given connection, refreshing if needed.
 * This is the main function to call before every Xero API request.
 */
export async function getValidAccessToken(connectionId: string): Promise<string> {
  const [row] = await sql<{ token_id: string }[]>`
    SELECT token_id FROM core.xero_connections WHERE id = ${connectionId}
  `;
  if (!row) throw new Error(`Connection not found: ${connectionId}`);

  const token = await getTokenById(row.token_id);
  if (!token) throw new Error(`Token not found for connection: ${connectionId}`);

  const expiresInMs = token.expires_at.getTime() - Date.now();
  const needsRefresh = expiresInMs < REFRESH_BUFFER_SECONDS * 1000;

  if (!needsRefresh) return token.access_token;

  logger.info("Refreshing Xero access token", { connectionId });
  const fresh = await refreshTokens(token.refresh_token);
  await updateTokenSet(token.id, fresh);

  return fresh.access_token;
}
