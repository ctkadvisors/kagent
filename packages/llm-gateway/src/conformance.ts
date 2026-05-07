/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/**
 * External gateway conformance probe for the kagent gateway contract.
 *
 * This is intentionally transport-small: it depends on a fetch-shaped
 * function, emits a JSON-serialisable report, and never requires a live
 * gateway in unit tests. The CLI wrapper can point the same harness at
 * an enterprise gateway during RC evidence collection.
 */

import type { ChatCompletionRequest } from './types.js';

export type GatewayConformanceStatus = 'pass' | 'fail' | 'warn' | 'skip';

export type GatewayConformanceCheckId =
  | 'chat.required_headers'
  | 'chat.openai_response'
  | 'chat.backpressure_retry_after'
  | 'rotation.endpoint'
  | 'identity.mtls_svid_fallback';

export interface GatewayConformanceCheck {
  readonly id: GatewayConformanceCheckId;
  readonly status: GatewayConformanceStatus;
  readonly expected: string;
  readonly observed: unknown;
  readonly notes?: string;
}

export interface GatewayConformanceReport {
  readonly target: string;
  readonly generatedAt: string;
  readonly checks: readonly GatewayConformanceCheck[];
}

export interface GatewayConformanceFetchInit {
  readonly method?: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: string;
}

export interface GatewayConformanceHeaders {
  get(name: string): string | null;
}

export interface GatewayConformanceFetchResponse {
  readonly status: number;
  readonly ok: boolean;
  readonly headers: GatewayConformanceHeaders;
  json(): Promise<unknown>;
}

export type GatewayConformanceFetchFn = (
  input: string,
  init?: GatewayConformanceFetchInit,
) => Promise<GatewayConformanceFetchResponse>;

export interface MtlsSvidExpectation {
  readonly gatewayMtlsEnabled: boolean;
  readonly svidAvailable: boolean;
  readonly bearerFallbackAllowed: boolean;
}

export interface GatewayConformanceInput {
  /** Gateway root URL, without `/v1`. A trailing slash is accepted. */
  readonly gatewayUrl: string;
  /** A model name accepted by the target gateway. */
  readonly model: string;
  /** Bearer token used for `/v1/chat/completions`. */
  readonly apiToken: string;
  /** Optional bearer token for `POST /v1/admin/keys/rotate`. */
  readonly adminToken?: string;
  readonly fetch?: GatewayConformanceFetchFn;
  readonly now?: () => Date;
  readonly traceparent?: string;
  readonly taskUid?: string;
  readonly agentName?: string;
  readonly tenant?: string;
  readonly requestBody?: ChatCompletionRequest;
  readonly mtls?: MtlsSvidExpectation;
}

export const DEFAULT_CONFORMANCE_TRACEPARENT =
  '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01';

const DEFAULT_TASK_UID = 'conformance-task-uid';
const DEFAULT_AGENT_NAME = 'conformance-agent';
const DEFAULT_TENANT = 'conformance-tenant';

const DEFAULT_MTLS_SVID_EXPECTATION: MtlsSvidExpectation = {
  gatewayMtlsEnabled: false,
  svidAvailable: false,
  bearerFallbackAllowed: true,
};

export function buildChatProbeHeaders(
  input: Pick<
    GatewayConformanceInput,
    'apiToken' | 'traceparent' | 'taskUid' | 'agentName' | 'tenant'
  >,
): Readonly<Record<string, string>> {
  return {
    Authorization: `Bearer ${input.apiToken}`,
    'Content-Type': 'application/json',
    traceparent: input.traceparent ?? DEFAULT_CONFORMANCE_TRACEPARENT,
    'X-Kagent-Task-UID': input.taskUid ?? DEFAULT_TASK_UID,
    'X-Kagent-Agent': input.agentName ?? DEFAULT_AGENT_NAME,
    'X-Kagent-Tenant': input.tenant ?? DEFAULT_TENANT,
  };
}

