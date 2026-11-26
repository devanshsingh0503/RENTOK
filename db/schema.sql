-- ============================================================
--  LLM Gateway – Database Schema
--  Run this once in your Supabase SQL Editor
-- ============================================================

-- Enable UUID generation
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ── Virtual API Keys ─────────────────────────────────────────
-- Each caller gets one of these instead of a real provider key
CREATE TABLE IF NOT EXISTS virtual_keys (
  id              UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  key             VARCHAR(64)  UNIQUE NOT NULL,          -- e.g. "vk_abc123..."
  name            VARCHAR(255),                           -- human label, e.g. "mobile-app"
  budget_limit    DECIMAL(10,4) NOT NULL DEFAULT 1.00,   -- max spend in USD
  current_spend   DECIMAL(10,4) NOT NULL DEFAULT 0.00,   -- running total spend
  request_count   INT          NOT NULL DEFAULT 0,        -- total requests made
  is_active       BOOLEAN      NOT NULL DEFAULT TRUE,     -- can be disabled manually
  created_at      TIMESTAMPTZ  DEFAULT NOW()
);

-- ── Usage Logs ───────────────────────────────────────────────
-- One row per request that reached an LLM (even failed ones)
CREATE TABLE IF NOT EXISTS usage_logs (
  id                UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  virtual_key       VARCHAR(64)  NOT NULL,
  model             VARCHAR(100) NOT NULL,                -- e.g. "llama-3.3-70b-versatile"
  provider          VARCHAR(50)  NOT NULL,                -- "groq" or "gemini"
  prompt_tokens     INT          NOT NULL DEFAULT 0,
  completion_tokens INT          NOT NULL DEFAULT 0,
  total_tokens      INT          NOT NULL DEFAULT 0,
  cost_usd          DECIMAL(10,6) NOT NULL DEFAULT 0,
  latency_ms        INT,                                  -- round-trip time in ms
  status            VARCHAR(20)  NOT NULL,                -- "success" | "fallback" | "error"
  error_message     TEXT,                                 -- populated on error
  created_at        TIMESTAMPTZ  DEFAULT NOW()
);

-- Index for fast lookups by key
CREATE INDEX IF NOT EXISTS idx_usage_logs_virtual_key ON usage_logs(virtual_key);
CREATE INDEX IF NOT EXISTS idx_usage_logs_created_at  ON usage_logs(created_at DESC);
