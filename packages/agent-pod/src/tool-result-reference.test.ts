/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

import { createHash } from 'node:crypto';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { ToolGatewayHttpHandler } from '../../tool-gateway/src/http-server.js';
import { LocalCodeRunner } from '../../tool-gateway/src/code-runner.js';
import { ToolGatewayProvider } from './tool-gateway-provider.js';
import { TaskToolResultStore } from './tool-result-reference.js';
import { AgentExecutor, AgentRegistry, type ChatRequest } from '@kagent/agent-loop';
import { chatAgent } from '../../agent-loop/src/__fixtures__/agents.js';
import { makeStubLLM } from '../../agent-loop/src/__fixtures__/stub-llm.js';

function text(content: unknown): string {
  if (typeof content !== 'string') throw new Error('expected text result');
  return content;
}

const TASK = { tenant: 't', namespace: 'ns', taskUid: 'task-a', agentName: 'auditor' };
const ctx = () => ({ runId: 'run-a', abortSignal: new AbortController().signal });
const raw = JSON.stringify({
  counts: { completed: 99, retrying: 1 },
  worker_running: true,
  receipts: Array.from({ length: 100 }, (_, i) => ({
    receipt_id: String(i),
    status: i === 99 ? 'retrying' : 'completed',
    group_id: 'fleet-audit',
    attempts: i === 99 ? 30 : 1,
    accepted_at: 100,
    note: 'quoted " and 雪 '.repeat(25),
  })),
});

type Receipt = {
  uri: string;
  scope: string;
  operationId: string;
  sourceTool: string;
  receivedAt: number;
  artifact: { checksum: string; sizeBytes: number };
};

async function setup(content: string | { type: 'text'; text: string }[] = raw) {
  const root = await mkdtemp(join(tmpdir(), 'raw-result-reference-'));
  const runner = new LocalCodeRunner({
    workspaceDir: root,
    env: { PATH: process.env.PATH ?? '', HOME: root, TMPDIR: root },
  });
  const calls: string[] = [];
  const clock = { now: Date.now() };
  const handler = new ToolGatewayHttpHandler({
    codeRunner: runner,
    externalHandlers: { 'mcp.get_ingestion_status': () => ({ content, isError: false }) },
    externalDescriptors: [{ name: 'mcp.get_ingestion_status', description: '', inputSchema: {} }],
  });
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const request = new Request(input, init);
    calls.push(request.url);
    return handler.handle(request);
  }) as typeof globalThis.fetch;
  const options = {
    baseUrl: 'http://gateway',
    task: TASK,
    tools: ['mcp.get_ingestion_status', 'code_interpreter.execute_code'],
    fetch,
    rawResultStorage: {
      root: join(root, 'cas'),
      maxContentChars: 16000,
      maxBytes: 1024 * 1024,
      maxTotalBytes: 2 * 1024 * 1024,
      expiresAt: clock.now + 60_000,
      now: () => clock.now,
    },
  };
  return { root, runner, calls, clock, options, provider: new ToolGatewayProvider(options) };
}

it('retains exact oversized source bytes and explicitly imports them through the ordinary code call', async () => {
  const s = await setup();
  const result = await s.provider.executeTool(
    { id: 'status-1', name: 'mcp.get_ingestion_status', args: { limit: 100 } },
    ctx(),
  );
  const value = JSON.parse(text(result.content)) as { _kagent_tool_result_ref?: Receipt };
  expect(value._kagent_tool_result_ref).toBeDefined();
  const ref = value._kagent_tool_result_ref!;
  expect(ref.scope).toBe('task');
  expect(ref.operationId).toBe('status-1');
  expect(ref.sourceTool).toBe('mcp.get_ingestion_status');
  expect(ref.artifact.checksum).toBe('sha256:' + createHash('sha256').update(raw).digest('hex'));
  expect(ref.artifact.sizeBytes).toBe(Buffer.byteLength(raw));
  expect(s.calls).toHaveLength(1); // Capturing did not invoke a tool or execute code.
  const helper = await readFile(
    fileURLToPath(new URL('./__fixtures__/capture_intake_status_3e06c051.py', import.meta.url)),
    'utf8',
  );
  await s.runner.writeFiles([{ path: 'capture_intake_status.py', content: helper }]);
  const imported = await s.provider.executeTool(
    {
      id: 'code-1',
      name: 'code_interpreter.execute_code',
      args: {
        language: 'python',
        inputArtifacts: [{ uri: ref.uri, path: 'captures/raw.json' }],
        code: "import json,subprocess,sys\nfrom pathlib import Path\nm=json.loads(Path('captures/raw.json.source.json').read_text())\np=subprocess.run([sys.executable,'capture_intake_status.py','--raw','captures/raw.json','--out','captures/judged.json','--limit',str(m['tool_arguments']['limit']),'--captured-at',str(m['received_at'])],capture_output=True,text=True)\nassert p.returncode==0,p.stderr\nprint(p.stdout)",
      },
    },
    ctx(),
  );
  expect(imported.isError).toBe(false);
  expect(await readFile(join(s.root, 'captures/raw.json'), 'utf8')).toBe(raw);
  const sidecar = JSON.parse(
    await readFile(join(s.root, 'captures/judged.json.provenance.json'), 'utf8'),
  ) as Record<string, unknown>;
  expect(await readFile(join(s.root, 'captures/judged.json'), 'utf8')).toBe(raw + '\n');
  expect(sidecar.sha256).toBe(
    createHash('sha256')
      .update(raw + '\n')
      .digest('hex'),
  );
  expect(sidecar.tool_arguments).toEqual({ limit: 100, group_id: null });
  expect(sidecar.received_at).toBe(ref.receivedAt);
  expect(s.calls).toHaveLength(2);
});

