/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/**
 * Per-request orchestration:
 *
 *   model lookup → cap-check → in-flight acquire → provider dispatch
 *   → usage record → AIMD update → in-flight release
 *
 * Returns a discriminated union of:
 *   - `dispatched`        — provider returned a response; HTTP 200/etc.
 *   - `at_cap`            — current in-flight ≥ AIMD cap; HTTP 429 + Retry-After
 *   - `unknown_model`     — no ModelEndpoint registered; HTTP 400
 *   - `backend_throttled` — upstream returned 429/503 (H13); HTTP 429/503 + Retry-After
 *   - `provider_config_error` — upstream returned a non-retryable provider config error; HTTP 400
 *   - `dispatch_error`    — provider threw a non-throttle error; HTTP 502 (AIMD-decreased)
 *
 * Pure orchestration — does NOT touch HTTP wire format. The server
 * layer translates the discriminated union into a status code and
 * either an OpenAIError envelope or the provider's response. Keeps
 * this layer trivially unit-testable against fake providers without
 * spinning up an HTTP server.
 */

import type { AimdController } from './aimd.js';
import { BackendError } from './backend-error.js';
import { sanitizeUpstreamErrorBody } from './error-scrub.js';
import type { InFlightCounter } from './inflight-counter.js';
import type { ModelIndex } from './model-index.js';
import type { UsageRecorder } from './usage-recorder.js';
import type { ProviderFactoryOptions } from './providers/provider-factory.js';
import { buildProvider } from './providers/provider-factory.js';
import type { FailureBackoffController } from './failure-backoff.js';
import type {
  AIProvider,
  BackendKind,
  ChatCompletionRequest,
  ChatCompletionResponse,
  ProviderRequest,
} from './types.js';

export interface RouterDeps {
  readonly modelIndex: ModelIndex;
  readonly inFlight: InFlightCounter;
  readonly aimd: AimdController;
  readonly usage: UsageRecorder;
  /**
   * How to build the concrete provider for a (backendKind, baseUrl).
   * Defaults to the package's provider-factory; tests override to
   * inject a fake provider keyed by backendKind.
   */
  readonly buildProvider?: (
    kind: ConstructorParameters<typeof Map>[0] extends never ? never : never,
  ) => AIProvider;
  /**
   * Test-injectable fetch — only consumed by the default
   * provider-factory path; ignored when `provider` is set on the
   * RouteContext (test path).
   */
  readonly providerFactoryOpts?: ProviderFactoryOptions;
  /** Optional API key bag — keyed by BackendKind name. */
  readonly backendApiKeys?: Readonly<Record<string, string>>;
  /**
   * Emergency hard switch. When true, the gateway accepts the request
   * and records a zero-token 503, but does not call any upstream
   * provider.
   */
  readonly providerDispatchDisabled?: boolean;
  /**
   * Per-model/backend failure circuit. Repeated provider failures open
   * a local backoff window so a bad model route cannot hammer the
   * upstream gateway.
   */
  readonly failureBackoff?: FailureBackoffController;
}

/** Per-request context — comes off the HTTP request. */
export interface RouteContext {
  readonly requestId: string;
  readonly request: ChatCompletionRequest;
  readonly apiKeyPrefix: string | null;
  readonly taskUid: string | null;
  readonly agentName: string | null;
  /**
   * Optional override — when set, used INSTEAD of the factory.
   * Tests use this to inject a fake AIProvider per request without
   * stubbing out the factory globally.
   */
  readonly providerOverride?: AIProvider;
}

export type RouteResult =
  | {
      readonly kind: 'dispatched';
      readonly statusCode: 200;
      readonly body: ChatCompletionResponse;
      readonly latencyMs: number;
    }
  | {
      readonly kind: 'at_cap';
      readonly statusCode: 429;
      readonly retryAfterSec: number;
      readonly model: string;
      readonly currentCap: number;
      readonly inFlight: number;
    }
  | {
      readonly kind: 'unknown_model';
      readonly statusCode: 400;
      readonly model: string;
    }
  /**
   * H13 — upstream backpressure path. Distinct from `at_cap` (which
   * is gateway-side admission) and from `dispatch_error` (which is
   * unstructured 5xx). When the provider throws a `BackendError` with
   * `status` in {429, 503}, we propagate the upstream's status + the
   * supplied (or default) `Retry-After` so the server layer emits
   * HTTP 429/503 + `Retry-After` and agent-pod's chatWithRetry can
   * honour the upstream's backoff hint instead of immediately
   * retrying and stampeding the upstream (GATEWAY-CONTRACT.md §7).
   */
  | {
      readonly kind: 'backend_throttled';
      readonly statusCode: 429 | 503;
      readonly retryAfterSec: number;
      readonly model: string;
      readonly backend: string;
      readonly message: string;
    }
  | {
      readonly kind: 'provider_dispatch_disabled';
      readonly statusCode: 503;
      readonly retryAfterSec: number;
      readonly model: string;
      readonly message: string;
    }
  | {
      readonly kind: 'provider_failure_backoff';
      readonly statusCode: 503;
      readonly retryAfterSec: number;
      readonly model: string;
      readonly backend: string;
      readonly message: string;
    }
  | {
      readonly kind: 'provider_config_error';
      readonly statusCode: 400;
      readonly model: string;
      readonly backend: string;
      readonly message: string;
    }
  | {
      readonly kind: 'dispatch_error';
      readonly statusCode: 502;
      readonly model: string;
      readonly message: string;
    };

