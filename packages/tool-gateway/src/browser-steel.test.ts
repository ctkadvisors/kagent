/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

import { describe, expect, it, vi } from 'vitest';

import { SteelBrowserAdapter, type BrowserAutomationDriver } from './browser-steel.js';

interface CapturedRequest {
  readonly url: string;
  readonly init: RequestInit | undefined;
}

function makeJsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function makeFetch(responses: readonly Response[]): {
  readonly calls: CapturedRequest[];
  readonly fetch: typeof fetch;
} {
  const calls: CapturedRequest[] = [];
  const queue = [...responses];
  const fakeFetch = vi.fn(
    (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      calls.push({ url: requestUrl(input), init });
      const response = queue.shift();
      if (response === undefined) throw new Error('unexpected fetch call');
      return Promise.resolve(response);
    },
  ) as unknown as typeof fetch;

  return { calls, fetch: fakeFetch };
}

function requestUrl(input: Parameters<typeof fetch>[0]): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

function makeDriver(): BrowserAutomationDriver {
  return {
    goto: vi.fn(() => Promise.resolve({ url: 'https://example.com/report', title: 'Report' })),
    click: vi.fn(() => Promise.resolve({ ok: true })),
    screenshot: vi.fn(() =>
      Promise.resolve({
        mimeType: 'image/png',
        base64: Buffer.from('png').toString('base64'),
      }),
    ),
    select: vi.fn(() => Promise.resolve({ ok: true })),
    extractText: vi.fn(() => Promise.resolve({ text: 'Visible report text' })),
    typeText: vi.fn(() => Promise.resolve({ ok: true })),
    waitFor: vi.fn(() => Promise.resolve({ ok: true, matched: 'text' })),
    closeSession: vi.fn(() => Promise.resolve()),
  };
}

