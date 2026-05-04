-- SPDX-License-Identifier: MIT
-- Copyright (c) 2026 Chris Knuteson
--
-- v0.1.12-keys-rest — extend `api_keys` for the REST admin surface.
--
-- New columns:
--   - revoked_at TIMESTAMPTZ — soft-delete sentinel for DELETE
--     /admin/keys/:id. The `status` enum already encodes 'revoked',
--     but a dedicated timestamp lets the API expose "when was this
--     key revoked" without an audit-table join. NULL on active rows.
--   - model_allowlist TEXT[] — optional per-key model scoping. NULL
--     means "no scope" (any model the gateway routes to is allowed).
--     Empty array also means "no scope" by convention so a JSON
--     null/[] round-trip is harmless. Per-model auth gating is a
--     forward affordance for v0.3 capability bundles; v0.1.12 stores
--     it but doesn't enforce.
--
-- Both columns are NULLable + lack defaults so the migration is
-- non-destructive on existing rows. Idempotent via IF NOT EXISTS.

ALTER TABLE api_keys
    ADD COLUMN IF NOT EXISTS revoked_at TIMESTAMPTZ;

ALTER TABLE api_keys
    ADD COLUMN IF NOT EXISTS model_allowlist TEXT[];

CREATE INDEX IF NOT EXISTS idx_api_keys_revoked_at ON api_keys(revoked_at);