it('refuses a foreign reference before invoking or importing into another task', async () => {
  const s = await setup();
  const result = await s.provider.executeTool(
    { id: 'status', name: 'mcp.get_ingestion_status', args: {} },
    ctx(),
  );
  const ref = (JSON.parse(text(result.content)) as { _kagent_tool_result_ref: Receipt })
    ._kagent_tool_result_ref;
  expect(ref).toBeDefined();
  const foreign = new ToolGatewayProvider({ ...s.options, task: { ...TASK, taskUid: 'task-b' } });
  const before = s.calls.length;
  const rejected = await foreign.executeTool(
    {
      id: 'import',
      name: 'code_interpreter.execute_code',
      args: {
        language: 'python',
        code: 'print(1)',
        inputArtifacts: [{ uri: ref.uri, path: 'stolen.json' }],
      },
    },
    ctx(),
  );
  expect(rejected.isError).toBe(true);
  expect(text(rejected.content)).toContain('unavailable');
  expect(s.calls).toHaveLength(before);
});

it('does not retain uncapped results or turn source errors into successful result captures', async () => {
  const s = await setup();
  const small = new ToolGatewayProvider({
    ...s.options,
    rawResultStorage: { ...s.options.rawResultStorage, maxContentChars: raw.length + 1 },
  });
  expect(
    (await small.executeTool({ id: 'small', name: 'mcp.get_ingestion_status', args: {} }, ctx()))
      .content,
  ).toBe(raw);
  const failed = new ToolGatewayProvider({
    ...s.options,
    fetch: () => Promise.resolve(new Response(JSON.stringify({ content: raw, isError: true }))),
  });
  const result = await failed.executeTool(
    { id: 'error', name: 'mcp.get_ingestion_status', args: {} },
    ctx(),
  );
  expect(result.isError).toBe(true);
  expect(text(result.content)).not.toContain('_kagent_tool_result_ref');
});

it.each(['expired', 'missing', 'corrupt', 'traversal', 'aborted', 'other-run', 'reserved-field'])(
  'refuses %s imports before code execution',
  async (mode) => {
    const s = await setup();
    const source = await s.provider.executeTool(
      { id: 'status', name: 'mcp.get_ingestion_status', args: { limit: 100 } },
      ctx(),
    );
    const ref = (JSON.parse(text(source.content)) as { _kagent_tool_result_ref: Receipt })
      ._kagent_tool_result_ref;
    if (mode === 'expired') s.clock.now += 60_001;
    if (mode === 'corrupt') {
      const digest = ref.artifact.checksum.slice(7);
      await writeFile(
        join(s.root, 'cas', 'cas', 'sha256', digest.slice(0, 2), digest.slice(2)),
        'corrupt',
      );
    }
    const context = ctx();
    if (mode === 'aborted') {
      const controller = new AbortController();
      controller.abort();
      context.abortSignal = controller.signal;
    }
    if (mode === 'other-run') context.runId = 'run-b';
    const before = s.calls.length;
    const args: Record<string, unknown> = {
      language: 'python',
      code: 'print(1)',
      inputArtifacts: [
        {
          uri: mode === 'missing' ? 'cas://sha256:' + '0'.repeat(64) + '/missing' : ref.uri,
          path: mode === 'traversal' ? '../escape.json' : 'result.json',
        },
      ],
    };
    if (mode === 'reserved-field')
      args.inputFiles = [{ path: 'result.json', content: 'untrusted' }];
    const result = await s.provider.executeTool(
      { id: 'import', name: 'code_interpreter.execute_code', args },
      context,
    );
    expect(result.isError).toBe(true);
    expect(text(result.content)).toContain('unavailable');
    expect(s.calls).toHaveLength(before);
  },
);