/** Default Retry-After hint — admission reconciler is the primary queue. */
const DEFAULT_RETRY_AFTER_SECONDS = 5;

/**
 * H13 — Retry-After fallback when the upstream sends a 429/503 without
 * the header. We pick a small but non-zero hint so agent-pod still
 * sleeps before retrying instead of stampeding the upstream.
 */
const DEFAULT_BACKEND_RETRY_AFTER_SECONDS = 5;

/**
 * Main entry. Streaming path lives in `routeStream` (deferred to v0.2
 * — agent-pod consumes non-streaming today; SSE plumbing is wired in
 * the server layer when needed).
 */
export async function route(deps: RouterDeps, ctx: RouteContext): Promise<RouteResult> {
  const lookup = deps.modelIndex.lookup(ctx.request.model);
  if (lookup === null) {
    return { kind: 'unknown_model', statusCode: 400, model: ctx.request.model };
  }
  const endpoint = lookup.endpoint.spec;
  const backend = endpoint.backendKind;
  const backendUrl = endpoint.backendUrl;

  // Synchronise AIMD bounds with the latest CR observation.
  deps.aimd.updateBounds(endpoint.model, backendUrl, {
    seed: lookup.seed,
    max: lookup.max,
    minSafe: lookup.minSafe,
  });

  if (deps.providerDispatchDisabled === true) {
    recordZeroTokenFailure(
      deps,
      ctx,
      endpoint.model,
      backend,
      backendUrl,
      503,
      'provider dispatch disabled',
    );
    return {
      kind: 'provider_dispatch_disabled',
      statusCode: 503,
      retryAfterSec: DEFAULT_BACKEND_RETRY_AFTER_SECONDS,
      model: endpoint.model,
      message: 'provider dispatch disabled',
    };
  }

  const failureBackoff = deps.failureBackoff?.beforeRequest(endpoint.model, backendUrl);
  if (failureBackoff !== undefined && !failureBackoff.ok) {
    recordZeroTokenFailure(
      deps,
      ctx,
      endpoint.model,
      backend,
      backendUrl,
      503,
      failureBackoff.message,
    );
    return {
      kind: 'provider_failure_backoff',
      statusCode: 503,
      retryAfterSec: failureBackoff.retryAfterSec,
      model: endpoint.model,
      backend,
      message: failureBackoff.message,
    };
  }

  const cap = deps.aimd.currentCap(endpoint.model, backendUrl);
  const inFlight = deps.inFlight.current(endpoint.model, backendUrl);
  if (inFlight >= cap) {
    return {
      kind: 'at_cap',
      statusCode: 429,
      retryAfterSec: DEFAULT_RETRY_AFTER_SECONDS,
      model: endpoint.model,
      currentCap: cap,
      inFlight,
    };
  }

  const provider =
    ctx.providerOverride ?? buildProvider(backend, backendUrl, deps.providerFactoryOpts ?? {});
  const apiKey = deps.backendApiKeys?.[backend];
  const providerRequest: ProviderRequest = {
    config: {
      backendKind: backend,
      modelId: endpoint.model,
      providerModelId: endpoint.model,
      baseUrl: backendUrl,
      ...(apiKey !== undefined && { apiKey }),
    },
    request: ctx.request,
    requestId: ctx.requestId,
  };

  deps.inFlight.acquire(endpoint.model, backendUrl);
  const startedAt = Date.now();
  try {
    const result = await provider.chatCompletion(providerRequest);
    deps.failureBackoff?.recordSuccess(endpoint.model, backendUrl);
    deps.aimd.onSuccess(endpoint.model, backendUrl, result.latencyMs);
    void deps.usage
      .record({
        apiKeyPrefix: ctx.apiKeyPrefix,
        requestId: ctx.requestId,
        model: endpoint.model,
        backend,
        backendUrl,
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
        latencyMs: result.latencyMs,
        statusCode: 200,
        streaming: false,
        taskUid: ctx.taskUid,
        agentName: ctx.agentName,
      })
      .catch((err: unknown) => {
        // Fire-and-forget — don't fail the user-visible response on
        // a usage-row insert failure. Best surface is an operator log.

        console.error('[llm-gateway] usage record failed:', err);
      });
    return {
      kind: 'dispatched',
      statusCode: 200,
      body: result.response,
      latencyMs: result.latencyMs,
    };
  } catch (err: unknown) {
    if (err instanceof BackendError && isNonRetryableProviderConfigError(err)) {
      deps.aimd.onError(endpoint.model, backendUrl);
      deps.failureBackoff?.recordFailure(endpoint.model, backendUrl);
      const sanitisedMessage = sanitizeUpstreamErrorBody(err.message);
      void deps.usage
        .record({
          apiKeyPrefix: ctx.apiKeyPrefix,
          requestId: ctx.requestId,
          model: endpoint.model,
          backend,
          backendUrl,
          inputTokens: 0,
          outputTokens: 0,
          latencyMs: Date.now() - startedAt,
          statusCode: 400,
          streaming: false,
          taskUid: ctx.taskUid,
          agentName: ctx.agentName,
          errorMessage: sanitisedMessage,
        })
        .catch(() => {
          /* swallow — primary error already in flight */
        });
      return {
        kind: 'provider_config_error',
        statusCode: 400,
        model: endpoint.model,
        backend,
        message: sanitisedMessage,
      };
    }

    // H13 — typed BackendError with status 429/503 routes to the
    // backend_throttled discriminator. AIMD still gets `onError` so
    // the local cap halves; we want the upstream's pressure to be
    // visible in our admission control, not just propagated.
    if (err instanceof BackendError && (err.status === 429 || err.status === 503)) {
      deps.aimd.onError(endpoint.model, backendUrl);
      deps.failureBackoff?.recordFailure(endpoint.model, backendUrl);
      const sanitisedMessage = sanitizeUpstreamErrorBody(err.message);
      const retryAfterSec = err.retryAfter ?? DEFAULT_BACKEND_RETRY_AFTER_SECONDS;
      const upstreamStatus = err.status;
      void deps.usage
        .record({
          apiKeyPrefix: ctx.apiKeyPrefix,
          requestId: ctx.requestId,
          model: endpoint.model,
          backend,
          backendUrl,
          inputTokens: 0,
          outputTokens: 0,
          latencyMs: Date.now() - startedAt,
          statusCode: upstreamStatus,
          streaming: false,
          taskUid: ctx.taskUid,
          agentName: ctx.agentName,
          errorMessage: sanitisedMessage,
        })
        .catch(() => {
          /* swallow — primary error already in flight */
        });
      return {
        kind: 'backend_throttled',
        statusCode: upstreamStatus,
        retryAfterSec,
        model: endpoint.model,
        backend,
        message: sanitisedMessage,
      };
    }

    deps.aimd.onError(endpoint.model, backendUrl);
    deps.failureBackoff?.recordFailure(endpoint.model, backendUrl);
    // H15 — even on the dispatch_error path, run the message through
    // the same scrub + truncate pipeline. Provider exceptions can
    // include upstream bodies (e.g. a BackendError with status outside
    // 429/503, or a generic Error wrapping a third-party SDK's
    // diagnostic that may itself carry a key fragment).
    const rawMessage = err instanceof Error ? err.message : String(err);
    const sanitisedMessage = sanitizeUpstreamErrorBody(rawMessage);
    void deps.usage
      .record({
        apiKeyPrefix: ctx.apiKeyPrefix,
        requestId: ctx.requestId,
        model: endpoint.model,
        backend,
        backendUrl,
        inputTokens: 0,
        outputTokens: 0,
        latencyMs: Date.now() - startedAt,
        statusCode: 502,
        streaming: false,
        taskUid: ctx.taskUid,
        agentName: ctx.agentName,
        errorMessage: sanitisedMessage,
      })
      .catch(() => {
        /* swallow — primary error already in flight */
      });
    return {
      kind: 'dispatch_error',
      statusCode: 502,
      model: endpoint.model,
      message: sanitisedMessage,
    };
  } finally {
    deps.inFlight.release(endpoint.model, backendUrl);
  }
}

function recordZeroTokenFailure(
  deps: RouterDeps,
  ctx: RouteContext,
  model: string,
  backend: BackendKind,
  backendUrl: string,
  statusCode: number,
  errorMessage: string,
): void {
  void deps.usage
    .record({
      apiKeyPrefix: ctx.apiKeyPrefix,
      requestId: ctx.requestId,
      model,
      backend,
      backendUrl,
      inputTokens: 0,
      outputTokens: 0,
      latencyMs: 0,
      statusCode,
      streaming: false,
      taskUid: ctx.taskUid,
      agentName: ctx.agentName,
      errorMessage,
    })
    .catch(() => {
      /* swallow — request is already blocked */
    });
}

function isNonRetryableProviderConfigError(err: BackendError): boolean {
  if (err.status !== 400 && err.status !== 404) return false;
  const message = err.message.toLowerCase();
  return (
    message.includes('no such model') ||
    message.includes('invalid model') ||
    message.includes('model not found') ||
    message.includes('unknown model')
  );
}
