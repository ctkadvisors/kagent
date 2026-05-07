/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/**
 * Bedrock backend stub. The archived implementation depends on
 * `@aws-sdk/client-bedrock-runtime` and the SigV4 signer (~6MB of
 * deps). v1 of @kagent/llm-gateway targets the homelab path
 * (Cloudflare AI Gateway / Ollama / mock) — Bedrock is structurally
 * present here so the BackendKind union and provider-factory
 * exhaustiveness check stays honest, but the chat methods throw a
 * clear, attributable error rather than silently 500ing.
 *
 * Re-enabling Bedrock for production cloud deployers is a single
 * commit: add the @aws-sdk/client-bedrock-runtime dep, replace the
 * three throw-bodies below with the SigV4-signed POSTs from the
 * archived `lambda/providers/bedrock-provider.ts`, and unblock in
 * `provider-factory.ts`. Tracked in the v0.2 deferred list.
 *
 * Audit-rev2 L12 — admission posture: a runtime throw is a
 * misconfiguration that surfaces only when the first request lands.
 * The ideal fix is operator-side admission rejecting
 * `ModelEndpoint.spec.backendKind: bedrock` until the adapter is
 * implemented. That admission lives in operator scope (CRD + watch),
 * not gateway scope; see operator's W5 stream. As a defence in depth
 * within the gateway itself:
 *   - the error message below names the missing adapter explicitly
 *     so logs / 500 bodies are unambiguously attributable;
 *   - `model-watch.ts` warns at observation time when a CR with
 *     `backendKind: bedrock` is loaded into the index, so an operator
 *     debugging "why is my Bedrock CR failing?" sees a structured
 *     diagnostic before any traffic arrives;
 *   - `docs/MODEL-ROUTING.md` §6.1 documents the v1 gap.
 *
 * Tracked: GitHub issue "bedrock-backend: implement SigV4 adapter"
 * (filed in the v0.2 milestone).
 */

import { BaseProvider } from './base-provider.js';
import type { ProviderRequest, ProviderResponse, StreamingProviderResponse } from '../types.js';

/**
 * Sentinel error name allowing call-sites (router, conformance probe,
 * tests) to discriminate the not-implemented case from genuine
 * upstream failures without string-matching the message.
 */
export const BEDROCK_NOT_IMPLEMENTED_ERROR_NAME = 'BedrockNotImplementedError';

const NOT_IMPL_MESSAGE =
  'bedrock backend is registered in BackendKind for type-exhaustiveness ' +
  'but the SigV4 adapter is not implemented in v1 of @kagent/llm-gateway. ' +
  'Set ModelEndpoint.spec.backendKind to one of {ollama, localai, openai, ' +
  'anthropic, groq, exo, cloudflare, mock}, or add the @aws-sdk/client-' +
  'bedrock-runtime adapter (see packages/llm-gateway/src/providers/' +
  'bedrock-provider.ts header for the re-enable recipe).';

class BedrockNotImplementedError extends Error {
  override readonly name = BEDROCK_NOT_IMPLEMENTED_ERROR_NAME;
  constructor() {
    super(NOT_IMPL_MESSAGE);
  }
}

export class BedrockProvider extends BaseProvider {
  readonly name = 'bedrock' as const;
  protected readonly supportedModels: ReadonlySet<string> = new Set();

  override supportsModel(_modelId: string): boolean {
    return false;
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async chatCompletion(_request: ProviderRequest): Promise<ProviderResponse> {
    throw new BedrockNotImplementedError();
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async chatCompletionStream(_request: ProviderRequest): Promise<StreamingProviderResponse> {
    throw new BedrockNotImplementedError();
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async healthCheck(): Promise<boolean> {
    return false;
  }
}
