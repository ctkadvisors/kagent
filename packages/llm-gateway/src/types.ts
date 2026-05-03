/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/**
 * Shared types for the @kagent/llm-gateway package.
 *
 * Two distinct families live here:
 *
 *   1. OpenAI-compatible wire types — what the gateway accepts on
 *      `POST /v1/chat/completions` and emits back. Lifted from
 *      `archived/ai-gateway/lambda/shared/types/openai.ts` with the
 *      Lambda-only `provider` extension dropped (we resolve provider
 *      via ModelEndpoint CRs at the routing layer instead of from a
 *      request field).
 *
 *   2. Internal provider contract — `ProviderRequest` /
 *      `ProviderResponse` / `StreamingProviderResponse`. Same shape
 *      as the archived project so the ported provider impls slot in
 *      unchanged, minus the AWS Lambda Context references.
 *
 * Backend kinds (`BackendKind`) are the union of providers the
 * gateway can route to. The string values match
 * `ModelEndpoint.spec.backendKind` enum values in the CRD (Wave 1B
 * agent's scope) so the in-memory model index can match without
 * re-mapping.
 */

/* ---------------------------------------------------------------------
 * OpenAI wire types
 * ------------------------------------------------------------------- */

export interface ChatMessage {
  readonly role: 'system' | 'user' | 'assistant' | 'function' | 'tool';
  readonly content: string | readonly ContentPart[];
  readonly name?: string;
  readonly function_call?: FunctionCall;
  readonly tool_calls?: readonly ToolCall[];
}

export interface ContentPart {
  readonly type: 'text' | 'image_url';
  readonly text?: string;
  readonly image_url?: {
    readonly url: string;
    readonly detail?: 'auto' | 'low' | 'high';
  };
}

export interface FunctionCall {
  readonly name: string;
  readonly arguments: string;
}

export interface ToolCall {
  readonly id: string;
  readonly type: 'function';
  readonly function: FunctionCall;
}

export interface ChatCompletionRequest {
  readonly model: string;
  readonly messages: readonly ChatMessage[];
  readonly temperature?: number;
  readonly top_p?: number;
  readonly n?: number;
  readonly stream?: boolean;
  readonly stop?: string | readonly string[];
  readonly max_tokens?: number;
  readonly presence_penalty?: number;
  readonly frequency_penalty?: number;
  readonly logit_bias?: Readonly<Record<string, number>>;
  readonly user?: string;
}

export interface Usage {
  readonly prompt_tokens: number;
  readonly completion_tokens: number;
  readonly total_tokens: number;
}

export interface ChatCompletionChoice {
  readonly index: number;
  readonly message: ChatMessage;
  readonly finish_reason:
    | 'stop'
    | 'length'
    | 'function_call'
    | 'tool_calls'
    | 'content_filter'
    | null;
}

export interface ChatCompletionResponse {
  readonly id: string;
  readonly object: 'chat.completion';
  readonly created: number;
  readonly model: string;
  readonly choices: readonly ChatCompletionChoice[];
  readonly usage: Usage;
}

export interface ChatCompletionChunkChoice {
  readonly index: number;
  readonly delta: {
    readonly role?: 'system' | 'user' | 'assistant';
    readonly content?: string;
    readonly function_call?: Partial<FunctionCall>;
    readonly tool_calls?: readonly Partial<ToolCall>[];
  };
  readonly finish_reason:
    | 'stop'
    | 'length'
    | 'function_call'
    | 'tool_calls'
    | 'content_filter'
    | null;
}

export interface ChatCompletionChunk {
  readonly id: string;
  readonly object: 'chat.completion.chunk';
  readonly created: number;
  readonly model: string;
  readonly choices: readonly ChatCompletionChunkChoice[];
  readonly usage?: Usage;
}

export interface ModelObject {
  readonly id: string;
  readonly object: 'model';
  readonly created: number;
  readonly owned_by: string;
}

export interface ModelListResponse {
  readonly object: 'list';
  readonly data: readonly ModelObject[];
}

export type OpenAIErrorType =
  | 'invalid_request_error'
  | 'authentication_error'
  | 'permission_error'
  | 'not_found_error'
  | 'rate_limit_error'
  | 'server_error'
  | 'service_unavailable_error';

export interface OpenAIError {
  readonly error: {
    readonly message: string;
    readonly type: OpenAIErrorType;
    readonly param: string | null;
    readonly code: string | null;
  };
}

/** Build a uniform OpenAI-shaped error envelope. */
export function createOpenAIError(
  message: string,
  type: OpenAIErrorType,
  param: string | null = null,
  code: string | null = null,
): OpenAIError {
  return { error: { message, type, param, code } };
}

/* ---------------------------------------------------------------------
 * Backend kind enum + provider contract
 * ------------------------------------------------------------------- */

/**
 * The full union of backend kinds the gateway can route to. Matches
 * `ModelEndpoint.spec.backendKind` in the CRD owned by Wave 1B.
 */
export type BackendKind =
  | 'ollama'
  | 'localai'
  | 'cloudflare'
  | 'openai'
  | 'anthropic'
  | 'bedrock'
  | 'groq'
  | 'exo'
  | 'mock';

export interface ProviderConfig {
  readonly backendKind: BackendKind;
  readonly modelId: string;
  readonly providerModelId: string;
  readonly apiKey?: string;
  readonly region?: string;
  readonly baseUrl?: string;
}

export interface ProviderRequest {
  readonly config: ProviderConfig;
  readonly request: ChatCompletionRequest;
  readonly requestId: string;
}

export interface ProviderResponse {
  readonly response: ChatCompletionResponse;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly latencyMs: number;
  readonly cached?: boolean;
}

export interface StreamingProviderResponse {
  readonly stream: AsyncIterable<ChatCompletionChunk>;
  readonly inputTokens: number;
  readonly getOutputTokens: () => number;
  readonly getLatencyMs: () => number;
}

/** Provider contract — every backend implements this. */
export interface AIProvider {
  readonly name: BackendKind;
  supportsModel(modelId: string): boolean;
  chatCompletion(request: ProviderRequest): Promise<ProviderResponse>;
  chatCompletionStream(request: ProviderRequest): Promise<StreamingProviderResponse>;
  healthCheck(): Promise<boolean>;
}

/* ---------------------------------------------------------------------
 * ModelEndpoint CR (read-only mirror of the CRD owned by Wave 1B)
 * ------------------------------------------------------------------- */

/**
 * Mirror of the CRD shape the gateway READS via the K8s informer.
 * Wave 1B owns the canonical type in `packages/operator/src/crds/`;
 * we keep a local copy here so the gateway is a leaf in the workspace
 * dep graph (no cross-package imports — same pattern agent-pod uses
 * for AgentTaskPhase). Promote to a shared types pkg the moment a
 * third copy of this shape appears.
 */
export interface ModelEndpointSpec {
  readonly model: string;
  readonly backendKind: BackendKind;
  readonly backendUrl: string;
  readonly inFlight: {
    readonly seed: number;
    readonly max: number;
  };
  readonly minSafe?: number;
}

export interface ModelEndpointStatus {
  readonly observedInFlight?: number;
  readonly lastSampledAt?: string;
  readonly recentErrorRate?: number;
}

export interface ModelEndpoint {
  readonly apiVersion: string;
  readonly kind: 'ModelEndpoint';
  readonly metadata: {
    readonly name: string;
    readonly namespace?: string;
    readonly resourceVersion?: string;
    readonly uid?: string;
  };
  readonly spec: ModelEndpointSpec;
  readonly status?: ModelEndpointStatus;
}
