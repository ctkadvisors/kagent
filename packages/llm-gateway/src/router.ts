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
 *   - `dispatched`  — provider returned a response; HTTP 200/etc.
 *   - `at_cap`      — current in-flight ≥ AIMD cap; HTTP 429
 *   - `unknown_model` — no ModelEndpoint registered; HTTP 400
 *   - `dispatch_error` — provider threw; HTTP 502 (already AIMD-decreased)
 *
 * Pure orchestration — does NOT touch HTTP wire format. The server
 * layer translates the discriminated union into a status code and
 * either an OpenAIError envelope or the provider's response. Keeps
 * this layer trivially unit-testable against fake providers without
 * spinning up an HTTP server.
 */

import type { AimdController } from './aimd.js';
import type { InFlightCounter } from './inflight-counter.js';
import type { ModelIndex } from './model-index.js';
import type { UsageRecorder } from './usage-recorder.js';
import type { ProviderFactoryOptions } from './providers/provider-factory.js';
import { buildProvider } from './providers/provider-factory.js';
import type {
  AIProvider,
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
  | {
      readonly kind: 'dispatch_error';
      readonly statusCode: 502;
      readonly model: string;
      readonly message: string;
    };

/** Default Retry-After hint — admission reconciler is the primary queue. */
const DEFAULT_RETRY_AFTER_SECONDS = 5;

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
    deps.aimd.onError(endpoint.model, backendUrl);
    const message = err instanceof Error ? err.message : String(err);
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
        errorMessage: message,
      })
      .catch(() => {
        /* swallow — primary error already in flight */
      });
    return {
      kind: 'dispatch_error',
      statusCode: 502,
      model: endpoint.model,
      message,
    };
  } finally {
    deps.inFlight.release(endpoint.model, backendUrl);
  }
}
