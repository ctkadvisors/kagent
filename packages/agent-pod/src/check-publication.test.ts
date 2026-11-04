/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { expect, it } from 'vitest';
import { HttpToolProvider, signedIdentityHeaders } from '../../http-tool-provider/src/provider.js';
import { ToolGatewayHttpHandler } from '../../tool-gateway/src/http-server.js';
import { LocalCodeRunner } from '../../tool-gateway/src/code-runner.js';
import { defineFleetRunTool } from '../../tool-gateway/src/fleet-run-tool.js';
import { ToolGatewayProvider } from './tool-gateway-provider.js';

const task = {
  tenant: 't',
  namespace: 'n',
  taskUid: 'task',
  agentName: 'check-intakewatch-fixture',
};
const binding = {
  folder: '2026-10-26-intakewatch',
  sha: 'a'.repeat(40),
  run: 'python3 emit_fixture.py',
};
const ctx = () => ({ runId: 'run', abortSignal: new AbortController().signal });
const fixture = (name: string) => fileURLToPath(new URL('./__fixtures__/' + name, import.meta.url));
function oracle(bodies: string[]): Array<{ exit: number | null; values: Record<string, number> }> {
  const process = spawnSync('python3', [fixture('parse_check_oracle.py')], {
    input: JSON.stringify(bodies),
    encoding: 'utf8',
  });
  if (process.status !== 0) throw new Error(process.stderr);
  return JSON.parse(process.stdout) as Array<{
    exit: number | null;
    values: Record<string, number>;
  }>;
}
async function setup(report: Record<string, unknown> = { stuck_receipt_count: 2 }, exit = 1) {
  const root = await mkdtemp(join(tmpdir(), 'check-publication-'));
  const runner = new LocalCodeRunner({ workspaceDir: root, env: { PATH: process.env.PATH ?? '' } });
  const pinned = await readFile(fixture('intakewatch_3e06c051.py'), 'utf8');
  const seen: Array<{ body: string; headers: Record<string, string> }> = [];
  const signed = new HttpToolProvider({
    baseUrl: 'http://forum',
    signIdentityWith: 'fixture-key',
    tools: [
      {
        name: 'fleet.forum_post',
        description: 'forum',
        inputSchema: {
          type: 'object',
          required: ['topic', 'body'],
          properties: { topic: { type: 'string' }, body: { type: 'string' } },
        },
        method: 'POST',
        path: '/api/post',
      },
    ],
    fetch: (_url, init) => {
      if (typeof init?.body !== 'string') throw new Error('expected signed JSON body');
      seen.push({ body: init.body, headers: init?.headers as Record<string, string> });
      return Promise.resolve(new Response('{"id":99}', { status: 201 }));
    },
  });
  const tool = defineFleetRunTool({
    playgroundUrl: 'http://playground',
    signingKey: 'fixture-key',
    codeRunnerFor: () => runner,
    fetch: () =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            files: {
              'intakewatch.py': pinned,
              'emit_fixture.py':
                'import intakewatch,json\nintakewatch.emit(' +
                exit +
                ',json.loads(' +
                JSON.stringify(JSON.stringify(report)) +
                '),[],[])\nraise SystemExit(' +
                exit +
                ')\n',
            },
          }),
        ),
      ),
  });
  const handler = new ToolGatewayHttpHandler({
    codeRunner: runner,
    externalDescriptors: signed.describeTools(),
    externalHandlers: {
      'fleet.run_tool': tool,
      'fleet.forum_post': (input) =>
        signed.executeTool(input.call, {
          ...ctx(),
          task: input.task,
          abortSignal: input.request.signal,
        }),
    },
  });
  const options = {
    baseUrl: 'http://gateway',
    task,
    tools: ['fleet.run_tool', 'fleet.forum_post'],
    rawResultStorage: {
      root: join(root, 'cas'),
      maxContentChars: 16000,
      maxBytes: 1024 * 1024,
      maxTotalBytes: 2 * 1024 * 1024,
      expiresAt: Date.now() + 60000,
    },
    fetch: (async (url: string | URL | Request, init?: RequestInit) =>
      handler.handle(new Request(url, init))) as typeof fetch,
  };
  return { provider: new ToolGatewayProvider(options), seen, options };
}
async function source(s: Awaited<ReturnType<typeof setup>>, id = 'source') {
  const result = await s.provider.executeTool({ id, name: 'fleet.run_tool', args: binding }, ctx());
  expect(result.isError).toBe(false);
  if (typeof result.content !== 'string') throw new Error('expected source envelope');
  return JSON.parse(result.content) as {
    stdout: string;
    exit: number;
    _kagent_tool_result_ref: { uri: string; artifact: { checksum: string } };
  };
}
async function publish(
  s: Awaited<ReturnType<typeof setup>>,
  uri: string,
  args: Record<string, unknown> = {},
) {
  return s.provider.executeTool(
    {
      id: 'publish',
      name: 'fleet.forum_post',
      args: { topic: 'note', bodyFromToolResult: { uri }, ...args },
    },
    ctx(),
  );
}

