-- Migration: 002_xero_connections.sql
-- Stores Xero OAuth tokens and connected organisation (tenant) metadata.

-- One row per OAuth grant. A single grant can cover multiple Xero tenants.
CREATE TABLE xero_tokens (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  access_token  TEXT        NOT NULL,
  refresh_token TEXT        NOT NULL,
  expires_at    TIMESTAMPTZ NOT NULL,
  id_token      TEXT,
  -- TODO: encrypt access_token + refresh_token at rest before production
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One row per Xero tenant (organisation) connected via OAuth.
CREATE TABLE xero_connections (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  token_id    UUID        NOT NULL REFERENCES xero_tokens(id),
  tenant_id   TEXT        NOT NULL UNIQUE,   -- Xero's org UUID
  tenant_name TEXT        NOT NULL,
  tenant_type TEXT        NOT NULL DEFAULT 'ORGANISATION',
  is_active   BOOLEAN     NOT NULL DEFAULT true,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
