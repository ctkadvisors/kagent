-- SPDX-License-Identifier: MIT
-- Copyright (c) 2026 Chris Knuteson
--
-- Initial schema for @kagent/llm-gateway. Pared down from
-- archived/ai-gateway/migrations/001_admin_tables.sql:
--   - drops the admin_users / providers / tenants tables (admin UI is
--     deferred per spec §11; tenancy is single-tenant in v1 §6).
--   - drops audit_logs (compliance audit pipeline is v0.2 — usage
--     records carry the same attribution + tokens for billing-grade
--     reporting).
--   - re-shapes pk/sk DynamoDB-style composite keys to plain auto-id
--     primary keys with explicit FKs and indexes.
--   - adds task_uid + agent_name columns on usage_records so the
--     X-Kagent-Task-UID + X-Kagent-Agent attribution headers from
--     agent-pod stamp through to the DB.

CREATE TABLE IF NOT EXISTS schema_migrations (
    version VARCHAR(64) PRIMARY KEY,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ==================== api_keys ====================
-- One row per minted API key. The plaintext key is never stored —
-- only the SHA-256 hex digest, looked up via key_hash on every
-- /v1/chat/completions request.
CREATE TABLE IF NOT EXISTS api_keys (
    id BIGSERIAL PRIMARY KEY,
    key_hash VARCHAR(128) NOT NULL UNIQUE,
    key_prefix VARCHAR(16) NOT NULL,
    name VARCHAR(128) NOT NULL,
    status VARCHAR(32) NOT NULL DEFAULT 'active',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at TIMESTAMPTZ,
    last_used_at TIMESTAMPTZ,
    CONSTRAINT api_keys_status_chk CHECK (status IN ('active', 'revoked', 'expired'))
);
CREATE INDEX IF NOT EXISTS idx_api_keys_status ON api_keys(status);
CREATE INDEX IF NOT EXISTS idx_api_keys_prefix ON api_keys(key_prefix);

-- ==================== usage_records ====================
-- One row per completed /v1/chat/completions call. Replaces the
-- DynamoDB pk/sk shape with a plain id; the kagent attribution
-- columns (task_uid, agent_name) are NULLable so non-kagent
-- consumers can still call the gateway without lying about the
-- header values.
CREATE TABLE IF NOT EXISTS usage_records (
    id BIGSERIAL PRIMARY KEY,
    api_key_id BIGINT REFERENCES api_keys(id) ON DELETE SET NULL,
    api_key_prefix VARCHAR(16),
    request_id VARCHAR(64) NOT NULL,
    occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    model VARCHAR(256) NOT NULL,
    backend VARCHAR(64) NOT NULL,
    backend_url VARCHAR(512),
    input_tokens INTEGER NOT NULL DEFAULT 0,
    output_tokens INTEGER NOT NULL DEFAULT 0,
    total_tokens INTEGER NOT NULL DEFAULT 0,
    latency_ms INTEGER NOT NULL DEFAULT 0,
    status_code INTEGER NOT NULL,
    cost_usd NUMERIC(12, 6) NOT NULL DEFAULT 0,
    streaming BOOLEAN NOT NULL DEFAULT FALSE,
    task_uid VARCHAR(128),
    agent_name VARCHAR(128),
    error_message TEXT
);

CREATE INDEX IF NOT EXISTS idx_usage_occurred_at ON usage_records(occurred_at);
CREATE INDEX IF NOT EXISTS idx_usage_model ON usage_records(model);
CREATE INDEX IF NOT EXISTS idx_usage_backend ON usage_records(backend);
CREATE INDEX IF NOT EXISTS idx_usage_task_uid ON usage_records(task_uid);
CREATE INDEX IF NOT EXISTS idx_usage_agent_name ON usage_records(agent_name);
CREATE INDEX IF NOT EXISTS idx_usage_api_key_id ON usage_records(api_key_id);
