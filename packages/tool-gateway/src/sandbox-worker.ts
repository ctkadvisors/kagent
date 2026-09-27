/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/**
 * The worker inside a per-task code sandbox. The gateway creates one sandbox
 * Job per task (pod-code-runner.ts) and forwards that task's code calls here;
 * agent code runs in this pod, never beside the gateway's keys, and never in
 * another task's /tmp or workspace. The pod holds no service-account token and
 * no inherited env. It answers only the bearer token the gateway put in its
 * spec, and exits when idle so the Job's TTL can reap it.
 */

import { timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';

import { LocalCodeRunner } from './code-runner.js';

export const SANDBOX_OPS = [
  'executeCode',
  'executeCommand',
  'startCommand',
  'stopTask',
  'readFiles',
  'writeFiles',
  'listFiles',
] as const;
export type SandboxOp = (typeof SANDBOX_OPS)[number];

const MAX_BODY_BYTES = 8 << 20;

export interface SandboxReply {
  readonly status: number;
  readonly body: unknown;
}

/** One request in, one reply out; no I/O but the runner's. */
export function createSandboxHandler(
  runner: LocalCodeRunner,
  token: string,
  touch: () => void = () => undefined,
): (
  method: string,
  path: string,
  authorization: string | null,
  body: string,
) => Promise<SandboxReply> {
  const expected = Buffer.from(`Bearer ${token}`);
  return async (method, path, authorization, body) => {
    if (method === 'GET' && path === '/healthz') return { status: 200, body: { ok: true } };
    if (method !== 'POST' || path !== '/v1/run')
      return { status: 404, body: { error: 'not_found' } };
    const got = Buffer.from(authorization ?? '');
    if (got.length !== expected.length || !timingSafeEqual(got, expected)) {
      return { status: 401, body: { error: 'unauthenticated' } };
    }
    touch();
    let request: { op?: unknown; arg?: unknown };
    try {
      request = JSON.parse(body) as { op?: unknown; arg?: unknown };
    } catch {
      return { status: 400, body: { error: 'invalid_json' } };
    }
    const op = request.op;
    if (typeof op !== 'string' || !(SANDBOX_OPS as readonly string[]).includes(op)) {
      return { status: 400, body: { error: 'unknown_op' } };
    }
    try {
      const call = runner[op as SandboxOp] as (arg: unknown) => Promise<unknown>;
      const result = await call.call(runner, request.arg);
      return { status: 200, body: { ok: true, result: result ?? null } };
    } catch (err) {
      return {
        status: 200,
        body: { ok: false, error: err instanceof Error ? err.message : String(err) },
      };
    }
  };
}

export function main(env: NodeJS.ProcessEnv = process.env): void {
  const token = env.KAGENT_SANDBOX_TOKEN;
  if (token === undefined || token.length < 32) {
    console.error('[sandbox] KAGENT_SANDBOX_TOKEN missing or short; refusing to start');
    process.exit(2);
  }
  const port = Number.parseInt(env.KAGENT_SANDBOX_PORT ?? '8080', 10);
  const idleMs = Number.parseInt(env.KAGENT_SANDBOX_IDLE_SECONDS ?? '1800', 10) * 1000;
  // Agent code gets a minimal env: nothing of the pod's, least of all the token.
  const runner = new LocalCodeRunner({
    workspaceDir: env.KAGENT_SANDBOX_WORKSPACE ?? '/workspace',
    env: {
      HOME: '/workspace',
      TMPDIR: '/tmp',
      LANG: 'C.UTF-8',
      PATH: env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
    },
  });
  let last = Date.now();
  const handle = createSandboxHandler(runner, token, () => {
    last = Date.now();
  });
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) req.destroy();
      else chunks.push(chunk);
    });
    req.on('end', () => {
      void handle(
        req.method ?? 'GET',
        req.url ?? '/',
        req.headers.authorization ?? null,
        Buffer.concat(chunks).toString('utf8'),
      ).then((reply) => {
        const data = JSON.stringify(reply.body);
        res.writeHead(reply.status, {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(data),
        });
        res.end(data);
      });
    });
  });
  server.listen(port, () => console.log(`[sandbox] listening on :${String(port)}`));
  // Idle: exit 0 so the Job completes and its TTL removes it.
  setInterval(() => {
    if (Date.now() - last > idleMs) {
      console.log('[sandbox] idle; exiting');
      process.exit(0);
    }
  }, 30_000).unref();
}

if (process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`) main();