it('preserves byte bounds and does not grant code access to a source-only caller', async () => {
  const s = await setup();
  const limited = new ToolGatewayProvider({
    ...s.options,
    rawResultStorage: { ...s.options.rawResultStorage, maxBytes: 1024 },
  });
  const oversized = await limited.executeTool(
    { id: 'large', name: 'mcp.get_ingestion_status', args: {} },
    ctx(),
  );
  expect(oversized.isError).toBe(false);
  expect(text(oversized.content)).toContain('_kagent_tool_result_ref_unavailable');
  const sourceOnly = new ToolGatewayProvider({ ...s.options, tools: ['mcp.get_ingestion_status'] });
  const unchanged = await sourceOnly.executeTool(
    { id: 'source-only', name: 'mcp.get_ingestion_status', args: {} },
    ctx(),
  );
  expect(unchanged.content).toBe(raw);
  const denied = await sourceOnly.executeTool(
    {
      id: 'code',
      name: 'code_interpreter.execute_code',
      args: { language: 'python', code: 'print(1)' },
    },
    ctx(),
  );
  expect(denied.isError).toBe(true);
  expect(text(denied.content)).toContain('not granted');
});

it('keeps explicit import under normal executor guards and never injects raw data into traced arguments', async () => {
  const secret = 'DO_NOT_TRACE_PRIVATE_RESULT';
  const sensitive = JSON.stringify({ password: secret, receipts: [], padding: 'x'.repeat(22000) });
  const s = await setup(sensitive);
  let executions = 0;
  const execute = s.runner.executeCode.bind(s.runner);
  s.runner.executeCode = (input) => {
    executions += 1;
    return execute(input);
  };
  const registry = new AgentRegistry();
  registry.register(chatAgent);
  let step = 0;
  let uri = '';
  const llm = {
    ...makeStubLLM(),
    chat(request: ChatRequest) {
      step += 1;
      if (step === 1)
        return Promise.resolve({
          content: '',
          tool_calls: [{ id: 'source', name: 'mcp.get_ingestion_status', args: { limit: 100 } }],
        });
      if (step === 2) {
        const message = String(request.messages.filter((m) => m.role === 'tool').at(-1)?.content);
        const receipt = JSON.parse(message.split(',"password":')[0] + '}') as {
          _kagent_tool_result_ref: Receipt;
        };
        uri = receipt._kagent_tool_result_ref.uri;
      }
      if (step < 4)
        return Promise.resolve({
          content: '',
          tool_calls: [
            {
              id: 'code-' + step,
              name: 'code_interpreter.execute_code',
              args: {
                language: 'python',
                inputArtifacts: [{ uri, path: 'private/result.json' }],
                code: "import json\nfrom pathlib import Path\nprint(len(json.loads(Path('private/result.json').read_text())['receipts']))",
              },
            },
          ],
        });
      return Promise.resolve({ content: 'done' });
    },
  };
  const result = await new AgentExecutor({
    registry,
    llm,
    toolProviders: [s.provider],
    toolGuards: { maxCallsPerTool: 1 },
  }).run({ agentType: 'chat', messages: [{ role: 'user', content: 'read' }] });
  expect(executions).toBe(1);
  expect(s.calls.filter((url) => url.endsWith('/invoke'))).toHaveLength(2);
  const traces = JSON.stringify(result.traces);
  expect(traces).not.toContain(secret);
  expect(traces).not.toContain('inputFiles');
  expect(traces).not.toContain(Buffer.from(sensitive).toString('base64'));
  const calls = result.traces.filter((event) => event.trace_type === 'tool_call');
  expect(calls).toHaveLength(3);
  expect(calls.at(-1)?.is_error).toBe(true);
  expect(await readFile(join(s.root, 'private/result.json'), 'utf8')).toBe(sensitive);
});

it('bounds cumulative retention and preserves structured content blocks exactly', async () => {
  const blocks = [
    { type: 'text' as const, text: 'untrusted notice' },
    { type: 'text' as const, text: raw },
  ];
  const s = await setup(blocks);
  const bounded = new ToolGatewayProvider({
    ...s.options,
    rawResultStorage: {
      ...s.options.rawResultStorage,
      maxTotalBytes: Buffer.byteLength(JSON.stringify(blocks)) + 4096,
    },
  });
  const first = await bounded.executeTool(
    { id: 'first', name: 'mcp.get_ingestion_status', args: {} },
    ctx(),
  );
  if (typeof first.content === 'string') throw new Error('expected original content blocks');
  const notice = first.content.at(-1);
  const ref = (JSON.parse(text(notice?.text)) as { _kagent_tool_result_ref: Receipt })
    ._kagent_tool_result_ref;
  expect(ref).toBeDefined();
  const imported = await bounded.executeTool(
    {
      id: 'code',
      name: 'code_interpreter.execute_code',
      args: {
        language: 'python',
        code: 'print(1)',
        inputArtifacts: [{ uri: ref.uri, path: 'blocks.json' }],
      },
    },
    ctx(),
  );
  expect(imported.isError).toBe(false);
  expect(await readFile(join(s.root, 'blocks.json'), 'utf8')).toBe(JSON.stringify(blocks));
  const second = await bounded.executeTool(
    { id: 'second', name: 'mcp.get_ingestion_status', args: {} },
    ctx(),
  );
  expect(JSON.stringify(second.content)).toContain('_kagent_tool_result_ref_unavailable');
});

