/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { buildJobSpecOptionsFromEnv, parseModelClassesEnv } from './main.js';

/**
 * Snapshot/restore the env vars this suite mutates so tests stay
 * isolated. `process.env` is shared global state.
 */
const TOUCHED_VARS = [
  'KAGENT_AGENT_POD_LITELLM_BASE_URL',
  'KAGENT_AGENT_POD_LITELLM_API_KEY',
  'KAGENT_AGENT_POD_LITELLM_API_KEY_SECRET_NAME',
  'KAGENT_AGENT_POD_LITELLM_API_KEY_SECRET_KEY',
  'KAGENT_LLM_GATEWAY_BASE_URL',
  'KAGENT_LLM_GATEWAY_API_KEY',
  'KAGENT_LLM_GATEWAY_API_KEY_SECRET_NAME',
  'KAGENT_LLM_GATEWAY_API_KEY_SECRET_KEY',
  'KAGENT_AGENT_POD_LANGFUSE_HOST',
  'KAGENT_AGENT_POD_LANGFUSE_PUBLIC_KEY',
  'KAGENT_AGENT_POD_LANGFUSE_PUBLIC_KEY_SECRET_NAME',
  'KAGENT_AGENT_POD_LANGFUSE_PUBLIC_KEY_SECRET_KEY',
  'KAGENT_AGENT_POD_LANGFUSE_SECRET_KEY',
  'KAGENT_AGENT_POD_LANGFUSE_SECRET_KEY_SECRET_NAME',
  'KAGENT_AGENT_POD_LANGFUSE_SECRET_KEY_SECRET_KEY',
  'KAGENT_AGENT_POD_OTLP_HEADERS',
  'KAGENT_AGENT_POD_OTLP_HEADERS_SECRET_NAME',
  'KAGENT_AGENT_POD_OTLP_HEADERS_SECRET_KEY',
  'KAGENT_AUDIT_NATS_URL',
  // v0.1 P3 wire-up — artifact PVC plumbing.
  'KAGENT_ARTIFACT_PVC_NAME',
  'KAGENT_ARTIFACT_MOUNT_PATH',
  'KAGENT_ARTIFACT_MAX_BYTES',
  // Phase-2 modelClass — chart-supplied logical→physical model map.
  'KAGENT_AGENT_MODEL_CLASSES_JSON',
  // Audit BLOCKER #1 (C2.1) — capability mount required-by-default
  // opt-out flag forwarded from operator chart into spawned agent-pods.
  'KAGENT_CAPABILITY_ALLOW_MISSING',
] as const;

let snapshot: Partial<Record<(typeof TOUCHED_VARS)[number], string | undefined>>;

beforeEach(() => {
  snapshot = {};
  for (const k of TOUCHED_VARS) {
    snapshot[k] = process.env[k];
    delete process.env[k];
  }
});

afterEach(() => {
  for (const k of TOUCHED_VARS) {
    if (snapshot[k] === undefined) delete process.env[k];
    else process.env[k] = snapshot[k];
  }
});

/**
 * Each entry rendered into `BuildJobSpecOptions.extraEnv` is one of:
 *   - inline plaintext: { name, value }
 *   - secret-ref:       { name, valueFrom: { secretKeyRef: { name, key } } }
 * Tests use this loose shape so they can grep for either surface
 * without re-importing the EnvVarSpec union.
 */
type ExtraEnvEntry = {
  name: string;
  value?: string;
  valueFrom?: {
    secretKeyRef?: { name: string; key: string };
  };
};

function findEnv(extraEnv: readonly ExtraEnvEntry[], name: string): string | undefined {
  return extraEnv.find((e) => e.name === name)?.value;
}

function findEnvEntry(extraEnv: readonly ExtraEnvEntry[], name: string): ExtraEnvEntry | undefined {
  return extraEnv.find((e) => e.name === name);
}

