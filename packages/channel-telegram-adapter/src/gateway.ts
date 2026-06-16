/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

import type { ChannelGateway, ChannelInboundEnvelope } from './types.js';

export interface ChannelGatewayClientOptions {
  readonly baseUrl: string;
  readonly token: string;
  readonly timeoutMs?: number;
  readonly fetchImpl?: typeof fetch;
}

export class ChannelGatewayHttpError extends Error {
  constructor(
    readonly status: number,
    readonly body: unknown,
  ) {
    super(`channel gateway returned HTTP ${status}`);
  }
}

export class ChannelGatewayClient implements ChannelGateway {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: ChannelGatewayClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/u, '');
    this.token = options.token;
    this.timeoutMs = options.timeoutMs ?? 10000;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async postInbound(envelope: ChannelInboundEnvelope): Promise<unknown> {
    const url = `${this.baseUrl}/channels/${encodeURIComponent(envelope.channelName)}/inbound`;
    const response = await this.fetchImpl(url, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(envelope),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    const body = await readResponseBody(response);
    if (!response.ok) throw new ChannelGatewayHttpError(response.status, body);
    return body;
  }
}

async function readResponseBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (text.trim().length === 0) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}
