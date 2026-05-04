/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/**
 * HMAC-signed webhook receiver — the on-demand half of Wave 0 entry
 * points. Per WAVES.md §2.6:
 *
 *   POST /webhook/<trigger-id>
 *   X-Kagent-Signature: <hex(hmac_sha256(secret, raw-body))>
 *   <body>           ← arbitrary JSON; merged into AgentTask.spec.payload
 *
 * Trust model (Wave 0):
 *   - The `<trigger-id>` is the metadata.name of a `KagentSchedule` OR
 *     a `WebhookTrigger` (we accept both for forward compatibility;
 *     v0.1.16 ships the schedule lookup, the webhook-only kind is
 *     reserved). The receiver looks up its template + secret by id.
 *   - Per-trigger HMAC secrets live in the operator's release-namespace
 *     `kagent-trigger-secrets` Secret, one key per trigger id.
 *   - On valid signature → the receiver renders an AgentTask whose
 *     payload is the union of the trigger's template payload and the
 *     POST body (POST body overrides at top level).
 *   - Authorization is uniform "shared cap with all rights" placeholder
 *     — Wave 2 caps add per-trigger scoping.
 *
 * Failure responses:
 *   - 400 missing-signature / malformed body / unknown trigger
 *   - 401 invalid-HMAC
 *   - 500 K8s create failure (logged; caller may retry)
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

import { SIGNATURE_HEADER, verifySignature } from './hmac.js';
import {
  renderAgentTaskFromTemplate,
  type AgentTaskTemplateSpec,
  type RenderedAgentTask,
} from './render-task.js';

/** Body cap for incoming POSTs; refuses anything larger. */
export const MAX_BODY_BYTES = 256 * 1024;

const ROUTE_RE = /^\/webhook\/([^/]+)\/?$/;

export interface WebhookTrigger {
  /** Stable id used as the URL slug AND the AgentTask name prefix. */
  readonly id: string;
  /** Namespace of the AgentTask the trigger mints. */
  readonly namespace: string;
  /** AgentTask body the receiver renders. */
  readonly taskTemplate: AgentTaskTemplateSpec;
  /** HMAC-SHA256 shared secret. */
  readonly secret: string;
}

export interface WebhookReceiverDeps {
  /** Look up a trigger by URL id. Returns undefined for 404. */
  readonly lookupTrigger: (
    id: string,
  ) => Promise<WebhookTrigger | undefined> | WebhookTrigger | undefined;
  /** Materialize the rendered AgentTask in K8s. */
  readonly createAgentTask: (manifest: RenderedAgentTask) => Promise<void> | void;
  /** Test-injectable clock. Production: `() => new Date()`. */
  readonly clock?: () => Date;
}

export interface WebhookReceiverResponse {
  readonly status: number;
  readonly body: Readonly<Record<string, unknown>>;
}

/**
 * Pure handler — drives both the bound HTTP server AND unit tests
 * (tests pass a synthetic body + signature without binding a port).
 *
 * Signature verification uses the raw bytes of the body; we MUST NOT
 * `JSON.parse` first because re-serialization is not byte-stable
 * across Node versions (object key order, whitespace, escape forms).
 */