describe('buildJobSpecOptionsFromEnv — LLM endpoint resolution', () => {
  it('forwards KAGENT_AGENT_POD_LITELLM_BASE_URL into spawned-Job env when gateway is unset', () => {
    process.env.KAGENT_AGENT_POD_LITELLM_BASE_URL = 'http://lm-studio.local:1234/v1';
    process.env.KAGENT_AGENT_POD_LITELLM_API_KEY = 'lm-key';

    const opts = buildJobSpecOptionsFromEnv();
    const env = opts.extraEnv ?? [];
    expect(findEnv(env, 'KAGENT_LITELLM_BASE_URL')).toBe('http://lm-studio.local:1234/v1');
    expect(findEnv(env, 'KAGENT_LITELLM_API_KEY')).toBe('lm-key');
  });

  it('overrides KAGENT_LITELLM_BASE_URL with the gateway URL when KAGENT_LLM_GATEWAY_BASE_URL is set', () => {
    process.env.KAGENT_AGENT_POD_LITELLM_BASE_URL = 'http://lm-studio.local:1234/v1';
    process.env.KAGENT_AGENT_POD_LITELLM_API_KEY = 'lm-key';
    process.env.KAGENT_LLM_GATEWAY_BASE_URL =
      'http://kagent-llm-gateway.kagent-system.svc.cluster.local:4000/v1';
    process.env.KAGENT_LLM_GATEWAY_API_KEY = 'gw-key';

    const opts = buildJobSpecOptionsFromEnv();
    const env = opts.extraEnv ?? [];
    expect(findEnv(env, 'KAGENT_LITELLM_BASE_URL')).toBe(
      'http://kagent-llm-gateway.kagent-system.svc.cluster.local:4000/v1',
    );
    expect(findEnv(env, 'KAGENT_LITELLM_API_KEY')).toBe('gw-key');
    // Critically: NO duplicate KAGENT_LITELLM_BASE_URL — Kubernetes
    // would reject the pod spec for duplicate env names.
    const baseUrlCount = env.filter((e) => e.name === 'KAGENT_LITELLM_BASE_URL').length;
    expect(baseUrlCount).toBe(1);
    const apiKeyCount = env.filter((e) => e.name === 'KAGENT_LITELLM_API_KEY').length;
    expect(apiKeyCount).toBe(1);
  });

  it('omits the API key entirely when neither litellm nor gateway key is set', () => {
    process.env.KAGENT_AGENT_POD_LITELLM_BASE_URL = 'http://anon.local/v1';

    const opts = buildJobSpecOptionsFromEnv();
    const env = opts.extraEnv ?? [];
    expect(findEnv(env, 'KAGENT_LITELLM_BASE_URL')).toBe('http://anon.local/v1');
    expect(findEnv(env, 'KAGENT_LITELLM_API_KEY')).toBeUndefined();
  });

  it('falls back to gateway URL with no API key when gateway is set without a key', () => {
    process.env.KAGENT_LLM_GATEWAY_BASE_URL = 'http://gw.local/v1';
    // Note: NO gateway API key, NO litellm key.

    const opts = buildJobSpecOptionsFromEnv();
    const env = opts.extraEnv ?? [];
    expect(findEnv(env, 'KAGENT_LITELLM_BASE_URL')).toBe('http://gw.local/v1');
    expect(findEnv(env, 'KAGENT_LITELLM_API_KEY')).toBeUndefined();
  });

  it('omits both when neither litellm nor gateway URL is set', () => {
    const opts = buildJobSpecOptionsFromEnv();
    const env = opts.extraEnv ?? [];
    expect(findEnv(env, 'KAGENT_LITELLM_BASE_URL')).toBeUndefined();
    expect(findEnv(env, 'KAGENT_LITELLM_API_KEY')).toBeUndefined();
  });
});

describe('buildJobSpecOptionsFromEnv — audit forwarding', () => {
  it('forwards KAGENT_AUDIT_NATS_URL into spawned agent-pods', () => {
    process.env.KAGENT_AUDIT_NATS_URL = 'nats://nats.kagent-system.svc.cluster.local:4222';

    const opts = buildJobSpecOptionsFromEnv();
    const env = opts.extraEnv ?? [];
    expect(findEnv(env, 'KAGENT_AUDIT_NATS_URL')).toBe(
      'nats://nats.kagent-system.svc.cluster.local:4222',
    );
  });
});

/* =====================================================================
 * Audit BLOCKER #1 (C2.1, docs/AUDIT-2026-05-06.md) — capability mount
 * is required-by-default. The chart's `agentPod.capability.allowMissing`
 * value is projected onto the operator deployment as
 * KAGENT_CAPABILITY_ALLOW_MISSING; the operator MUST forward it onto
 * every spawned agent-pod's env so the agent-pod's `loadCapabilityOptional`
 * sees the same source of truth at boot. Default is "false" (loud-fail
 * when the JWT mount is missing); chart override of "true" is the
 * fail-open opt-out and surfaces a runtime WARN in the agent-pod.
 * ===================================================================== */