it('explicitly publishes the exact pinned emit result through the existing signed provider without a code grant', async () => {
  const s = await setup();
  const result = await source(s);
  expect(result._kagent_tool_result_ref).toBeDefined();
  expect(s.seen).toHaveLength(0);
  expect((await publish(s, result._kagent_tool_result_ref.uri)).isError).toBe(false);
  const sent = s.seen[0]!;
  const body = (JSON.parse(sent.body) as { body: string }).body;
  expect(body.startsWith(result.stdout)).toBe(true);
  expect(oracle([result.stdout, body]).map((row) => row.values.stuck_receipt_count)).toEqual([
    2, 2,
  ]);
  expect(oracle([body])[0]?.exit).toBe(1);
  expect(sent.headers).toMatchObject(
    signedIdentityHeaders(
      'fixture-key',
      task,
      sent.body,
      Number(sent.headers['X-Kagent-Ts']) * 1000,
    ),
  );
});

it('preserves the existing parser values under the 8000-character bound for the complete 100-row report', async () => {
  const report = {
    budget: { max_age_seconds: 86400, max_attempts: 20 },
    counts: { retrying: 2, completed: 98 },
    worker_running: true,
    stuck_receipt_count: 2,
    unknown: null,
    receipts: Array.from({ length: 100 }, (_, i) => ({ receipt: i, note: '雪'.repeat(100) })),
    samples: [1, 2, 3],
    findings: [],
  };
  const s = await setup(report);
  const result = await source(s);
  expect(result.stdout.length).toBeGreaterThan(16000);
  expect(result._kagent_tool_result_ref).toBeDefined();
  const published = await publish(s, result._kagent_tool_result_ref.uri);
  expect(published.isError).toBe(false);
  const body = (JSON.parse(s.seen[0]!.body) as { body: string }).body;
  expect(body.length).toBeLessThanOrEqual(8000);
  const parsed = oracle([result.stdout, body]);
  expect(parsed[1]?.values).toEqual(parsed[0]?.values);
  expect(parsed[1]?.exit).toBe(1);
  expect(body).toContain('"unknown":null');
  expect(body).toContain('Numeric projection');
  expect(body).toContain(createHash('sha256').update(result.stdout).digest('hex'));
});

it('preserves unknown numeric results and historical post7758 instead of inventing zero', async () => {
  const original = JSON.parse(await readFile(fixture('forum-7758-original.json'), 'utf8')) as {
    posts: Array<{ body: string }>;
  };
  expect(oracle([original.posts[0]!.body])[0]).toMatchObject({ exit: 1, values: {} });
  const s = await setup({ stuck_receipt_count: null, status: 'provenance_unverified' }, 2);
  const result = await source(s);
  expect((await publish(s, result._kagent_tool_result_ref.uri)).isError).toBe(false);
  expect(oracle([(JSON.parse(s.seen[0]!.body) as { body: string }).body])[0]).toMatchObject({
    exit: 2,
    values: {},
  });
});

