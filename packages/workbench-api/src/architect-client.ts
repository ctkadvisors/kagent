/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/**
 * Architect chat client — talks to the kagent LLM gateway's
 * OpenAI-compatible `/v1/chat/completions` surface (NOT the `/admin/*`
 * surface that `gateway-client.ts` uses). The workbench-api presents the
 * gateway bearer token; the gateway governs + Langfuse-traces the call,
 * so the chat-to-create conversation is itself observable in Langfuse
 * (dogfooding). Errors are scrubbed: a 5xx must not leak the gateway's
 * pod identity back to the workbench client.
 */
import type { ChatMessage } from './architect-prompt.js';

export interface ArchitectClientConfig {
  /** OpenAI-compatible base, e.g. http://kagent-llm-gateway.kagent-system.svc.cluster.local:4000/v1 */
  readonly baseUrl: string;
  readonly token: string;
  readonly model: string;
  readonly timeoutMs?: number;
}

export class ArchitectClient {
  constructor(
    private readonly cfg: ArchitectClientConfig,
    private readonly fetchFn: typeof fetch = fetch,
  ) {}

  async complete(messages: readonly ChatMessage[]): Promise<string> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.cfg.timeoutMs ?? 60_000);
    try {
      const res = await this.fetchFn(`${this.cfg.baseUrl}/chat/completions`, {
        method: 'POST',
        signal: ctrl.signal,
        headers: {
          'content-type': 'application/json',
          Authorization: `Bearer ${this.cfg.token}`,
        },
        body: JSON.stringify({ model: this.cfg.model, temperature: 0, messages }),
      });
      if (!res.ok) {
        // Intentionally do NOT echo the upstream body — it can name gateway pods.
        throw new Error(`architect upstream error (status ${res.status})`);
      }
      const json = (await res.json()) as {
        choices?: ReadonlyArray<{ message?: { content?: string } }>;
      };
      const content = json.choices?.[0]?.message?.content;
      if (typeof content !== 'string') {
        throw new Error('architect upstream returned no message content');
      }
      return content;
    } finally {
      clearTimeout(timer);
    }
  }
}