describe('buildJobSpecOptionsFromEnv — capability allow-missing forwarding (audit C2.1 BLOCKER #1)', () => {
  it('forwards KAGENT_CAPABILITY_ALLOW_MISSING=true into spawned agent-pods when set on the operator', () => {
    process.env.KAGENT_CAPABILITY_ALLOW_MISSING = 'true';

    const opts = buildJobSpecOptionsFromEnv();
    const env = opts.extraEnv ?? [];
    expect(findEnv(env, 'KAGENT_CAPABILITY_ALLOW_MISSING')).toBe('true');
  });

  it('forwards KAGENT_CAPABILITY_ALLOW_MISSING=false into spawned agent-pods (default chart posture)', () => {
    process.env.KAGENT_CAPABILITY_ALLOW_MISSING = 'false';

    const opts = buildJobSpecOptionsFromEnv();
    const env = opts.extraEnv ?? [];
    expect(findEnv(env, 'KAGENT_CAPABILITY_ALLOW_MISSING')).toBe('false');
  });
});

/* =====================================================================
 * v0.1.8 — secret-hygiene. Brief §1: when the operator's own env was
 * sourced from a secretRef (chart sets `<NAME>_SECRET_NAME` +
 * `<NAME>_SECRET_KEY` alongside the env), the operator forwards the
 * spawned-Job env as a secretKeyRef rather than copying the resolved
 * plaintext value.
 *
 * Convention: for every sensitive operator env var `<NAME>`, the chart
 * exposes two side env vars holding the original Secret coordinates:
 *   `<NAME>_SECRET_NAME`  → Secret name in the operator's release ns
 *   `<NAME>_SECRET_KEY`   → key within that Secret
 * When both are non-empty, the operator constructs a secretKeyRef
 * entry and OMITS the inline plaintext value entry — even if the
 * resolved env is also present (it would be, since K8s injects via
 * envFrom). This keeps the rendered Job spec free of any plaintext for
 * names matching /KEY|SECRET/i, the contract the unit test in
 * job-spec.test.ts pins.
 * ===================================================================== */