it('advertises the reference as an optional property while body stays required', async () => {
  const s = await setup();
  const descriptors = await s.provider.describeTools(ctx());
  const descriptor = descriptors.find((value) => value.name === 'fleet.forum_post');
  expect(descriptor?.description).toContain('bodyFromToolResult');
  expect(descriptor?.inputSchema).toMatchObject({
    required: ['topic', 'body'],
    properties: { body: { type: 'string' }, bodyFromToolResult: { required: ['uri'] } },
  });
  // llama.cpp turns a top-level combinator into the whole grammar and drops properties.
  for (const key of ['oneOf', 'anyOf', 'allOf', 'not'])
    expect(descriptor?.inputSchema).not.toHaveProperty(key);
});

it('replaces a model-written body with the referenced result', async () => {
  const s = await setup();
  const result = await source(s);
  const published = await publish(s, result._kagent_tool_result_ref.uri, { body: 'model prose' });
  expect(published.isError).toBe(false);
  const body = (JSON.parse(s.seen[0]!.body) as { body: string }).body;
  expect(body.startsWith(result.stdout)).toBe(true);
  expect(body).not.toContain('model prose');
});

it('refuses unknown, foreign, other-run, expired, and ambiguous references before signed publication', async () => {
  const s = await setup();
  const result = await source(s);
  const uri = result._kagent_tool_result_ref.uri;
  expect((await publish(s, uri + '-missing')).isError).toBe(true);
  expect(
    (
      await publish(
        {
          ...s,
          provider: new ToolGatewayProvider({
            ...s.options,
            task: { ...task, taskUid: 'foreign' },
          }),
        },
        uri,
      )
    ).isError,
  ).toBe(true);
  expect(
    (
      await s.provider.executeTool(
        {
          id: 'post',
          name: 'fleet.forum_post',
          args: { topic: 'note', bodyFromToolResult: { uri } },
        },
        { ...ctx(), runId: 'other' },
      )
    ).isError,
  ).toBe(true);
  const repeated = await source(s);
  expect(repeated._kagent_tool_result_ref).toBeUndefined();
  expect((await publish(s, uri)).isError).toBe(true);
  const clock = { now: Date.now() };
  const expiring = {
    ...s,
    provider: new ToolGatewayProvider({
      ...s.options,
      rawResultStorage: {
        ...s.options.rawResultStorage,
        expiresAt: clock.now + 1000,
        now: () => clock.now,
      },
    }),
  };
  const fresh = await source(expiring, 'fresh');
  clock.now += 1001;
  expect((await publish(expiring, fresh._kagent_tool_result_ref.uri)).isError).toBe(true);
  expect(s.seen).toHaveLength(0);
});

it('keeps plain posts available and does not add a forum grant', async () => {
  const s = await setup();
  const plain = await s.provider.executeTool(
    { id: 'plain', name: 'fleet.forum_post', args: { topic: 'note', body: 'ordinary note' } },
    ctx(),
  );
  expect(plain.isError).toBe(false);
  expect(JSON.parse(s.seen[0]!.body)).toEqual({ topic: 'note', body: 'ordinary note' });
  const ungranted = new ToolGatewayProvider({ ...s.options, tools: ['fleet.run_tool'] });
  const denied = await ungranted.executeTool(
    {
      id: 'denied',
      name: 'fleet.forum_post',
      args: { topic: 'note', bodyFromToolResult: { uri: 'unknown' } },
    },
    ctx(),
  );
  expect(denied.isError).toBe(true);
  expect(s.seen).toHaveLength(1);
});

