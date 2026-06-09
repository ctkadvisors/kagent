/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

export interface BrowserViewport {
  readonly width: number;
  readonly height: number;
}

export interface StartSteelBrowserSessionInput {
  readonly timeoutMs?: number;
  readonly inactivityTimeoutMs?: number;
  readonly viewport?: BrowserViewport;
  readonly userAgent?: string;
  readonly useProxy?: boolean;
  readonly solveCaptcha?: boolean;
}

export interface SteelBrowserSession {
  readonly id: string;
  readonly cdpUrl: string;
  readonly liveViewUrl: string;
  readonly recordingUrl: string;
}

export interface BrowserGotoResult {
  readonly url: string;
  readonly title?: string;
}

export interface BrowserInteractionResult {
  readonly ok: true;
  readonly matched?: 'selector' | 'text';
}

export interface BrowserScreenshotResult {
  readonly mimeType: string;
  readonly base64: string;
}

export interface BrowserExtractTextResult {
  readonly text: string;
}

export interface BrowserGotoOptions {
  readonly timeoutMs: number | undefined;
}

export interface BrowserClickOptions {
  readonly selector?: string | undefined;
  readonly text?: string | undefined;
  readonly timeoutMs: number | undefined;
}

export interface BrowserTypeTextOptions {
  readonly selector: string;
  readonly text: string;
  readonly timeoutMs: number | undefined;
}

export interface BrowserSelectOptions {
  readonly selector: string;
  readonly value: string;
  readonly timeoutMs: number | undefined;
}

export interface BrowserWaitForOptions {
  readonly selector?: string | undefined;
  readonly text?: string | undefined;
  readonly timeoutMs: number | undefined;
}

export interface BrowserScreenshotOptions {
  readonly fullPage?: boolean;
}

export interface BrowserExtractTextOptions {
  readonly maxChars: number | undefined;
}

export interface BrowserAutomationDriver {
  readonly goto: (
    cdpUrl: string,
    url: string,
    options: BrowserGotoOptions,
  ) => Promise<BrowserGotoResult>;
  readonly click: (
    cdpUrl: string,
    options: BrowserClickOptions,
  ) => Promise<BrowserInteractionResult>;
  readonly screenshot: (
    cdpUrl: string,
    options: BrowserScreenshotOptions,
  ) => Promise<BrowserScreenshotResult>;
  readonly select: (
    cdpUrl: string,
    options: BrowserSelectOptions,
  ) => Promise<BrowserInteractionResult>;
  readonly extractText: (
    cdpUrl: string,
    options: BrowserExtractTextOptions,
  ) => Promise<BrowserExtractTextResult>;
  readonly typeText: (
    cdpUrl: string,
    options: BrowserTypeTextOptions,
  ) => Promise<BrowserInteractionResult>;
  readonly waitFor: (
    cdpUrl: string,
    options: BrowserWaitForOptions,
  ) => Promise<BrowserInteractionResult>;
  readonly closeSession?: (cdpUrl: string) => Promise<void>;
}

export interface SteelBrowserAdapterOptions {
  readonly baseUrl: string;
  readonly apiKey?: string;
  readonly connectBaseUrl?: string;
  readonly fetch?: typeof fetch;
  readonly driver?: BrowserAutomationDriver;
}

interface SteelSessionResponse {
  readonly id?: unknown;
  readonly websocketUrl?: unknown;
  readonly cdpUrl?: unknown;
  readonly wsUrl?: unknown;
  readonly debugUrl?: unknown;
  readonly sessionViewerUrl?: unknown;
  readonly liveViewUrl?: unknown;
  readonly recordingUrl?: unknown;
}

type JsonObject = Record<string, unknown>;

export class SteelBrowserAdapter {
  private readonly apiKey: string | undefined;
  private readonly baseUrl: string;
  private readonly connectBaseUrl: string | undefined;
  private readonly fetch: typeof fetch;
  private readonly driver: BrowserAutomationDriver | undefined;

  constructor(options: SteelBrowserAdapterOptions) {
    this.apiKey = options.apiKey;
    this.baseUrl = trimTrailingSlash(options.baseUrl);
    this.connectBaseUrl =
      options.connectBaseUrl === undefined ? undefined : trimTrailingSlash(options.connectBaseUrl);
    this.fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.driver = options.driver;
  }

  async startSession(input: StartSteelBrowserSessionInput = {}): Promise<SteelBrowserSession> {
    const body = this.buildStartSessionBody(input);
    const response = await this.requestJson<SteelSessionResponse>('POST', '/v1/sessions', body);
    const session = this.normalizeSession(response);
    await this.resetDriverSession(session.cdpUrl);
    return session;
  }

  async goto(
    session: SteelBrowserSession,
    url: string,
    input: BrowserGotoOptions = { timeoutMs: undefined },
  ): Promise<BrowserGotoResult> {
    return this.requireDriver().goto(session.cdpUrl, url, { timeoutMs: input.timeoutMs });
  }

  async click(
    session: SteelBrowserSession,
    input: BrowserClickOptions,
  ): Promise<BrowserInteractionResult> {
    return this.requireDriver().click(session.cdpUrl, {
      selector: input.selector,
      text: input.text,
      timeoutMs: input.timeoutMs,
    });
  }

  async screenshot(
    session: SteelBrowserSession,
    input: BrowserScreenshotOptions = {},
  ): Promise<BrowserScreenshotResult> {
    return this.requireDriver().screenshot(session.cdpUrl, input);
  }