describe('buildJobSpecOptionsFromEnv — secret-hygiene (v0.1.8)', () => {
  it('forwards LiteLLM API key as a secretKeyRef when the chart provides _SECRET_NAME + _SECRET_KEY', () => {
    process.env.KAGENT_AGENT_POD_LITELLM_BASE_URL = 'http://lm-studio.local:1234/v1';
    // The plaintext is also injected via envFrom (K8s does it); the
    // operator MUST ignore it in favor of the secret-ref hint.
    process.env.KAGENT_AGENT_POD_LITELLM_API_KEY = 'lm-key-resolved';
    process.env.KAGENT_AGENT_POD_LITELLM_API_KEY_SECRET_NAME = 'cloudflare-ai-gateway';
    process.env.KAGENT_AGENT_POD_LITELLM_API_KEY_SECRET_KEY = 'api-key';

    const opts = buildJobSpecOptionsFromEnv();
    const env = (opts.extraEnv ?? []) as ExtraEnvEntry[];
    const apiKeyEntry = findEnvEntry(env, 'KAGENT_LITELLM_API_KEY');
    expect(apiKeyEntry).toBeDefined();
    expect(apiKeyEntry?.value).toBeUndefined();
    expect(apiKeyEntry?.valueFrom?.secretKeyRef?.name).toBe('cloudflare-ai-gateway');
    expect(apiKeyEntry?.valueFrom?.secretKeyRef?.key).toBe('api-key');
  });

  it('forwards LLM-gateway API key as a secretKeyRef when chart provides the hints', () => {
    process.env.KAGENT_LLM_GATEWAY_BASE_URL = 'http://gw/v1';
    process.env.KAGENT_LLM_GATEWAY_API_KEY = 'gw-resolved-token';
    process.env.KAGENT_LLM_GATEWAY_API_KEY_SECRET_NAME = 'kagent-llm-gateway-token';
    process.env.KAGENT_LLM_GATEWAY_API_KEY_SECRET_KEY = 'token';

    const opts = buildJobSpecOptionsFromEnv();
    const env = (opts.extraEnv ?? []) as ExtraEnvEntry[];
    const apiKeyEntry = findEnvEntry(env, 'KAGENT_LITELLM_API_KEY');
    expect(apiKeyEntry?.value).toBeUndefined();
    expect(apiKeyEntry?.valueFrom?.secretKeyRef?.name).toBe('kagent-llm-gateway-token');
    expect(apiKeyEntry?.valueFrom?.secretKeyRef?.key).toBe('token');
  });

  it('forwards Langfuse public + secret keys as secretKeyRefs when chart provides the hints', () => {
    process.env.KAGENT_AGENT_POD_LANGFUSE_HOST = 'http://lf';
    process.env.KAGENT_AGENT_POD_LANGFUSE_PUBLIC_KEY = 'pk-resolved';
    process.env.KAGENT_AGENT_POD_LANGFUSE_PUBLIC_KEY_SECRET_NAME = 'langfuse-creds';
    process.env.KAGENT_AGENT_POD_LANGFUSE_PUBLIC_KEY_SECRET_KEY = 'public';
    process.env.KAGENT_AGENT_POD_LANGFUSE_SECRET_KEY = 'sk-resolved';
    process.env.KAGENT_AGENT_POD_LANGFUSE_SECRET_KEY_SECRET_NAME = 'langfuse-creds';
    process.env.KAGENT_AGENT_POD_LANGFUSE_SECRET_KEY_SECRET_KEY = 'secret';

    const opts = buildJobSpecOptionsFromEnv();
    const env = (opts.extraEnv ?? []) as ExtraEnvEntry[];

    const pkEntry = findEnvEntry(env, 'KAGENT_LANGFUSE_PUBLIC_KEY');
    expect(pkEntry?.value).toBeUndefined();
    expect(pkEntry?.valueFrom?.secretKeyRef?.name).toBe('langfuse-creds');
    expect(pkEntry?.valueFrom?.secretKeyRef?.key).toBe('public');

    const skEntry = findEnvEntry(env, 'KAGENT_LANGFUSE_SECRET_KEY');
    expect(skEntry?.value).toBeUndefined();
    expect(skEntry?.valueFrom?.secretKeyRef?.name).toBe('langfuse-creds');
    expect(skEntry?.valueFrom?.secretKeyRef?.key).toBe('secret');
  });

  it('forwards OTLP headers as a secretKeyRef when chart provides the hints (bearer token typically lives there)', () => {
    process.env.KAGENT_AGENT_POD_OTLP_HEADERS =
      'authorization=Bearer%20resolved,x-langfuse-ingestion-version=4';
    process.env.KAGENT_AGENT_POD_OTLP_HEADERS_SECRET_NAME = 'otel-headers';
    process.env.KAGENT_AGENT_POD_OTLP_HEADERS_SECRET_KEY = 'headers';

    const opts = buildJobSpecOptionsFromEnv();
    const env = (opts.extraEnv ?? []) as ExtraEnvEntry[];
    const hdrEntry = findEnvEntry(env, 'OTEL_EXPORTER_OTLP_HEADERS');
    expect(hdrEntry?.value).toBeUndefined();
    expect(hdrEntry?.valueFrom?.secretKeyRef?.name).toBe('otel-headers');
    expect(hdrEntry?.valueFrom?.secretKeyRef?.key).toBe('headers');
  });

  it('falls back to plaintext value: when only the resolved env is present (deprecated path; NOTES.txt warns)', () => {
    // Deprecated path: NOTES.txt prints a loud warning so single-tenant
    // dev installs that haven't migrated to secretRefs still work end-
    // to-end. Ops grep `kubectl get pod ... | grep value:` will surface
    // these immediately.
    process.env.KAGENT_AGENT_POD_LITELLM_BASE_URL = 'http://lm';
    process.env.KAGENT_AGENT_POD_LITELLM_API_KEY = 'plain-old-key';

    const opts = buildJobSpecOptionsFromEnv();
    const env = (opts.extraEnv ?? []) as ExtraEnvEntry[];
    const apiKeyEntry = findEnvEntry(env, 'KAGENT_LITELLM_API_KEY');
    expect(apiKeyEntry?.value).toBe('plain-old-key');
    expect(apiKeyEntry?.valueFrom).toBeUndefined();
  });

  it('omits the env entirely when no plaintext AND no secret-ref hints are set', () => {
    process.env.KAGENT_AGENT_POD_LITELLM_BASE_URL = 'http://lm';
    // Nothing else.

    const opts = buildJobSpecOptionsFromEnv();
    const env = (opts.extraEnv ?? []) as ExtraEnvEntry[];
    expect(findEnvEntry(env, 'KAGENT_LITELLM_API_KEY')).toBeUndefined();
  });

  it('rendered extraEnv has ZERO inline value: entries for any name matching /KEY|SECRET/i when secret-ref hints set everywhere', () => {
    // The validation criterion from the brief: rendered Job spec must
    // contain zero `value:` entries for any name matching the
    // sensitive-name regex once the chart provides secret hints for
    // every secret. This test pins the operator's main.ts contribution
    // to that contract.
    process.env.KAGENT_AGENT_POD_LITELLM_BASE_URL = 'http://lm';
    process.env.KAGENT_AGENT_POD_LITELLM_API_KEY = 'p1';
    process.env.KAGENT_AGENT_POD_LITELLM_API_KEY_SECRET_NAME = 's1';
    process.env.KAGENT_AGENT_POD_LITELLM_API_KEY_SECRET_KEY = 'k1';

    process.env.KAGENT_AGENT_POD_LANGFUSE_HOST = 'http://lf';
    process.env.KAGENT_AGENT_POD_LANGFUSE_PUBLIC_KEY = 'p2';
    process.env.KAGENT_AGENT_POD_LANGFUSE_PUBLIC_KEY_SECRET_NAME = 's2';
    process.env.KAGENT_AGENT_POD_LANGFUSE_PUBLIC_KEY_SECRET_KEY = 'k2';
    process.env.KAGENT_AGENT_POD_LANGFUSE_SECRET_KEY = 'p3';
    process.env.KAGENT_AGENT_POD_LANGFUSE_SECRET_KEY_SECRET_NAME = 's3';
    process.env.KAGENT_AGENT_POD_LANGFUSE_SECRET_KEY_SECRET_KEY = 'k3';

    process.env.KAGENT_AGENT_POD_OTLP_HEADERS = 'authorization=Bearer%20x';
    process.env.KAGENT_AGENT_POD_OTLP_HEADERS_SECRET_NAME = 's4';
    process.env.KAGENT_AGENT_POD_OTLP_HEADERS_SECRET_KEY = 'k4';

    const opts = buildJobSpecOptionsFromEnv();
    const env = (opts.extraEnv ?? []) as ExtraEnvEntry[];
    const sensitive = /(?:KEY|SECRET)/i;
    const offenders = env.filter(
      (e) => sensitive.test(e.name) && typeof e.value === 'string' && e.value.length > 0,
    );
    expect(offenders).toEqual([]);
  });
});

