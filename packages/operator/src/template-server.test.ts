/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

import type { IncomingMessage, ServerResponse } from 'node:http';

import { describe, expect, it } from 'vitest';
import type { CustomObjectsApi } from '@kubernetes/client-node';

import type { AgentTemplate } from './crds/types.js';
import { API_GROUP_VERSION } from './crds/types.js';
import {
  buildInstantiateHandler,
  type InstantiatePostBody,
  type InstantiatePostError,
  type InstantiatePostResponse,
} from './template-server.js';

const FIXED_DATE = new Date('2026-05-01T15:00:00Z');

function makeTemplate(): AgentTemplate {
  return {
    apiVersion: API_GROUP_VERSION,
    kind: 'AgentTemplate',
    metadata: { name: 'summarizer', namespace: 'kagent-system' },
    spec: {
      templateVersion: 1,
      parameters: [{ name: 'topic', type: 'string', pattern: '^[a-zA-Z ]{1,80}$', required: true }],
      toolAllowlist: ['fetch_url'],
      toolDefaults: ['fetch_url'],
      agentSpec: {
        model: 'workers-ai/m',
        systemPrompt: 'sum ${param.topic}',
      },
    },
  };
}

function makeFakeCustomApi(opts?: {
  readonly templates?: ReadonlyMap<string, AgentTemplate>;
  readonly throwOnTemplateGet?: { status: number };
  readonly throwOnAgentCreate?: { status: number };
}): CustomObjectsApi & {
  readonly creates: readonly { namespace: string; body: unknown }[];
  readonly templateGets: readonly { namespace: string; name: string }[];
} {
  const creates: { namespace: string; body: unknown }[] = [];
  const templateGets: { namespace: string; name: string }[] = [];
  const fake = {
    creates,
    templateGets,
    getNamespacedCustomObject(args: { namespace: string; name: string; plural: string }) {
      if (args.plural === 'agenttemplates') {
        templateGets.push({ namespace: args.namespace, name: args.name });
        if (opts?.throwOnTemplateGet !== undefined) {
          const e = new Error('template-not-found') as Error & { code?: number };
          e.code = opts.throwOnTemplateGet.status;
          return Promise.reject(e);
        }
        const tmpl = opts?.templates?.get(`${args.namespace}/${args.name}`);
        if (tmpl === undefined) {
          const e = new Error('not found') as Error & { code?: number };
          e.code = 404;
          return Promise.reject(e);
        }
        return Promise.resolve(tmpl);
      }
      const e = new Error('unknown plural') as Error & { code?: number };
      e.code = 404;
      return Promise.reject(e);
    },
    createNamespacedCustomObject(args: { namespace: string; plural: string; body: unknown }) {
      if (opts?.throwOnAgentCreate !== undefined) {
        const e = new Error('create-failed') as Error & { code?: number };
        e.code = opts.throwOnAgentCreate.status;
        return Promise.reject(e);
      }
      creates.push({ namespace: args.namespace, body: args.body });
      return Promise.resolve(args.body);
    },
  };
  return fake as unknown as CustomObjectsApi & {
    readonly creates: readonly { namespace: string; body: unknown }[];
    readonly templateGets: readonly { namespace: string; name: string }[];
  };
}

interface FakeResponse {
  status?: number;
  body?: string;
  headers: Record<string, string>;
}

function makeFakeReqRes(opts: {
  readonly method: string;
  readonly url: string;
  readonly body?: unknown;
}): { req: IncomingMessage; res: ServerResponse; out: FakeResponse } {
  const out: FakeResponse = { headers: {} };
  // Fake IncomingMessage with .on('data'|'end'|'error') stub.
  const dataChunks =
    opts.body !== undefined ? [Buffer.from(JSON.stringify(opts.body), 'utf8')] : [];
  const handlers: Record<string, ((arg?: unknown) => void)[]> = {};
  const req = {
    method: opts.method,
    url: opts.url,
    on(event: string, cb: (arg?: unknown) => void): void {
      (handlers[event] ??= []).push(cb);
    },
    destroy(): void {},
  } as unknown as IncomingMessage;
  // Schedule data + end on next microtask so the handler can attach
  // listeners first.
  setImmediate(() => {
    for (const chunk of dataChunks) {
      handlers.data?.forEach((h) => h(chunk));
    }
    handlers.end?.forEach((h) => h());
  });

  const res = {
    writeHead(status: number, headers: Record<string, string>): void {
      out.status = status;
      Object.assign(out.headers, headers);
    },
    end(payload: string): void {
      out.body = payload;
    },
  } as unknown as ServerResponse;

  return { req, res, out };
}

async function callHandler(opts: {
  readonly customApi: CustomObjectsApi;
  readonly templateName: string;
  readonly body: InstantiatePostBody;
  readonly namespace?: string;
}): Promise<{ status: number; body: InstantiatePostResponse | InstantiatePostError }> {
  const handler = buildInstantiateHandler({
    customApi: opts.customApi,
    resolveNamespace: () => opts.namespace ?? 'kagent-system',
    clock: () => FIXED_DATE,
  });
  const url = `/v1alpha1/templates/${encodeURIComponent(opts.templateName)}:instantiate`;
  const { req, res, out } = makeFakeReqRes({ method: 'POST', url, body: opts.body });
  await handler(req, res);
  // Wait one tick for end()-on-fake to flush.
  await new Promise((r) => setImmediate(r));
  return {
    status: out.status ?? 0,
    body: JSON.parse(out.body ?? '{}') as InstantiatePostResponse | InstantiatePostError,
  };
}

