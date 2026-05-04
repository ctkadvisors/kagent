/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/**
 * Node http server. Routes:
 *
 *   POST /v1/chat/completions   — auth → router.route → JSON
 *   GET  /v1/models             — read-only list off the ModelIndex
 *   GET  /admin/capacity        — admin auth → AIMD + in-flight snapshot
 *   GET  /admin/usage[?...]     — admin auth → usage_records query
 *   GET  /healthz               — always 200 (process is up)
 *   GET  /readyz                — 200 only when DB pings clean
 *
 * Style mirrors `packages/operator/src/template-server.ts`: no
 * Express, just `createServer` + a request handler. Body-parse cap
 * is the same 64 KB bound (kagent prompts are large but bounded;
 * anything bigger looks like abuse). SSE streaming is structured to
 * land here in v0.2 — non-streaming responses are the v1 wire.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

import {
  adminAuth,
  buildCapacityResponse,
  buildUsageResponse,
  handleCreateApiKey,
  handleListApiKeys,
  handleRevokeApiKey,
  parseCreateApiKeyBody,
  parseRevokeIdFromUrl,
} from './admin-routes.js';
import { authenticate, type ApiKeyLookup } from './auth.js';
import { parseKagentHeaders } from './headers.js';
import type { AimdController } from './aimd.js';
import type { InFlightCounter } from './inflight-counter.js';
import type { ModelIndex } from './model-index.js';
import type { ApiKeyRepo } from './db/api-keys.js';
import type { UsageRepo } from './db/usage.js';
import { route, type RouterDeps } from './router.js';
import { createOpenAIError, type ChatCompletionRequest, type ModelListResponse } from './types.js';

const MAX_BODY_BYTES = 64 * 1024;

export interface ServerDeps {
  readonly modelIndex: ModelIndex;
  readonly inFlight: InFlightCounter;
  readonly aimd: AimdController;
  readonly routerDeps: RouterDeps;
  readonly apiKeyLookup: ApiKeyLookup;
  /**
   * v0.1.12 — full repo handle for the /admin/keys REST surface.
   * `apiKeyLookup` above is the bearer-token auth path (one method,
   * `getByHash`); this is the admin-side write surface (`list`,
   * `insertAndReturn`, `revoke`). Kept as a separate dep so a deploy
   * can wire the read-only auth path without bringing in the admin
   * surface (e.g. a reader-only sidecar).
   */
  readonly apiKeyRepo: ApiKeyRepo;
  readonly usageRepo: UsageRepo;
  readonly adminToken: string;
  readonly readinessProbe: () => Promise<boolean>;
}

