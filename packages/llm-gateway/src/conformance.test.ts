/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

import { describe, expect, it } from 'vitest';

import {
  buildChatProbeHeaders,
  evaluateMtlsSvidFallback,
  type GatewayConformanceFetchFn,
  type GatewayConformanceFetchInit,
  type GatewayConformanceFetchResponse,
  runGatewayConformance,
} from './conformance.js';

class MemoryHeaders {
  private readonly values = new Map<string, string>();

  constructor(input: Readonly<Record<string, string>> = {}) {
    for (const [key, value] of Object.entries(input)) {
      this.values.set(key.toLowerCase(), value);
    }
  }

  get(name: string): string | null {
    return this.values.get(name.toLowerCase()) ?? null;
  }
}

interface CapturedCall {
  readonly url: string;
  readonly init: GatewayConformanceFetchInit | undefined;
}

function response(input: {
  status: number;
  headers?: Readonly<Record<string, string>>;
  body?: unknown;
  jsonThrows?: boolean;
}): GatewayConformanceFetchResponse {
  return {
    status: input.status,
    ok: input.status >= 200 && input.status < 300,
    headers: new MemoryHeaders(input.headers),
    json: () => {
      if (input.jsonThrows === true) return Promise.reject(new Error('not json'));
      return Promise.resolve(input.body);
    },
  };
}

function openAIResponse(model = 'gpt-4o'): unknown {
  return {
    id: 'chatcmpl-conformance',
    object: 'chat.completion',
    created: 1,
    model,
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content: 'ok' },
        finish_reason: 'stop',
      },
    ],
    usage: { prompt_tokens: 4, completion_tokens: 1, total_tokens: 5 },
  };
}

function baseInput(fetchFn: GatewayConformanceFetchFn) {
  return {
    gatewayUrl: 'https://gateway.example/',
    model: 'gpt-4o',
    apiToken: 'sk-test',
    fetch: fetchFn,
    now: () => new Date('2026-05-04T12:00:00.000Z'),
  };
}

function findCheck(report: Awaited<ReturnType<typeof runGatewayConformance>>, id: string) {
  const check = report.checks.find((candidate) => candidate.id === id);
  expect(check).toBeDefined();
  return check;
}

describe('buildChatProbeHeaders', () => {
  it('stamps W3C traceparent plus kagent task, agent, and tenant attribution', () => {
    const headers = buildChatProbeHeaders({
      apiToken: 'sk-test',
      traceparent: '00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01',
      taskUid: 'task-123',
      agentName: 'researcher',
      tenant: 'acme',
    });
    expect(headers.Authorization).toBe('Bearer sk-test');
    expect(headers['Content-Type']).toBe('application/json');
    expect(headers.traceparent).toBe('00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01');
    expect(headers['X-Kagent-Task-UID']).toBe('task-123');
    expect(headers['X-Kagent-Agent']).toBe('researcher');
    expect(headers['X-Kagent-Tenant']).toBe('acme');
  });
});