export async function handleWebhookRequest(
  rawBody: Buffer,
  signatureHeader: string | undefined,
  triggerId: string,
  deps: WebhookReceiverDeps,
): Promise<WebhookReceiverResponse> {
  if (typeof triggerId !== 'string' || triggerId.length === 0) {
    return { status: 404, body: { code: 'not_found', message: 'unknown trigger id' } };
  }

  if (typeof signatureHeader !== 'string' || signatureHeader.length === 0) {
    return {
      status: 400,
      body: {
        code: 'missing_signature',
        message: `${SIGNATURE_HEADER} header required`,
      },
    };
  }

  const trigger = await deps.lookupTrigger(triggerId);
  if (trigger === undefined) {
    return {
      status: 404,
      body: { code: 'trigger_not_found', message: `trigger '${triggerId}' is unknown` },
    };
  }

  if (!verifySignature(trigger.secret, rawBody, signatureHeader)) {
    return {
      status: 401,
      body: { code: 'invalid_signature', message: 'HMAC signature did not match' },
    };
  }

  let payloadOverride: unknown;
  if (rawBody.byteLength > 0) {
    try {
      const parsed: unknown = JSON.parse(rawBody.toString('utf8'));
      payloadOverride = parsed;
    } catch (err) {
      return {
        status: 400,
        body: {
          code: 'bad_json',
          message: err instanceof Error ? err.message : String(err),
        },
      };
    }
  }

  const now = (deps.clock ?? ((): Date => new Date()))();

  let manifest: RenderedAgentTask;
  try {
    manifest = renderAgentTaskFromTemplate({
      triggerName: trigger.id,
      triggerKind: 'webhook',
      namespace: trigger.namespace,
      taskTemplate: trigger.taskTemplate,
      now,
      ...(payloadOverride !== undefined && { payloadOverride }),
    });
  } catch (err) {
    return {
      status: 400,
      body: { code: 'render_failed', message: err instanceof Error ? err.message : String(err) },
    };
  }

  try {
    await deps.createAgentTask(manifest);
  } catch (err) {
    return {
      status: 500,
      body: { code: 'k8s_error', message: err instanceof Error ? err.message : String(err) },
    };
  }

  return {
    status: 202,
    body: {
      taskName: manifest.metadata.name,
      namespace: manifest.metadata.namespace,
      triggeredAt: manifest.metadata.annotations['kagent.knuteson.io/triggered-at'],
    },
  };
}

/**
 * Bind the receiver to a TCP port. Returns a control object whose
 * `close()` resolves when all in-flight connections drain.
 */
export function startWebhookReceiver(
  port: number,
  deps: WebhookReceiverDeps,
): { readonly server: Server; close(): Promise<void> } {
  const server = createServer((req, res) => {
    void handleNodeRequest(req, res, deps);
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

async function handleNodeRequest(
  req: IncomingMessage,
  res: ServerResponse,
  deps: WebhookReceiverDeps,
): Promise<void> {
  if (req.method === 'GET' && req.url === '/healthz') {
    writeJson(res, 200, { status: 'ok' });
    return;
  }
  if (req.method !== 'POST') {
    writeJson(res, 405, { code: 'method_not_allowed', message: 'method must be POST' });
    return;
  }
  const url = req.url ?? '';
  const match = url.match(ROUTE_RE);
  if (match === null) {
    writeJson(res, 404, { code: 'not_found', message: 'unknown route' });
    return;
  }
  const triggerId = decodeURIComponent(match[1] ?? '');
  let body: Buffer;
  try {
    body = await readBoundedBody(req);
  } catch (err) {
    writeJson(res, 413, {
      code: 'payload_too_large',
      message: err instanceof Error ? err.message : String(err),
    });
    return;
  }
  // Header names are lowercase on IncomingMessage.headers per Node spec.
  const sigHeader = req.headers[SIGNATURE_HEADER];
  const signatureValue = Array.isArray(sigHeader) ? sigHeader[0] : sigHeader;
  let outcome: WebhookReceiverResponse;
  try {
    outcome = await handleWebhookRequest(body, signatureValue, triggerId, deps);
  } catch (err) {
    writeJson(res, 500, {
      code: 'internal_error',
      message: err instanceof Error ? err.message : String(err),
    });
    return;
  }
  writeJson(res, outcome.status, outcome.body);
}

function readBoundedBody(req: IncomingMessage): Promise<Buffer> {
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
      resolve(Buffer.concat(chunks));
    });
    req.on('error', (err) => reject(err));
  });
}

function writeJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload, 'utf8').toString(),
  });
  res.end(payload);
}