export function buildHandler(
  deps: ServerDeps,
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  return async function handle(req, res): Promise<void> {
    const url = req.url ?? '';
    const method = req.method ?? 'GET';

    // Liveness — always 200.
    if (method === 'GET' && url === '/healthz') {
      writeJson(res, 200, { status: 'ok' });
      return;
    }

    // Readiness — gated on DB reachability.
    if (method === 'GET' && url === '/readyz') {
      const ready = await deps.readinessProbe();
      writeJson(res, ready ? 200 : 503, { status: ready ? 'ready' : 'not_ready' });
      return;
    }

    if (method === 'GET' && url === '/v1/models') {
      const body: ModelListResponse = {
        object: 'list',
        data: deps.modelIndex.list().map((ep) => ({
          id: ep.spec.model,
          object: 'model' as const,
          created: 0,
          owned_by: ep.spec.backendKind,
        })),
      };
      writeJson(res, 200, body);
      return;
    }

    // ----- Admin endpoints -----
    if (method === 'GET' && url.startsWith('/admin/capacity')) {
      const auth = adminAuth(req, deps.adminToken);
      if (!auth.ok) {
        writeJson(res, auth.statusCode ?? 401, {
          error: { message: auth.message ?? 'unauthorized' },
        });
        return;
      }
      writeJson(res, 200, buildCapacityResponse(deps.modelIndex, deps.inFlight, deps.aimd));
      return;
    }

    if (method === 'GET' && url.startsWith('/admin/usage')) {
      const auth = adminAuth(req, deps.adminToken);
      if (!auth.ok) {
        writeJson(res, auth.statusCode ?? 401, {
          error: { message: auth.message ?? 'unauthorized' },
        });
        return;
      }
      try {
        const body = await buildUsageResponse(url, deps.usageRepo);
        writeJson(res, 200, body);
      } catch (err) {
        writeJson(res, 500, {
          error: { message: err instanceof Error ? err.message : String(err) },
        });
      }
      return;
    }

    // v0.1.12 — POST /admin/keys: mint a fresh sk-<random> key.
    // Returns the plaintext exactly once + the stored hash + assigned id.
    if (method === 'POST' && url === '/admin/keys') {
      const auth = adminAuth(req, deps.adminToken);
      if (!auth.ok) {
        writeJson(res, auth.statusCode ?? 401, {
          error: { message: auth.message ?? 'unauthorized' },
        });
        return;
      }
      let raw: unknown;
      try {
        raw = await readJsonBody(req);
      } catch (err) {
        writeJson(res, 400, {
          error: { message: err instanceof Error ? err.message : String(err) },
        });
        return;
      }
      let body;
      try {
        body = parseCreateApiKeyBody(raw);
      } catch (err) {
        writeJson(res, 400, {
          error: { message: err instanceof Error ? err.message : String(err) },
        });
        return;
      }
      try {
        const created = await handleCreateApiKey(body, deps.apiKeyRepo);
        writeJson(res, 200, created);
      } catch (err) {
        writeJson(res, 500, {
          error: { message: err instanceof Error ? err.message : String(err) },
        });
      }
      return;
    }

    // v0.1.12 — GET /admin/keys: list every key in admin-projection
    // shape (no plaintext, no key_hash; only the hash prefix is shown).
    if (
      method === 'GET' &&
      url.startsWith('/admin/keys') &&
      parseRevokeIdFromUrl(url) === undefined
    ) {
      const auth = adminAuth(req, deps.adminToken);
      if (!auth.ok) {
        writeJson(res, auth.statusCode ?? 401, {
          error: { message: auth.message ?? 'unauthorized' },
        });
        return;
      }
      try {
        const body = await handleListApiKeys(deps.apiKeyRepo);
        writeJson(res, 200, body);
      } catch (err) {
        writeJson(res, 500, {
          error: { message: err instanceof Error ? err.message : String(err) },
        });
      }
      return;
    }

    // v0.1.12 — DELETE /admin/keys/:id: soft-delete via UPDATE
    // status='revoked' + revoked_at=NOW(). 404 when no row matches.
    if (method === 'DELETE' && url.startsWith('/admin/keys/')) {
      const auth = adminAuth(req, deps.adminToken);
      if (!auth.ok) {
        writeJson(res, auth.statusCode ?? 401, {
          error: { message: auth.message ?? 'unauthorized' },
        });
        return;
      }
      const id = parseRevokeIdFromUrl(url);
      if (id === undefined) {
        writeJson(res, 400, { error: { message: 'expected /admin/keys/:id' } });
        return;
      }
      try {
        const result = await handleRevokeApiKey(id, deps.apiKeyRepo);
        if (!result.revoked) {
          writeJson(res, 404, { error: { message: `api key id=${id} not found` } });
          return;
        }
        writeJson(res, 200, result);
      } catch (err) {
        writeJson(res, 500, {
          error: { message: err instanceof Error ? err.message : String(err) },
        });
      }
      return;
    }

    // ----- /v1/chat/completions -----
    if (method === 'POST' && url === '/v1/chat/completions') {
      const auth = await authenticate(req, deps.apiKeyLookup);
      if (!auth.ok) {
        writeJson(res, auth.statusCode, createOpenAIError(auth.message, 'authentication_error'));
        return;
      }
      let body: ChatCompletionRequest;
      try {
        body = (await readJsonBody(req)) as ChatCompletionRequest;
      } catch (err) {
        writeJson(
          res,
          400,
          createOpenAIError(
            err instanceof Error ? err.message : String(err),
            'invalid_request_error',
          ),
        );
        return;
      }
      if (
        typeof body !== 'object' ||
        body === null ||
        typeof body.model !== 'string' ||
        !Array.isArray(body.messages)
      ) {
        writeJson(
          res,
          400,
          createOpenAIError('request must include model + messages', 'invalid_request_error'),
        );
        return;
      }
      if (body.stream === true) {
        // SSE streaming is deferred to v0.2; reject explicitly so the
        // caller doesn't silently get a non-streaming response.
        writeJson(
          res,
          400,
          createOpenAIError(
            'streaming responses are not yet supported (v1)',
            'invalid_request_error',
          ),
        );
        return;
      }
      const headers = parseKagentHeaders(req);
      const requestId = `req-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
      const result = await route(deps.routerDeps, {
        requestId,
        request: body,
        apiKeyPrefix: auth.keyPrefix,
        taskUid: headers.taskUid,
        agentName: headers.agentName,
      });

      switch (result.kind) {
        case 'dispatched':
          writeJson(res, 200, result.body);
          return;
        case 'at_cap':
          res.setHeader('Retry-After', String(result.retryAfterSec));
          writeJson(
            res,
            429,
            createOpenAIError(
              `model ${result.model} at capacity (in-flight=${String(result.inFlight)} cap=${String(result.currentCap)})`,
              'rate_limit_error',
            ),
          );
          return;
        case 'unknown_model':
          writeJson(
            res,
            400,
            createOpenAIError(
              `unknown model: ${result.model} — no ModelEndpoint registered`,
              'invalid_request_error',
            ),
          );
          return;
        case 'dispatch_error':
          writeJson(
            res,
            502,
            createOpenAIError(
              `backend error for ${result.model}: ${result.message}`,
              'server_error',
            ),
          );
          return;
        default: {
          const _exhaustive: never = result;
          writeJson(res, 500, {
            error: { message: `unhandled router result: ${String(_exhaustive)}` },
          });
          return;
        }
      }
    }

    writeJson(res, 404, { error: { message: 'not found' } });
  };
}

export interface StartedServer {
  readonly server: Server;
  close(): Promise<void>;
}

export function startServer(port: number, deps: ServerDeps): StartedServer {
  const handler = buildHandler(deps);
  const server = createServer((req, res) => {
    void handler(req, res).catch((err: unknown) => {
      console.error('[llm-gateway] handler threw:', err);
      try {
        writeJson(res, 500, {
          error: { message: err instanceof Error ? err.message : String(err) },
        });
      } catch {
        /* response already partly sent */
      }
    });
  });
  server.listen(port);
  return {
    server,
    close(): Promise<void> {
      return new Promise((resolve, reject) => {
        server.close((err) => {
          if (err) reject(err);
          else resolve();
        });
      });
    },
  };
}

/* --------------------------------------------------------------------- */

function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let total = 0;
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => {
      total += chunk.byteLength;
      if (total > MAX_BODY_BYTES) {
        reject(new Error(`request body exceeds ${String(MAX_BODY_BYTES)} bytes`));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (total === 0) {
        reject(new Error('request body is empty'));
        return;
      }
      try {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve(JSON.parse(text));
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
    req.on('error', (err) => reject(err));
  });
}

function writeJson(res: ServerResponse, status: number, body: unknown): void {
  if (res.headersSent) return;
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload, 'utf8').toString(),
  });
  res.end(payload);
}
