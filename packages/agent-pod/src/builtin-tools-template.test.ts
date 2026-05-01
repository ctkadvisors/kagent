/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

import { describe, expect, it } from 'vitest';

import { buildTemplateToolProvider } from './builtin-tools-template.js';

const ABORT_CTX = {
  abortSignal: new AbortController().signal,
  runId: 'test-run',
};

function resultText(result: { content: unknown }): string {
  if (typeof result.content === 'string') return result.content;
  if (Array.isArray(result.content)) {
    const block = result.content[0] as { type?: string; text?: string } | undefined;
    if (block?.type === 'text' && typeof block.text === 'string') return block.text;
  }
  throw new Error('unexpected ToolResult content shape');
}

interface FetchCall {
  readonly url: string;
  readonly body: unknown;
}

function makeFetch(opts: { readonly status: number; readonly responseBody: unknown }): {
  fn: typeof fetch;
  calls: FetchCall[];
} {
  const calls: FetchCall[] = [];
  const fn: typeof fetch = (input, init) => {
    const url: string =
      typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    let body: unknown = undefined;
    const rawBody = init?.body;
    if (typeof rawBody === 'string' && rawBody.length > 0) {
      try {
        body = JSON.parse(rawBody);
      } catch {
        body = rawBody;
      }
    } else if (rawBody !== undefined && rawBody !== null) {
      body = rawBody;
    }
    calls.push({ url, body });
    const responseText = JSON.stringify(opts.responseBody);
    return Promise.resolve(
      new Response(responseText, {
        status: opts.status,
        headers: { 'content-type': 'application/json' },
      }),
    );
  };
  return { fn, calls };
}

async function callEnsure(provider: ReturnType<typeof buildTemplateToolProvider>, args: unknown) {
  return provider.executeTool({ id: '1', name: 'ensure_agent_from_template', args }, ABORT_CTX);
}

describe('ensure_agent_from_template', () => {
  it('POSTs to the right URL with the right body', async () => {
    const fetchPair = makeFetch({
      status: 201,
      responseBody: {
        agentName: 'summarizer-rust-async-abc12345',
        namespace: 'kagent-system',
        reused: false,
        templateRef: 'summarizer@v3',
        parameterHash: 'abc12345',
        droppedTools: [],
      },
    });
    const provider = buildTemplateToolProvider({
      serverUrl: 'http://operator.kagent-system.svc:8081',
      createdByTaskUid: 'uid-parent-task',
      fetch: fetchPair.fn,
    });
    const result = await callEnsure(provider, {
      templateName: 'summarizer',
      parameterValues: { topic: 'rust async' },
    });
    expect(result.isError).not.toBe(true);
    expect(fetchPair.calls.length).toBe(1);
    expect(fetchPair.calls[0]?.url).toBe(
      'http://operator.kagent-system.svc:8081/v1alpha1/templates/summarizer:instantiate',
    );
    const body = fetchPair.calls[0]?.body as {
      parameterValues: Record<string, string>;
      createdByTaskUid: string;
    };
    expect(body.parameterValues.topic).toBe('rust async');
    expect(body.createdByTaskUid).toBe('uid-parent-task');
    const parsed = JSON.parse(resultText(result)) as { agentName: string; reused: boolean };
    expect(parsed.agentName).toBe('summarizer-rust-async-abc12345');
    expect(parsed.reused).toBe(false);
  });

  it('returns reused=true when server returns 200 (idempotent)', async () => {
    const fetchPair = makeFetch({
      status: 200,
      responseBody: {
        agentName: 'summarizer-rust-async-abc12345',
        namespace: 'kagent-system',
        reused: true,
        templateRef: 'summarizer@v3',
        parameterHash: 'abc12345',
        droppedTools: [],
      },
    });
    const provider = buildTemplateToolProvider({
      serverUrl: 'http://op:8081',
      createdByTaskUid: 'uid',
      fetch: fetchPair.fn,
    });
    const result = await callEnsure(provider, {
      templateName: 'summarizer',
      parameterValues: { topic: 'rust async' },
    });
    const parsed = JSON.parse(resultText(result)) as { reused: boolean };
    expect(parsed.reused).toBe(true);
  });

  it('returns isError on parameter_unknown (4xx → tool error)', async () => {
    const fetchPair = makeFetch({
      status: 400,
      responseBody: {
        code: 'parameter_unknown',
        message: 'parameter "extra" is not declared in template "summarizer"',
      },
    });
    const provider = buildTemplateToolProvider({
      serverUrl: 'http://op:8081',
      createdByTaskUid: 'uid',
      fetch: fetchPair.fn,
    });
    const result = await callEnsure(provider, {
      templateName: 'summarizer',
      parameterValues: { extra: 'noooo' },
    });
    expect(result.isError).toBe(true);
    expect(resultText(result)).toContain('parameter_unknown');
    expect(resultText(result)).toContain('not declared');
  });

  it('returns isError on template_not_found (404 → tool error)', async () => {
    const fetchPair = makeFetch({
      status: 404,
      responseBody: {
        code: 'template_not_found',
        message: 'AgentTemplate kagent-system/missing not found',
      },
    });
    const provider = buildTemplateToolProvider({
      serverUrl: 'http://op:8081',
      createdByTaskUid: 'uid',
      fetch: fetchPair.fn,
    });
    const result = await callEnsure(provider, {
      templateName: 'missing',
      parameterValues: {},
    });
    expect(result.isError).toBe(true);
    expect(resultText(result)).toContain('template_not_found');
  });

  it('rejects missing required args (templateName) at parse time', async () => {
    const fetchPair = makeFetch({ status: 200, responseBody: {} });
    const provider = buildTemplateToolProvider({
      serverUrl: 'http://op:8081',
      createdByTaskUid: 'uid',
      fetch: fetchPair.fn,
    });
    const result = await callEnsure(provider, {
      parameterValues: { topic: 'x' },
    });
    expect(result.isError).toBe(true);
    expect(fetchPair.calls.length).toBe(0);
  });

  it('rejects parameter values that are not strings', async () => {
    const fetchPair = makeFetch({ status: 200, responseBody: {} });
    const provider = buildTemplateToolProvider({
      serverUrl: 'http://op:8081',
      createdByTaskUid: 'uid',
      fetch: fetchPair.fn,
    });
    const result = await callEnsure(provider, {
      templateName: 'summarizer',
      parameterValues: { topic: 42 },
    });
    expect(result.isError).toBe(true);
    expect(fetchPair.calls.length).toBe(0);
  });

  it('strips trailing slashes from serverUrl', async () => {
    const fetchPair = makeFetch({
      status: 201,
      responseBody: {
        agentName: 'a',
        namespace: 'ns',
        reused: false,
        templateRef: 'a@v1',
        parameterHash: 'h',
        droppedTools: [],
      },
    });
    const provider = buildTemplateToolProvider({
      serverUrl: 'http://op:8081////',
      createdByTaskUid: 'uid',
      fetch: fetchPair.fn,
    });
    await callEnsure(provider, {
      templateName: 'summarizer',
      parameterValues: {},
    });
    expect(fetchPair.calls[0]?.url).toBe(
      'http://op:8081/v1alpha1/templates/summarizer:instantiate',
    );
  });
});