/* =====================================================================
 * v0.1 P3 wire-up — artifact PVC plumbing.
 *
 * The operator's deployment.yaml stamps `KAGENT_ARTIFACT_PVC_NAME`,
 * `KAGENT_ARTIFACT_MOUNT_PATH`, and `KAGENT_ARTIFACT_MAX_BYTES` onto
 * the operator's own env (gated on `agentPod.artifactStorage.enabled`).
 * `buildJobSpecOptionsFromEnv` reads them and produces an `artifactPvc`
 * block that `buildJobSpec` then renders into every spawned Job's env
 * + volume mount.
 * ===================================================================== */

describe('buildJobSpecOptionsFromEnv — artifactPvc plumbing (P3)', () => {
  it('omits artifactPvc entirely when KAGENT_ARTIFACT_PVC_NAME is unset', () => {
    const opts = buildJobSpecOptionsFromEnv();
    expect(opts.artifactPvc).toBeUndefined();
  });

  it('threads claimName + mountPath + maxBytes when all three env vars are set', () => {
    process.env.KAGENT_ARTIFACT_PVC_NAME = 'kagent-artifacts';
    process.env.KAGENT_ARTIFACT_MOUNT_PATH = '/var/kagent/artifacts';
    process.env.KAGENT_ARTIFACT_MAX_BYTES = '26214400';

    const opts = buildJobSpecOptionsFromEnv();
    expect(opts.artifactPvc).toEqual({
      claimName: 'kagent-artifacts',
      mountPath: '/var/kagent/artifacts',
      maxBytes: 26214400,
    });
  });

  it('omits maxBytes when KAGENT_ARTIFACT_MAX_BYTES is unset', () => {
    process.env.KAGENT_ARTIFACT_PVC_NAME = 'kagent-artifacts';
    process.env.KAGENT_ARTIFACT_MOUNT_PATH = '/var/kagent/artifacts';

    const opts = buildJobSpecOptionsFromEnv();
    expect(opts.artifactPvc).toEqual({
      claimName: 'kagent-artifacts',
      mountPath: '/var/kagent/artifacts',
    });
    expect((opts.artifactPvc as { maxBytes?: unknown }).maxBytes).toBeUndefined();
  });

  it('drops malformed maxBytes values silently (operator falls through to agent-pod default)', () => {
    process.env.KAGENT_ARTIFACT_PVC_NAME = 'kagent-artifacts';
    for (const bad of ['', '0', '-1', 'NaN', 'big', '12.5']) {
      process.env.KAGENT_ARTIFACT_MAX_BYTES = bad;
      const opts = buildJobSpecOptionsFromEnv();
      expect((opts.artifactPvc as { maxBytes?: unknown }).maxBytes).toBeUndefined();
    }
  });
});