describe('runGatewayConformance', () => {
  it('sends the chat probe headers and validates a 2xx OpenAI-compatible response', async () => {
    const calls: CapturedCall[] = [];
    const fetchFn: GatewayConformanceFetchFn = (url, init) => {
      calls.push({ url, init });
      return Promise.resolve(
        response({
          status: 200,
          headers: {
            'X-Request-Id': 'gw-req-1',
            'X-Model-Used': 'provider/gpt-4o',
            'X-Cache-Status': 'miss',
          },
          body: openAIResponse(),
        }),
      );
    };

    const report = await runGatewayConformance(baseInput(fetchFn));

    expect(report.target).toBe('https://gateway.example');
    expect(report.generatedAt).toBe('2026-05-04T12:00:00.000Z');
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('https://gateway.example/v1/chat/completions');
    expect(calls[0]?.init?.method).toBe('POST');
    expect(calls[0]?.init?.headers?.traceparent).toBe(
      '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01',
    );
    expect(calls[0]?.init?.headers?.['X-Kagent-Task-UID']).toBe('conformance-task-uid');
    expect(calls[0]?.init?.headers?.['X-Kagent-Agent']).toBe('conformance-agent');
    expect(calls[0]?.init?.headers?.['X-Kagent-Tenant']).toBe('conformance-tenant');
    expect(findCheck(report, 'chat.required_headers')?.status).toBe('pass');
    expect(findCheck(report, 'chat.openai_response')?.status).toBe('pass');
    expect(findCheck(report, 'chat.backpressure_retry_after')?.status).toBe('skip');
    expect(findCheck(report, 'rotation.endpoint')?.status).toBe('skip');
    expect(findCheck(report, 'identity.mtls_svid_fallback')?.status).toBe('pass');
  });

  it('passes the Retry-After check when a backpressure response includes seconds', async () => {
    const fetchFn: GatewayConformanceFetchFn = () =>
      Promise.resolve(response({ status: 429, headers: { 'Retry-After': '7' } }));

    const report = await runGatewayConformance(baseInput(fetchFn));

    expect(findCheck(report, 'chat.openai_response')?.status).toBe('skip');
    expect(findCheck(report, 'chat.backpressure_retry_after')?.status).toBe('pass');
  });

  it('fails the Retry-After check when a 429 omits the header', async () => {
    const fetchFn: GatewayConformanceFetchFn = () => Promise.resolve(response({ status: 429 }));

    const report = await runGatewayConformance(baseInput(fetchFn));

    expect(findCheck(report, 'chat.backpressure_retry_after')?.status).toBe('fail');
  });

  it('probes the key rotation endpoint with admin auth and records rotationId', async () => {
    const calls: CapturedCall[] = [];
    const fetchFn: GatewayConformanceFetchFn = (url, init) => {
      calls.push({ url, init });
      if (url.endsWith('/v1/admin/keys/rotate')) {
        return Promise.resolve(response({ status: 200, body: { rotationId: 'rot-1' } }));
      }
      return Promise.resolve(response({ status: 200, body: openAIResponse() }));
    };

    const report = await runGatewayConformance({
      ...baseInput(fetchFn),
      adminToken: 'admin-token',
    });

    expect(calls).toHaveLength(2);
    expect(calls[1]?.url).toBe('https://gateway.example/v1/admin/keys/rotate');
    expect(calls[1]?.init?.method).toBe('POST');
    expect(calls[1]?.init?.headers?.Authorization).toBe('Bearer admin-token');
    const rotation = findCheck(report, 'rotation.endpoint');
    expect(rotation?.status).toBe('pass');
    expect(rotation?.observed).toEqual({ status: 200, rotationId: 'rot-1' });
  });

  it('classifies a 404 rotation endpoint as unsupported fallback warning', async () => {
    const fetchFn: GatewayConformanceFetchFn = (url) => {
      if (url.endsWith('/v1/admin/keys/rotate')) {
        return Promise.resolve(response({ status: 404 }));
      }
      return Promise.resolve(response({ status: 200, body: openAIResponse() }));
    };

    const report = await runGatewayConformance({
      ...baseInput(fetchFn),
      adminToken: 'admin-token',
    });

    expect(findCheck(report, 'rotation.endpoint')?.status).toBe('warn');
  });

  it('fails when neither SVID-backed mTLS nor bearer fallback is available', async () => {
    const fetchFn: GatewayConformanceFetchFn = () =>
      Promise.resolve(response({ status: 200, body: openAIResponse() }));

    const report = await runGatewayConformance({
      ...baseInput(fetchFn),
      mtls: {
        gatewayMtlsEnabled: true,
        svidAvailable: false,
        bearerFallbackAllowed: false,
      },
    });

    expect(findCheck(report, 'identity.mtls_svid_fallback')?.status).toBe('fail');
  });
});

describe('evaluateMtlsSvidFallback', () => {
  it('passes when mTLS and SVID are both available', () => {
    const check = evaluateMtlsSvidFallback({
      gatewayMtlsEnabled: true,
      svidAvailable: true,
      bearerFallbackAllowed: false,
    });
    expect(check.status).toBe('pass');
    expect(check.observed).toMatchObject({ selectedPath: 'mtls_svid' });
  });

  it('passes through bearer fallback when gateway mTLS is unavailable', () => {
    const check = evaluateMtlsSvidFallback({
      gatewayMtlsEnabled: false,
      svidAvailable: false,
      bearerFallbackAllowed: true,
    });
    expect(check.status).toBe('pass');
    expect(check.observed).toMatchObject({ selectedPath: 'bearer_fallback' });
  });
});