it('projects raw numeric lexemes, list means, member order and the 200-value boundary exactly as the unchanged Python parser', async () => {
  const { checkPublication } = await import('./check-publication.js');
  const padding = '"padding":' + JSON.stringify('x'.repeat(9000));
  const cases = [
    '{' +
      padding +
      ',"ints":[10000000000000000,1,-10000000000000000],"floats":[1e16,1,-1e16],"mixed":[2,true,"a",null,4],"bools":[true,false],"empty":[],"unknown":null,"bool":true}',
    '{' +
      padding +
      ',"2":2,"10":10,' +
      Array.from({ length: 205 }, (_, i) => JSON.stringify('n' + i) + ':' + i).join(',') +
      '}',
    '{' +
      padding +
      ',"a.b":1,"a":{"b":2},"nested":{"unknown":null,"no":false},"overflow":1e400,"tiny":-0.0}',
    '{' + padding + ',"brace":"{quoted}","stuck_receipt_count":null}',
  ];
  for (const report of cases) {
    const stdout = 'fixture on source: exit 2\n\n' + report + '\n';
    const built = checkPublication(stored(stdout));
    const parsed = oracle([stdout, built.body]);
    expect(parsed[1]?.values).toEqual(parsed[0]?.values);
    expect(parsed[1]?.exit).toBe(parsed[0]?.exit);
    expect([...built.body].length).toBeLessThanOrEqual(8000);
  }
});

function stored(stdout: string, changes: Record<string, unknown> = {}) {
  const content = JSON.stringify({
    ...binding,
    exit: 2,
    timedOut: false,
    outputComplete: true,
    stdout,
    stderr: '',
    ...changes,
  });
  const digest = createHash('sha256').update(content).digest('hex');
  return {
    content,
    arguments: binding,
    reference: {
      schema: 'kagent-ephemeral-tool-result/v1' as const,
      scope: 'task' as const,
      uri: 'unit-projection-only',
      taskUid: task.taskUid,
      runId: 'run',
      operationId: 'source',
      sourceTool: 'fleet.run_tool',
      sourceArgumentsHash: createHash('sha256').update(JSON.stringify(binding)).digest('hex'),
      receivedAt: Date.now() / 1000,
      expiresAt: Date.now() / 1000 + 60,
      encoding: 'utf8-provider-content' as const,
      artifact: {
        uri: 'unit-projection-only',
        name: 'result',
        mediaType: 'text/plain',
        sizeBytes: Buffer.byteLength(content),
        checksum: 'sha256:' + digest,
        contentHash: digest,
        producedAt: new Date().toISOString(),
      },
    },
  };
}

it('refuses incomplete, timeout, pin-mismatched, prose-only, conflicting-exit and unrepresentably large results', async () => {
  const { checkPublication } = await import('./check-publication.js');
  const stdout = 'fixture on source: exit 2\n\n{"unknown":null}';
  for (const changes of [
    { outputComplete: false },
    { outputComplete: undefined },
    { timedOut: true },
    { exit: null },
    { exit: 0 },
    { sha: 'b'.repeat(40) },
    { run: 'other command' },
    { stdout: 'fixture on source: exit 2\nprose only' },
    { stdout: 'fixture on source: exit 2\n{"duplicate":1,"duplicate":2}' },
  ]) {
    expect(() => checkPublication(stored(stdout, changes))).toThrow();
  }
  const huge =
    'fixture on source: exit 2\n\n{"numbers":[' +
    Array.from({ length: 5000 }, () => '123').join(',') +
    ']}';
  expect(() => checkPublication(stored(huge))).toThrow('unavailable');
});

it('refuses a selected duplicate-key object without publishing a later nested object', async () => {
  const s = await setup();
  const originalFetch = s.options.fetch;
  const provider = new ToolGatewayProvider({
    ...s.options,
    fetch: async (url, init) => {
      const response = await originalFetch(url, init);
      if (typeof init?.body !== 'string') throw new Error('expected invocation body');
      const invocation = JSON.parse(init.body) as { call: { name: string } };
      if (invocation.call.name !== 'fleet.run_tool') return response;
      const result = (await response.json()) as { content: string; isError: boolean };
      const envelope = JSON.parse(result.content) as Record<string, unknown>;
      envelope.stdout =
        'fixture on source: exit 1\n\n{"outer":1,"outer":2,"nested":{"stuck_receipt_count":99}}';
      return new Response(JSON.stringify({ ...result, content: JSON.stringify(envelope) }));
    },
  });
  const wrapped = { ...s, provider };
  const result = await source(wrapped);
  expect((await publish(wrapped, result._kagent_tool_result_ref.uri)).isError).toBe(true);
  expect(s.seen).toHaveLength(0);
});