/* =====================================================================
 * Phase-2 modelClass — KAGENT_AGENT_MODEL_CLASSES_JSON parser.
 *
 * The chart's deployment.yaml projects `agent.modelClasses` (a YAML
 * map) into the operator pod via `toJson | quote`. main.ts parses
 * once at boot and threads the parsed map into BuildJobSpecOptions.
 *
 * Contract per docs/MODEL-ROUTING.md + brief:
 *   - Empty / unset env → empty map (`{}`).
 *   - Non-JSON → throw (operator boot fail-loud, CrashLoop visible).
 *   - JSON with non-string values → drop those entries (warn-log;
 *     keep the well-formed ones).
 * ===================================================================== */

describe('parseModelClassesEnv — Phase-2 modelClass map parser', () => {
  it('returns an empty map when the env var is unset', () => {
    expect(parseModelClassesEnv(undefined)).toEqual({});
  });

  it('returns an empty map when the env var is the empty string', () => {
    expect(parseModelClassesEnv('')).toEqual({});
  });

  it('parses a well-formed JSON object with string values verbatim', () => {
    const raw = JSON.stringify({
      'tool-caller-default': 'workers-ai/@cf/meta/llama-4-scout-17b-16e-instruct',
      'text-generator-default': 'ollama/nemotron-3-nano:4b',
    });
    expect(parseModelClassesEnv(raw)).toEqual({
      'tool-caller-default': 'workers-ai/@cf/meta/llama-4-scout-17b-16e-instruct',
      'text-generator-default': 'ollama/nemotron-3-nano:4b',
    });
  });

  it('throws on non-JSON input (operator boot fail-loud)', () => {
    expect(() => parseModelClassesEnv('this is not json')).toThrow(
      /KAGENT_AGENT_MODEL_CLASSES_JSON/,
    );
  });

  it('throws on JSON that is not an object (top-level array, string, number)', () => {
    expect(() => parseModelClassesEnv('[]')).toThrow(/KAGENT_AGENT_MODEL_CLASSES_JSON/);
    expect(() => parseModelClassesEnv('"foo"')).toThrow(/KAGENT_AGENT_MODEL_CLASSES_JSON/);
    expect(() => parseModelClassesEnv('42')).toThrow(/KAGENT_AGENT_MODEL_CLASSES_JSON/);
    expect(() => parseModelClassesEnv('null')).toThrow(/KAGENT_AGENT_MODEL_CLASSES_JSON/);
  });

  it('drops entries whose values are not strings; keeps the well-formed ones', () => {
    const raw = JSON.stringify({
      'tool-caller-default': 'workers-ai/@cf/meta/llama-4-scout',
      'broken-num': 42,
      'broken-obj': { model: 'nested' },
      'text-generator-default': 'ollama/nemotron-3-nano:4b',
      'broken-null': null,
    });
    expect(parseModelClassesEnv(raw)).toEqual({
      'tool-caller-default': 'workers-ai/@cf/meta/llama-4-scout',
      'text-generator-default': 'ollama/nemotron-3-nano:4b',
    });
  });

  it('returns an empty map when JSON object has no string-valued entries', () => {
    const raw = JSON.stringify({ 'broken-num': 42, 'broken-null': null });
    expect(parseModelClassesEnv(raw)).toEqual({});
  });
});