it('preserves the protected accepted-use parser top-level envelope contract', async () => {
  const envelope = {
    folder: '2026-10-26-intakewatch',
    sha: 'b'.repeat(40),
    run: 'python3 intakewatch.py',
    exit: 1,
    timedOut: false,
    stdout: 'x'.repeat(20000),
    stderr: '',
  };
  const s = await setup(JSON.stringify(envelope));
  const result = await s.provider.executeTool(
    { id: 'capability-use', name: 'mcp.get_ingestion_status', args: {} },
    ctx(),
  );
  // authority.capability_work._tool_result requires these original top-level fields;
  // attaching a reference must not make a verified actual exit disappear.
  const parsed = JSON.parse(text(result.content)) as Record<string, unknown>;
  expect(parsed.exit).toBe(1);
  expect(parsed.timedOut).toBe(false);
  for (const [key, value] of Object.entries(envelope)) expect(parsed[key]).toEqual(value);
});

it.each(['object', 'blocks', 'encoded-blocks'])(
  'preserves the existing artifact receipt parser: %s',
  async (mode) => {
    const { tryParseArtifactRefFromToolOutput } = await import('./artifacts.js');
    const artifact = {
      uri: 'pvc://artifacts/task-a/result.json',
      name: 'result.json',
      checksum: 'sha256:' + 'c'.repeat(64),
      sizeBytes: 10,
      padding: 'x'.repeat(20000),
    };
    const blocks = [{ type: 'text' as const, text: JSON.stringify(artifact) }];
    const original =
      mode === 'object'
        ? JSON.stringify(artifact)
        : mode === 'encoded-blocks'
          ? JSON.stringify(blocks)
          : blocks;
    const s = await setup(original);
    const result = await s.provider.executeTool(
      { id: 'artifact-result', name: 'mcp.get_ingestion_status', args: {} },
      ctx(),
    );
    const serialized =
      typeof result.content === 'string' ? result.content : JSON.stringify(result.content);
    expect(tryParseArtifactRefFromToolOutput(serialized)?.uri).toBe(artifact.uri);
    expect(tryParseArtifactRefFromToolOutput(serialized)?.checksum).toBe(artifact.checksum);
  },
);

it('refuses retention when provenance would exceed the existing import byte bound', async () => {
  const root = await mkdtemp(join(tmpdir(), 'raw-result-bound-'));
  const store = new TaskToolResultStore(TASK, {
    root,
    maxContentChars: 1,
    maxBytes: 4096,
    maxTotalBytes: 16384,
    expiresAt: Date.now() + 60000,
  });
  const call = { id: 'near-bound', name: 'mcp.source', args: { limit: 100 } };
  await expect(store.retain(call, 'run-a', 'x'.repeat(3990), ctx().abortSignal)).rejects.toThrow(
    'unavailable',
  );
  const ref = await store.retain(call, 'run-a', 'x'.repeat(3000), ctx().abortSignal);
  const files = await store.importFiles(
    [{ uri: ref.uri, path: 'source.txt' }],
    'run-a',
    ctx().abortSignal,
  );
  expect(files[0]?.content).toBe('x'.repeat(3000));
  expect(
    files.reduce((total, file) => total + Buffer.byteLength(file.content), 0),
  ).toBeLessThanOrEqual(4096);
});

it('refuses captures whose escaped file transport exceeds the existing byte bound', async () => {
  const root = await mkdtemp(join(tmpdir(), 'raw-result-wire-bound-'));
  const store = new TaskToolResultStore(TASK, {
    root,
    maxContentChars: 1,
    maxBytes: 4096,
    maxTotalBytes: 16384,
    expiresAt: Date.now() + 60000,
  });
  await expect(
    store.retain(
      { id: 'escaped', name: 'mcp.source', args: {} },
      'run-a',
      '\u0000'.repeat(1000),
      ctx().abortSignal,
    ),
  ).rejects.toThrow('unavailable');
});
