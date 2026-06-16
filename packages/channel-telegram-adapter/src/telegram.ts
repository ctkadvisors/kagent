/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

import type {
  TelegramClient,
  TelegramGetUpdatesResponse,
  TelegramSendMessageResponse,
  TelegramUpdate,
} from './types.js';

const ALLOWED_UPDATES = [
  'message',
  'edited_message',
  'channel_post',
  'edited_channel_post',
] as const;

export interface TelegramHttpClientOptions {
  readonly apiBaseUrl: string;
  readonly botToken: string;
  readonly fetchImpl?: typeof fetch;
}

export class TelegramApiError extends Error {
  constructor(
    readonly method: string,
    readonly status: number | undefined,
    readonly body: unknown,
  ) {
    super(`Telegram ${method} failed${status === undefined ? '' : ` with HTTP ${status}`}`);
  }
}

export class TelegramHttpClient implements TelegramClient {
  private readonly apiBaseUrl: string;
  private readonly botToken: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: TelegramHttpClientOptions) {
    this.apiBaseUrl = options.apiBaseUrl.replace(/\/+$/u, '');
    this.botToken = options.botToken;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async getUpdates(input: {
    readonly offset?: number;
    readonly timeoutSeconds: number;
  }): Promise<readonly TelegramUpdate[]> {
    const body = {
      timeout: input.timeoutSeconds,
      ...(input.offset !== undefined && { offset: input.offset }),
      allowed_updates: [...ALLOWED_UPDATES],
    };
    const response = await this.post<TelegramGetUpdatesResponse>('getUpdates', body);
    return response.result ?? [];
  }

  async sendMessage(input: { readonly chatId: string; readonly text: string }): Promise<void> {
    await this.post<TelegramSendMessageResponse>('sendMessage', {
      chat_id: input.chatId,
      text: input.text,
    });
  }

  private async post<TResponse extends { readonly ok: boolean; readonly description?: string }>(
    method: string,
    body: unknown,
  ): Promise<TResponse> {
    const response = await this.fetchImpl(this.methodUrl(method), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const responseBody = await readResponseBody(response);
    if (!response.ok) throw new TelegramApiError(method, response.status, responseBody);
    if (!isTelegramResponse(responseBody)) {
      throw new TelegramApiError(method, response.status, responseBody);
    }
    if (!responseBody.ok) throw new TelegramApiError(method, response.status, responseBody);
    return responseBody as TResponse;
  }

  private methodUrl(method: string): string {
    return `${this.apiBaseUrl}/bot${this.botToken}/${method}`;
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

function isTelegramResponse(value: unknown): value is { readonly ok: boolean } {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { readonly ok?: unknown }).ok === 'boolean'
  );
}
