-- Migration: 001_initial.sql
-- Created: initial setup
-- Baseline tables to verify migrations work end-to-end.
-- Full schema will be added in subsequent migrations.

CREATE TABLE IF NOT EXISTS organisations (
  id         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  name       TEXT        NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE organisations IS 'Top-level tenant — one row per Xero organisation connected to Finhouse.';