/**
 * H19 — record-shape evaluator for the mTLS / SVID fallback posture.
 *
 * The previous name `evaluateMtlsSvidFallback` implied this function
 * actively *probed* the gateway's TLS handshake / SPIRE workload-API
 * socket. It does not — it reads the caller-supplied expectation
 * struct and emits a `pass` / `fail` based on declared values. That
 * shape is fine for documenting the intended posture in CI and for
 * Enterprise Pilot RC evidence (alongside the live-runbook in
 * GATEWAY-CONFORMANCE.md), but the *function name* needs to advertise
 * "I did not actually probe; I am recording an expectation."
 *
 * Renamed accordingly. The new return shape additionally tags
 * `source: 'declared'` so report consumers can filter for live
 * probes when those land. A future `probeMtlsSvid` (path (a) in the
 * audit) will emit `source: 'probed'` from the same dimension; the
 * arbiter can then tell at a glance whether RC evidence is from a
 * live probe or a declared expectation.
 *
 * Back-compat: the old name is re-exported as a deprecated alias so
 * any external callers (e.g. conformance-cli) keep compiling. New
 * code should import `recordMtlsSvidExpectation`.
 */
export function recordMtlsSvidExpectation(
  input: MtlsSvidExpectation = DEFAULT_MTLS_SVID_EXPECTATION,
): GatewayConformanceCheck {
  const observed = {
    source: 'declared' as const,
    gatewayMtlsEnabled: input.gatewayMtlsEnabled,
    svidAvailable: input.svidAvailable,
    bearerFallbackAllowed: input.bearerFallbackAllowed,
  };
  const expected =
    'Gateway auth has an available path: mTLS with SVID, or bearer fallback when mTLS/SVID is unavailable. (declared expectation; live probe lives in GATEWAY-CONFORMANCE.md runbook)';

  if (input.gatewayMtlsEnabled && input.svidAvailable) {
    return check({
      id: 'identity.mtls_svid_fallback',
      status: 'pass',
      expected,
      observed: { ...observed, selectedPath: 'mtls_svid' },
    });
  }

  if (input.bearerFallbackAllowed) {
    return check({
      id: 'identity.mtls_svid_fallback',
      status: 'pass',
      expected,
      observed: { ...observed, selectedPath: 'bearer_fallback' },
      notes: 'SVID/mTLS is not the active path for this probe; bearer fallback remains available.',
    });
  }

  return check({
    id: 'identity.mtls_svid_fallback',
    status: 'fail',
    expected,
    observed: { ...observed, selectedPath: 'none' },
    notes: 'Neither SVID-backed mTLS nor bearer fallback is available.',
  });
}

/**
 * @deprecated Renamed to `recordMtlsSvidExpectation` (H19) to make
 * "this evaluator does not probe; it records a declared expectation"
 * legible from the function name. Kept as an alias for back-compat;
 * remove in v0.3.
 */
export const evaluateMtlsSvidFallback = recordMtlsSvidExpectation;

export async function runGatewayConformance(
  input: GatewayConformanceInput,
): Promise<GatewayConformanceReport> {
  const fetchFn = input.fetch ?? defaultFetch;
  const now = input.now ?? defaultNow;
  const target = normalizeGatewayUrl(input.gatewayUrl);
  const checks: GatewayConformanceCheck[] = [];

  const chatHeaders = buildChatProbeHeaders(input);
  checks.push(evaluateRequiredHeaders(chatHeaders));

  try {
    const response = await fetchFn(`${target}/v1/chat/completions`, {
      method: 'POST',
      headers: chatHeaders,
      body: JSON.stringify(input.requestBody ?? buildDefaultChatBody(input.model)),
    });
    checks.push(...(await evaluateChatResponse(response, input.model)));
  } catch (err) {
    checks.push(
      check({
        id: 'chat.openai_response',
        status: 'fail',
        expected:
          'POST /v1/chat/completions returns an OpenAI-compatible response or explicit backpressure.',
        observed: {
          error: err instanceof Error ? err.message : String(err),
        },
      }),
    );
    checks.push(
      check({
        id: 'chat.backpressure_retry_after',
        status: 'skip',
        expected: '429/503 responses include Retry-After seconds.',
        observed: { reason: 'chat_probe_failed_before_response' },
      }),
    );
  }

  checks.push(await probeRotationEndpoint(target, input.adminToken, fetchFn));
  checks.push(recordMtlsSvidExpectation(input.mtls));

  return {
    target,
    generatedAt: now().toISOString(),
    checks,
  };
}