describe('template-server', () => {
  it('happy path: creates Agent, returns 201 + manifest identity', async () => {
    const tmpl = makeTemplate();
    const customApi = makeFakeCustomApi({
      templates: new Map([[`kagent-system/${tmpl.metadata.name ?? ''}`, tmpl]]),
    });
    const result = await callHandler({
      customApi,
      templateName: 'summarizer',
      body: {
        parameterValues: { topic: 'rust async' },
        createdByTaskUid: 'uid-task-1',
      },
    });
    expect(result.status).toBe(201);
    const body = result.body as InstantiatePostResponse;
    expect(body.namespace).toBe('kagent-system');
    expect(body.templateRef).toBe('summarizer@v1');
    expect(body.reused).toBe(false);
    expect(body.parameterHash).toMatch(/^[a-z2-7]{8}$/);
    expect(body.agentName.startsWith('summarizer-')).toBe(true);
    expect(customApi.creates.length).toBe(1);
    expect(customApi.creates[0]?.namespace).toBe('kagent-system');
  });

  it('returns 200 + reused=true on K8s 409 (idempotent re-instantiate)', async () => {
    const tmpl = makeTemplate();
    const customApi = makeFakeCustomApi({
      templates: new Map([[`kagent-system/${tmpl.metadata.name ?? ''}`, tmpl]]),
      throwOnAgentCreate: { status: 409 },
    });
    const result = await callHandler({
      customApi,
      templateName: 'summarizer',
      body: {
        parameterValues: { topic: 'rust async' },
        createdByTaskUid: 'uid-task-2',
      },
    });
    expect(result.status).toBe(200);
    expect((result.body as InstantiatePostResponse).reused).toBe(true);
  });

  it('returns 404 + template_not_found when the template is missing', async () => {
    const customApi = makeFakeCustomApi({ templates: new Map() });
    const result = await callHandler({
      customApi,
      templateName: 'missing-template',
      body: {
        parameterValues: {},
        createdByTaskUid: 'uid-task',
      },
    });
    expect(result.status).toBe(404);
    expect((result.body as InstantiatePostError).code).toBe('template_not_found');
  });

  it('returns 400 + parameter_missing on a missing required param', async () => {
    const tmpl = makeTemplate();
    const customApi = makeFakeCustomApi({
      templates: new Map([[`kagent-system/${tmpl.metadata.name ?? ''}`, tmpl]]),
    });
    const result = await callHandler({
      customApi,
      templateName: 'summarizer',
      body: {
        parameterValues: {},
        createdByTaskUid: 'uid-task',
      },
    });
    expect(result.status).toBe(400);
    expect((result.body as InstantiatePostError).code).toBe('parameter_missing');
  });

  it('returns 400 + parameter_invalid on a regex miss', async () => {
    const tmpl = makeTemplate();
    const customApi = makeFakeCustomApi({
      templates: new Map([[`kagent-system/${tmpl.metadata.name ?? ''}`, tmpl]]),
    });
    const result = await callHandler({
      customApi,
      templateName: 'summarizer',
      body: {
        parameterValues: { topic: 'invalid!@#' },
        createdByTaskUid: 'uid-task',
      },
    });
    expect(result.status).toBe(400);
    expect((result.body as InstantiatePostError).code).toBe('parameter_invalid');
  });

  it('returns 400 on bad request body shape', async () => {
    const customApi = makeFakeCustomApi({ templates: new Map() });
    const result = await callHandler({
      customApi,
      templateName: 'summarizer',
      body: {
        // missing createdByTaskUid
        parameterValues: { topic: 'x' },
      } as unknown as InstantiatePostBody,
    });
    expect(result.status).toBe(400);
    expect((result.body as InstantiatePostError).code).toBe('bad_request');
  });
});

describe('template-server JWKS endpoint (v0.3.0-capabilities)', () => {
  it('GET /.well-known/jwks.json returns the configured keys', async () => {
    const fakeKeys = [{ kty: 'EC', kid: 'test-1', alg: 'ES256', use: 'sig' }];
    const handler = buildInstantiateHandler({
      customApi: makeFakeCustomApi({ templates: new Map() }),
      resolveNamespace: () => 'kagent-system',
      jwksProvider: () => ({ keys: fakeKeys }),
    });
    const { req, res, out } = makeFakeReqRes({
      method: 'GET',
      url: '/.well-known/jwks.json',
    });
    await handler(req, res);
    await new Promise((r) => setImmediate(r));
    expect(out.status).toBe(200);
    expect(out.headers['cache-control']).toContain('max-age');
    const body = JSON.parse(out.body ?? '{}') as { keys: unknown[] };
    expect(body.keys).toEqual(fakeKeys);
  });

  it('GET /.well-known/jwks.json returns 404 when JWKS provider absent', async () => {
    const handler = buildInstantiateHandler({
      customApi: makeFakeCustomApi({ templates: new Map() }),
      resolveNamespace: () => 'kagent-system',
    });
    const { req, res, out } = makeFakeReqRes({
      method: 'GET',
      url: '/.well-known/jwks.json',
    });
    await handler(req, res);
    await new Promise((r) => setImmediate(r));
    expect(out.status).toBe(404);
    const body = JSON.parse(out.body ?? '{}') as { code?: string };
    expect(body.code).toBe('jwks_disabled');
  });

  it('rejects non-GET on JWKS path with 405', async () => {
    const handler = buildInstantiateHandler({
      customApi: makeFakeCustomApi({ templates: new Map() }),
      resolveNamespace: () => 'kagent-system',
      jwksProvider: () => ({ keys: [] }),
    });
    const { req, res, out } = makeFakeReqRes({
      method: 'POST',
      url: '/.well-known/jwks.json',
    });
    await handler(req, res);
    await new Promise((r) => setImmediate(r));
    expect(out.status).toBe(405);
  });
});