  async select(
    session: SteelBrowserSession,
    input: BrowserSelectOptions,
  ): Promise<BrowserInteractionResult> {
    return this.requireDriver().select(session.cdpUrl, {
      selector: input.selector,
      value: input.value,
      timeoutMs: input.timeoutMs,
    });
  }

  async extractText(
    session: SteelBrowserSession,
    input: BrowserExtractTextOptions = { maxChars: undefined },
  ): Promise<BrowserExtractTextResult> {
    return this.requireDriver().extractText(session.cdpUrl, { maxChars: input.maxChars });
  }

  async typeText(
    session: SteelBrowserSession,
    input: BrowserTypeTextOptions,
  ): Promise<BrowserInteractionResult> {
    return this.requireDriver().typeText(session.cdpUrl, {
      selector: input.selector,
      text: input.text,
      timeoutMs: input.timeoutMs,
    });
  }

  async waitFor(
    session: SteelBrowserSession,
    input: BrowserWaitForOptions,
  ): Promise<BrowserInteractionResult> {
    return this.requireDriver().waitFor(session.cdpUrl, {
      selector: input.selector,
      text: input.text,
      timeoutMs: input.timeoutMs,
    });
  }

  async releaseSession(id: string): Promise<JsonObject> {
    return this.requestJson<JsonObject>('POST', `/v1/sessions/${encodeURIComponent(id)}/release`);
  }

  async releaseAllSessions(): Promise<JsonObject> {
    return this.requestJson<JsonObject>('POST', '/v1/sessions/release');
  }

  private buildStartSessionBody(input: StartSteelBrowserSessionInput): JsonObject {
    const body: JsonObject = {};

    if (input.timeoutMs !== undefined) body.timeout = input.timeoutMs;
    if (input.inactivityTimeoutMs !== undefined) body.inactivityTimeout = input.inactivityTimeoutMs;
    if (input.viewport !== undefined) {
      body.dimensions = {
        width: input.viewport.width,
        height: input.viewport.height,
      };
    }
    if (input.userAgent !== undefined) body.userAgent = input.userAgent;
    if (input.useProxy !== undefined) body.useProxy = input.useProxy;
    if (input.solveCaptcha !== undefined) body.solveCaptcha = input.solveCaptcha;

    return body;
  }

  private normalizeSession(response: SteelSessionResponse): SteelBrowserSession {
    const id = requireString(response.id, 'id');

    return {
      id,
      cdpUrl:
        this.pickOptionalString(response.websocketUrl, response.cdpUrl, response.wsUrl) ??
        this.buildCdpUrl(id),
      liveViewUrl:
        this.pickOptionalString(response.sessionViewerUrl, response.liveViewUrl) ??
        `${this.baseUrl}/ui/sessions/${encodeURIComponent(id)}`,
      recordingUrl:
        this.pickOptionalString(response.recordingUrl) ??
        `${this.baseUrl}/v1/sessions/${encodeURIComponent(id)}/hls`,
    };
  }

  private buildCdpUrl(sessionId: string): string {
    const base = this.connectBaseUrl ?? 'wss://connect.steel.dev';
    const params = new URLSearchParams();
    if (this.apiKey !== undefined) params.set('apiKey', this.apiKey);
    params.set('sessionId', sessionId);

    return `${base}${base.includes('?') ? '&' : '?'}${params.toString()}`;
  }

  private async requestJson<T>(
    method: 'GET' | 'POST',
    path: string,
    body?: JsonObject,
  ): Promise<T> {
    const headers: Record<string, string> = {};
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (this.apiKey !== undefined) headers['steel-api-key'] = this.apiKey;

    const init: RequestInit = {
      method,
      headers,
    };
    if (body !== undefined) init.body = JSON.stringify(body);

    const response = await this.fetch(`${this.baseUrl}${path}`, init);

    if (!response.ok) {
      throw new Error(
        `steel_request_failed: ${method} ${path} returned ${response.status}: ${await responseMessage(response)}`,
      );
    }

    return (await response.json()) as T;
  }

  private requireDriver(): BrowserAutomationDriver {
    if (this.driver === undefined) {
      throw new Error(
        'browser_driver_unconfigured: provide a Playwright/CDP driver before invoking browser actions',
      );
    }

    return this.driver;
  }

  private async resetDriverSession(cdpUrl: string): Promise<void> {
    if (this.driver?.closeSession === undefined) return;
    try {
      await this.driver.closeSession(cdpUrl);
    } catch (err) {
      if (!isClosedTargetError(err)) throw err;
    }
  }

  private pickOptionalString(...values: readonly unknown[]): string | undefined {
    for (const value of values) {
      if (typeof value === 'string' && value.length > 0) {
        return value;
      }
    }

    return undefined;
  }
}

function isClosedTargetError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return (
    message.includes('Target page, context or browser has been closed') ||
    message.includes('Target closed') ||
    message.includes('Browser has been closed')
  );
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`steel_response_invalid: missing ${field}`);
  }

  return value;
}

async function responseMessage(response: Response): Promise<string> {
  const text = await response.text();
  if (text.length === 0) return response.statusText;

  try {
    const parsed = JSON.parse(text) as { readonly error?: unknown; readonly message?: unknown };
    if (typeof parsed.error === 'string') return parsed.error;
    if (typeof parsed.message === 'string') return parsed.message;
  } catch {
    return text;
  }

  return text;
}

function trimTrailingSlash(value: string): string {
  return value.endsWith('/') ? value.slice(0, -1) : value;
}