describe('SteelBrowserAdapter', () => {
  it('creates isolated Steel sessions with local API options and exposes live/CDP URLs', async () => {
    const { calls, fetch } = makeFetch([
      makeJsonResponse({
        id: 'steel-1',
        sessionViewerUrl: 'http://steel.local:3000/ui/sessions/steel-1',
        websocketUrl: 'ws://steel.local:3000/devtools/browser/steel-1',
      }),
    ]);
    const adapter = new SteelBrowserAdapter({
      apiKey: 'steel-key',
      baseUrl: 'http://steel.local:3000',
      connectBaseUrl: 'wss://connect.steel.local',
      fetch,
    });

    const session = await adapter.startSession({
      timeoutMs: 600_000,
      inactivityTimeoutMs: 60_000,
      viewport: { width: 1280, height: 800 },
    });

    expect(session).toEqual({
      id: 'steel-1',
      cdpUrl: 'ws://steel.local:3000/devtools/browser/steel-1',
      liveViewUrl: 'http://steel.local:3000/ui/sessions/steel-1',
      recordingUrl: 'http://steel.local:3000/v1/sessions/steel-1/hls',
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('http://steel.local:3000/v1/sessions');
    expect(calls[0]?.init?.method).toBe('POST');
    expect(calls[0]?.init?.headers).toMatchObject({
      'content-type': 'application/json',
      'steel-api-key': 'steel-key',
    });
    const body = calls[0]?.init?.body;
    expect(typeof body).toBe('string');
    expect(JSON.parse(body as string)).toEqual({
      timeout: 600_000,
      inactivityTimeout: 60_000,
      dimensions: { width: 1280, height: 800 },
    });
  });

  it('falls back to a connector URL when Steel does not return a websocket URL', async () => {
    const { fetch } = makeFetch([makeJsonResponse({ id: 'steel-2' })]);
    const adapter = new SteelBrowserAdapter({
      apiKey: 'steel-key',
      baseUrl: 'http://steel.local:3000',
      connectBaseUrl: 'wss://connect.steel.local',
      fetch,
    });

    await expect(adapter.startSession()).resolves.toMatchObject({
      id: 'steel-2',
      cdpUrl: 'wss://connect.steel.local?apiKey=steel-key&sessionId=steel-2',
      liveViewUrl: 'http://steel.local:3000/ui/sessions/steel-2',
    });
  });

  it('invalidates cached CDP connections when Steel starts a new session', async () => {
    const driver = makeDriver();
    const { fetch } = makeFetch([
      makeJsonResponse({
        id: 'steel-1',
        websocketUrl: 'ws://steel.local:3000/',
      }),
      makeJsonResponse({
        id: 'steel-2',
        websocketUrl: 'ws://steel.local:3000/',
      }),
    ]);
    const adapter = new SteelBrowserAdapter({
      baseUrl: 'http://steel.local:3000',
      driver,
      fetch,
    });

    await adapter.startSession();
    await adapter.startSession();

    expect(driver.closeSession).toHaveBeenCalledTimes(2);
    expect(driver.closeSession).toHaveBeenNthCalledWith(1, 'ws://steel.local:3000/');
    expect(driver.closeSession).toHaveBeenNthCalledWith(2, 'ws://steel.local:3000/');
  });

  it('drives navigation, screenshots, and text extraction through the injected browser driver', async () => {
    const driver = makeDriver();
    const adapter = new SteelBrowserAdapter({
      baseUrl: 'http://steel.local:3000',
      driver,
      fetch: makeFetch([]).fetch,
    });
    const session = {
      id: 'steel-1',
      cdpUrl: 'ws://steel.local:3000/devtools/browser/steel-1',
      liveViewUrl: 'http://steel.local:3000/ui/sessions/steel-1',
      recordingUrl: 'http://steel.local:3000/v1/sessions/steel-1/hls',
    };

    await expect(adapter.goto(session, 'https://example.com/report')).resolves.toEqual({
      url: 'https://example.com/report',
      title: 'Report',
    });
    await expect(adapter.screenshot(session, { fullPage: true })).resolves.toEqual({
      mimeType: 'image/png',
      base64: Buffer.from('png').toString('base64'),
    });
    await expect(adapter.extractText(session)).resolves.toEqual({ text: 'Visible report text' });
    expect(driver.goto).toHaveBeenCalledWith(session.cdpUrl, 'https://example.com/report', {
      timeoutMs: undefined,
    });
    expect(driver.screenshot).toHaveBeenCalledWith(session.cdpUrl, { fullPage: true });
    expect(driver.extractText).toHaveBeenCalledWith(session.cdpUrl, { maxChars: undefined });
  });

  it('drives click, type, select, and wait actions through the injected browser driver', async () => {
    const driver = makeDriver();
    const adapter = new SteelBrowserAdapter({
      baseUrl: 'http://steel.local:3000',
      driver,
      fetch: makeFetch([]).fetch,
    });
    const session = {
      id: 'steel-1',
      cdpUrl: 'ws://steel.local:3000/devtools/browser/steel-1',
      liveViewUrl: 'http://steel.local:3000/ui/sessions/steel-1',
      recordingUrl: 'http://steel.local:3000/v1/sessions/steel-1/hls',
    };

    await expect(
      adapter.click(session, { selector: 'button[name=search]', timeoutMs: 5000 }),
    ).resolves.toEqual({ ok: true });
    await expect(
      adapter.typeText(session, { selector: 'input[name=q]', text: 'agent sandbox' }),
    ).resolves.toEqual({ ok: true });
    await expect(
      adapter.select(session, { selector: 'select[name=mode]', value: 'deep' }),
    ).resolves.toEqual({ ok: true });
    await expect(adapter.waitFor(session, { text: 'Results', timeoutMs: 1000 })).resolves.toEqual({
      ok: true,
      matched: 'text',
    });

    expect(driver.click).toHaveBeenCalledWith(session.cdpUrl, {
      selector: 'button[name=search]',
      timeoutMs: 5000,
    });
    expect(driver.typeText).toHaveBeenCalledWith(session.cdpUrl, {
      selector: 'input[name=q]',
      text: 'agent sandbox',
      timeoutMs: undefined,
    });
    expect(driver.select).toHaveBeenCalledWith(session.cdpUrl, {
      selector: 'select[name=mode]',
      value: 'deep',
      timeoutMs: undefined,
    });
    expect(driver.waitFor).toHaveBeenCalledWith(session.cdpUrl, {
      text: 'Results',
      timeoutMs: 1000,
    });
  });

  it('releases one session explicitly and can release all live sessions for kill-switch cleanup', async () => {
    const { calls, fetch } = makeFetch([
      makeJsonResponse({ released: true }),
      makeJsonResponse({ message: 'All sessions released successfully' }),
    ]);
    const adapter = new SteelBrowserAdapter({
      baseUrl: 'http://steel.local:3000/',
      fetch,
    });

    await expect(adapter.releaseSession('steel-1')).resolves.toEqual({ released: true });
    await expect(adapter.releaseAllSessions()).resolves.toEqual({
      message: 'All sessions released successfully',
    });

    expect(calls.map((call) => [call.init?.method, call.url])).toEqual([
      ['POST', 'http://steel.local:3000/v1/sessions/steel-1/release'],
      ['POST', 'http://steel.local:3000/v1/sessions/release'],
    ]);
  });

  it('returns actionable errors when Steel rejects a request', async () => {
    const { fetch } = makeFetch([makeJsonResponse({ error: 'bad session options' }, 400)]);
    const adapter = new SteelBrowserAdapter({
      baseUrl: 'http://steel.local:3000',
      fetch,
    });

    await expect(adapter.startSession()).rejects.toThrow(
      'steel_request_failed: POST /v1/sessions returned 400: bad session options',
    );
  });
});