function buildDefaultChatBody(model: string): ChatCompletionRequest {
  return {
    model,
    messages: [
      {
        role: 'user',
        content: 'kagent gateway conformance probe. Reply with ok.',
      },
    ],
    temperature: 0,
    max_tokens: 4,
    stream: false,
  };
}

function evaluateRequiredHeaders(
  headers: Readonly<Record<string, string>>,
): GatewayConformanceCheck {
  const required = [
    'traceparent',
    'X-Kagent-Task-UID',
    'X-Kagent-Agent',
    'X-Kagent-Tenant',
  ] as const;
  const missing = required.filter((name) => (headers[name] ?? '').trim().length === 0);
  const traceparent = headers.traceparent ?? '';
  const traceparentValid = isValidTraceparent(traceparent);
  const observed = {
    stampedHeaders: required,
    missing,
    traceparentValid,
  };

  if (missing.length > 0 || !traceparentValid) {
    return check({
      id: 'chat.required_headers',
      status: 'fail',
      expected:
        'Probe stamps W3C traceparent plus X-Kagent-Task-UID, X-Kagent-Agent, and X-Kagent-Tenant.',
      observed,
    });
  }

  return check({
    id: 'chat.required_headers',
    status: 'pass',
    expected:
      'Probe stamps W3C traceparent plus X-Kagent-Task-UID, X-Kagent-Agent, and X-Kagent-Tenant.',
    observed,
  });
}

