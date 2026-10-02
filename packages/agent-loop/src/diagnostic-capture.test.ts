/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

import { describe, expect, it } from 'vitest';
import { AgentRegistry } from './registry.js';
import { AgentExecutor } from './executor.js';
import { chatAgent } from './__fixtures__/agents.js';
import { makeStubLLM } from './__fixtures__/stub-llm.js';
import { makeStubToolProvider } from './__fixtures__/stub-tool-provider.js';
import { makeRecordingSink } from './__fixtures__/stub-trace-sink.js';

it('preserves the actual long tool args and partial result, with secrets masked, before and after invocation', async () => {
  const registry = new AgentRegistry();
  registry.register(chatAgent);
  const sink = makeRecordingSink();
  const code = 'line'.repeat(600);
  const output = 'partial log '.repeat(300);
  const provider = makeStubToolProvider({
    id: 'code',
    tools: [{ name: 'code', description: '', inputSchema: { type: 'object' } }],
    onCall: () => {
      const started = sink.entries.find(
        (e) => e.trace_type === 'operation_started' && e.tool_name === 'code',
      );
      expect(started).toBeDefined();
      expect(started?.tool_input).toContain(code);
      expect(started?.tool_input).not.toContain('private-value');
      expect(started?.tool_schema).toContain('object');
      return { content: output, isError: true };
    },
  });
  const llm = makeStubLLM({
    scriptedResponses: [
      {
        content: '',
        tool_calls: [{ id: 't1', name: 'code', args: { code, password: 'private-value' } }],
      },
      { content: 'done' },
    ],
  });
  const run = await new AgentExecutor({
    registry,
    llm,
    toolProviders: [provider],
    sinks: [sink],
  }).run({ agentType: 'chat', messages: [{ role: 'user', content: 'run code' }] });
  const tool = run.traces.find((e) => e.trace_type === 'tool_call');
  expect(tool?.tool_input).toContain(code);
  expect(tool?.tool_output).toBe(output);
  expect(JSON.stringify(run.traces)).not.toContain('private-value');
});

describe('interrupted operations', () => {
  it('records the LLM operation before awaiting a stalled backend', async () => {
    const registry = new AgentRegistry();
    registry.register(chatAgent);
    const controller = new AbortController();
    const sink = makeRecordingSink();
    const llm = {
      id: 'stalled',
      chat: async () => {
        await Promise.resolve();
        expect(
          sink.entries.some(
            (e) => e.trace_type === 'operation_started' && e.operation_kind === 'llm_call',
          ),
        ).toBe(true);
        controller.abort();
        throw new Error('aborted');
      },
    };
    const result = await new AgentExecutor({ registry, llm, sinks: [sink] }).run({
      agentType: 'chat',
      messages: [{ role: 'user', content: 'go' }],
      signal: controller.signal,
    });
    expect(result.status).toBe('cancelled');
  });
});

it('bounds oversize diagnostic output explicitly and redacts secrets before truncation', async () => {
  const { captureDiagnostic } = await import('./diagnostic-capture.js');
  const safe = captureDiagnostic({ password: 'hidden', output: '\\'.repeat(100_000) });
  expect(safe.length).toBeLessThanOrEqual(65_536);
  expect(safe).toContain('truncated');
  expect(safe).not.toContain('hidden');
});

it('redacts credentials embedded in schema/transport error text', async () => {
  const { captureDiagnostic } = await import('./diagnostic-capture.js');
  expect(captureDiagnostic('bad arguments: {"password":"hidden-value"}')).not.toContain(
    'hidden-value',
  );
});

it('preserves credential-named schema definitions while masking actual values', async () => {
  const registry = new AgentRegistry();
  registry.register(chatAgent);
  const sink = makeRecordingSink();
  const inputSchema = {
    type: 'object',
    required: ['token', 'api_key', 'authorization'],
    dependentRequired: { token: ['authorization'] },
    properties: {
      token: {
        type: 'string',
        minLength: 1,
        default: 'default-private',
        examples: ['example-private'],
      },
      api_key: { type: 'string' },
      authorization: { type: 'string' },
      nested: {
        type: 'object',
        properties: { password: { type: 'string', default: 'nested-private' } },
      },
    },
  };
  const provider = makeStubToolProvider({
    id: 'schema',
    tools: [{ name: 'schema', description: '', inputSchema }],
    onCall: () => ({ content: 'ok', isError: false }),
  });
  await new AgentExecutor({
    registry,
    sinks: [sink],
    toolProviders: [provider],
    llm: makeStubLLM({
      scriptedResponses: [
        {
          content: '',
          tool_calls: [{ id: 's1', name: 'schema', args: { token: 'argument-private' } }],
        },
        { content: 'done' },
      ],
    }),
  }).run({ agentType: 'chat', messages: [{ role: 'user', content: 'go' }] });
  const started = sink.entries.find(
    (entry) => entry.trace_type === 'operation_started' && entry.tool_name === 'schema',
  );
  expect(JSON.parse(started!.tool_schema!)).toMatchObject({
    required: ['token', 'api_key', 'authorization'],
    dependentRequired: { token: ['authorization'] },
    properties: {
      token: { type: 'string', minLength: 1, examples: ['[REDACTED]'] },
      api_key: { type: 'string' },
      authorization: { type: 'string' },
    },
  });
  expect(started?.tool_schema).not.toContain('default-private');
  expect(started?.tool_schema).not.toContain('example-private');
  expect(started?.tool_schema).not.toContain('nested-private');
  expect(started?.tool_input).not.toContain('argument-private');
});