async function evaluateChatResponse(
  response: GatewayConformanceFetchResponse,
  expectedModel: string,
): Promise<GatewayConformanceCheck[]> {
  const retryAfter = getHeader(response, 'Retry-After');
  const commonObserved = {
    status: response.status,
    retryAfter,
    requestId: getHeader(response, 'X-Request-Id'),
    modelUsed: getHeader(response, 'X-Model-Used'),
    cacheStatus: getHeader(response, 'X-Cache-Status'),
  };

  if (response.status === 429 || response.status === 503) {
    return [
      check({
        id: 'chat.openai_response',
        status: 'skip',
        expected: '2xx responses use the OpenAI chat completion body shape.',
        observed: commonObserved,
        notes: 'Backpressure response observed; success body shape was not evaluated.',
      }),
      evaluateRetryAfter(response.status, retryAfter),
    ];
  }

  const backpressureSkip = check({
    id: 'chat.backpressure_retry_after',
    status: 'skip',
    expected: '429/503 responses include Retry-After seconds.',
    observed: { ...commonObserved, reason: 'status_was_not_429_or_503' },
  });

  if (!response.ok) {
    return [
      check({
        id: 'chat.openai_response',
        status: 'fail',
        expected: 'POST /v1/chat/completions returns a 2xx OpenAI-compatible response.',
        observed: commonObserved,
      }),
      backpressureSkip,
    ];
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch (err) {
    return [
      check({
        id: 'chat.openai_response',
        status: 'fail',
        expected: '2xx responses contain parseable JSON in the OpenAI chat completion shape.',
        observed: {
          ...commonObserved,
          error: err instanceof Error ? err.message : String(err),
        },
      }),
      backpressureSkip,
    ];
  }

  const bodyShape = inspectOpenAIChatCompletion(body);
  return [
    check({
      id: 'chat.openai_response',
      status: bodyShape.ok ? 'pass' : 'fail',
      expected: '2xx responses contain id, object=chat.completion, model, choices[], and usage.',
      observed: {
        ...commonObserved,
        requestedModel: expectedModel,
        bodyShape,
      },
    }),
    backpressureSkip,
  ];
}

function evaluateRetryAfter(status: number, retryAfter: string | null): GatewayConformanceCheck {
  const parsed = retryAfter !== null ? Number(retryAfter.trim()) : Number.NaN;
  const valid = retryAfter !== null && Number.isInteger(parsed) && parsed >= 0;
  return check({
    id: 'chat.backpressure_retry_after',
    status: valid ? 'pass' : 'fail',
    expected: '429/503 responses include Retry-After as non-negative integer seconds.',
    observed: {
      status,
      retryAfter,
      parsedSeconds: valid ? parsed : null,
    },
  });
}

async function probeRotationEndpoint(
  target: string,
  adminToken: string | undefined,
  fetchFn: GatewayConformanceFetchFn,
): Promise<GatewayConformanceCheck> {
  const expected =
    'POST /v1/admin/keys/rotate accepts an admin bearer token and returns 2xx with optional rotationId; 404 is classified as unsupported fallback.';
  if (adminToken === undefined || adminToken.length === 0) {
    return check({
      id: 'rotation.endpoint',
      status: 'skip',
      expected,
      observed: { reason: 'admin_token_not_supplied' },
    });
  }

  let response: GatewayConformanceFetchResponse;
  try {
    response = await fetchFn(`${target}/v1/admin/keys/rotate`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${adminToken}`,
        'Content-Type': 'application/json',
      },
      body: '{}',
    });
  } catch (err) {
    return check({
      id: 'rotation.endpoint',
      status: 'fail',
      expected,
      observed: {
        error: err instanceof Error ? err.message : String(err),
      },
    });
  }

  if (response.status === 404) {
    return check({
      id: 'rotation.endpoint',
      status: 'warn',
      expected,
      observed: { status: 404, rotationId: null },
      notes:
        'Gateway is behind the key-rotation extension; kagent falls back to unsupported/no-op handling.',
    });
  }

  if (!response.ok) {
    return check({
      id: 'rotation.endpoint',
      status: 'fail',
      expected,
      observed: { status: response.status },
    });
  }

  let rotationId: string | null = null;
  try {
    const body = await response.json();
    if (typeof body === 'object' && body !== null && 'rotationId' in body) {
      const candidate = (body as Record<string, unknown>).rotationId;
      if (typeof candidate === 'string') rotationId = candidate;
    }
  } catch {
    rotationId = null;
  }

  return check({
    id: 'rotation.endpoint',
    status: 'pass',
    expected,
    observed: { status: response.status, rotationId },
  });
}

function inspectOpenAIChatCompletion(body: unknown): {
  readonly ok: boolean;
  readonly missing: readonly string[];
} {
  const missing: string[] = [];
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return { ok: false, missing: ['body_object'] };
  }
  const obj = body as Record<string, unknown>;
  if (typeof obj.id !== 'string' || obj.id.length === 0) missing.push('id');
  if (obj.object !== 'chat.completion') missing.push('object');
  if (typeof obj.model !== 'string' || obj.model.length === 0) missing.push('model');
  if (!Array.isArray(obj.choices)) missing.push('choices');
  if (!isUsageObject(obj.usage)) missing.push('usage');
  return { ok: missing.length === 0, missing };
}

function isUsageObject(value: unknown): boolean {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const obj = value as Record<string, unknown>;
  return (
    typeof obj.prompt_tokens === 'number' &&
    typeof obj.completion_tokens === 'number' &&
    typeof obj.total_tokens === 'number'
  );
}

function getHeader(response: GatewayConformanceFetchResponse, name: string): string | null {
  return response.headers.get(name) ?? response.headers.get(name.toLowerCase());
}

function isValidTraceparent(value: string): boolean {
  return /^[\da-f]{2}-[\da-f]{32}-[\da-f]{16}-[\da-f]{2}$/.test(value);
}

function normalizeGatewayUrl(value: string): string {
  return value.replace(/\/+$/, '');
}

function check(input: GatewayConformanceCheck): GatewayConformanceCheck {
  return input;
}

function defaultNow(): Date {
  return new Date();
}

function defaultFetch(
  input: string,
  init?: GatewayConformanceFetchInit,
): Promise<GatewayConformanceFetchResponse> {
  const requestInit: RequestInit = {
    method: init?.method ?? 'GET',
    ...(init?.headers !== undefined && { headers: { ...init.headers } }),
    ...(init?.body !== undefined && { body: init.body }),
  };
  return globalThis.fetch(input, requestInit);
}
