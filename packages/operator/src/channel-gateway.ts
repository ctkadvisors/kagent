/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

import type { ChannelInboundEnvelope, ChannelPeerKind } from './crds/index.js';
import {
  reconcileChannelInbound,
  type ChannelControllerResult,
  type ChannelControllerStore,
} from './channel-controller.js';

const DEFAULT_MAX_BODY_BYTES = 64 * 1024;

export interface ChannelGatewayDeps {
  readonly namespace: string;
  readonly store: ChannelControllerStore;
  readonly clock?: () => Date;
  readonly maxBodyBytes?: number;
  readonly authenticate?: (req: IncomingMessage) => boolean | Promise<boolean>;
}

export type ChannelGatewayHandler = (req: IncomingMessage, res: ServerResponse) => Promise<void>;

export function buildChannelGatewayHandler(deps: ChannelGatewayDeps): ChannelGatewayHandler {
  return async (req, res): Promise<void> => {
    const channelName = parseInboundRoute(req);
    if (channelName === undefined) {
      writeJson(res, 404, { code: 'not_found' });
      return;
    }
    if (req.method !== 'POST') {
      writeJson(res, 405, { code: 'method_not_allowed' });
      return;
    }

    if (deps.authenticate !== undefined && !(await deps.authenticate(req))) {
      writeJson(res, 401, { code: 'unauthorized' });
      return;
    }

    let body: unknown;
    try {
      body = await readJsonBody(req, deps.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES);
    } catch (err) {
      writeJson(res, 400, {
        code: 'invalid_json',
        message: err instanceof Error ? err.message : String(err),
      });
      return;
    }

    const inbound = parseInboundEnvelope(channelName, body);
    if (inbound === undefined) {
      writeJson(res, 400, { code: 'invalid_channel_envelope' });
      return;
    }

    try {
      const result = await reconcileChannelInbound({
        namespace: deps.namespace,
        inbound,
        store: deps.store,
        ...(deps.clock !== undefined && { clock: deps.clock }),
      });
      writeGatewayResult(res, inbound.channelName, result);
    } catch (err) {
      writeJson(res, 500, {
        code: 'internal_error',
        message: err instanceof Error ? err.message : String(err),
      });
    }
  };
}

export function startChannelGatewayServer(
  port: number,
  deps: ChannelGatewayDeps,
): Promise<{ readonly server: Server; close(): Promise<void> } | undefined> {
  const handler = buildChannelGatewayHandler(deps);
  const server = createServer((req, res) => {
    void handler(req, res).catch((err: unknown) => {
      console.error('[channel-gateway] handler threw:', err);
      try {
        writeJson(res, 500, {
          code: 'internal_error',
          message: err instanceof Error ? err.message : String(err),
        });
      } catch {
        /* response already sent */
      }
    });
  });
  return new Promise((resolve) => {
    server.once('error', (err: NodeJS.ErrnoException) => {
      console.warn(
        `[channel-gateway] bind failed (port=${port.toString()}): ${err.message}; channel ingress disabled`,
      );
      resolve(undefined);
    });
    server.listen(port, () => {
      resolve({
        server,
        close(): Promise<void> {
          return new Promise((closeResolve, reject) => {
            server.close((err) => {
              if (err) reject(err);
              else closeResolve();
            });
          });
        },
      });
    });
  });
}

function writeGatewayResult(
  res: ServerResponse,
  channelName: string,
  result: ChannelControllerResult,
): void {
  if (result.action === 'created' || result.action === 'duplicate') {
    writeJson(res, result.action === 'created' ? 202 : 200, {
      action: result.action,
      channel: channelName,
      session: {
        namespace: result.session.metadata.namespace,
        name: result.session.metadata.name,
      },
      task: {
        namespace: result.task.metadata.namespace,
        name: result.task.metadata.name,
        ...(result.task.metadata.uid !== undefined && { uid: result.task.metadata.uid }),
      },
    });
    return;
  }
  if (result.action === 'approval_required') {
    writeJson(res, 202, result);
    return;
  }
  writeJson(res, statusForDenial(result.reason), result);
}

function statusForDenial(
  reason: Extract<ChannelControllerResult, { readonly action: 'denied' }>['reason'],
): number {
  if (reason === 'channel_not_found' || reason === 'no_route') return 404;
  if (reason === 'session_backoff') return 429;
  if (reason === 'channel_mismatch' || reason === 'session_paused') return 409;
  return 403;
}

function parseInboundRoute(req: IncomingMessage): string | undefined {
  const rawUrl = req.url;
  if (typeof rawUrl !== 'string') return undefined;
  const path = new URL(rawUrl, 'http://kagent.local').pathname;
  const match = /^\/channels\/([^/]+)\/inbound$/.exec(path);
  if (match?.[1] === undefined) return undefined;
  return decodeURIComponent(match[1]);
}

function parseInboundEnvelope(
  channelName: string,
  body: unknown,
): ChannelInboundEnvelope | undefined {
  if (typeof body !== 'object' || body === null) return undefined;
  const b = body as {
    channelName?: unknown;
    provider?: unknown;
    accountId?: unknown;
    peer?: unknown;
    threadId?: unknown;
    sender?: unknown;
    messageId?: unknown;
    text?: unknown;
  };
  if (b.channelName !== undefined && b.channelName !== channelName) return undefined;
  if (!isNonEmptyString(b.provider)) return undefined;
  if (!isNonEmptyString(b.accountId)) return undefined;
  if (!isPeer(b.peer)) return undefined;
  if (b.threadId !== undefined && !isNonEmptyString(b.threadId)) return undefined;
  if (!isNonEmptyString(b.messageId)) return undefined;
  if (!isNonEmptyString(b.text)) return undefined;

  const envelope: ChannelInboundEnvelope = {
    channelName,
    provider: b.provider,
    accountId: b.accountId,
    peer: b.peer,
    ...(b.threadId !== undefined && { threadId: b.threadId }),
    ...(isSender(b.sender) && { sender: b.sender }),
    messageId: b.messageId,
    text: b.text,
  };
  return envelope;
}

function readJsonBody(req: IncomingMessage, maxBodyBytes: number): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let total = 0;
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => {
      total += chunk.byteLength;
      if (total > maxBodyBytes) {
        reject(new Error(`request body exceeds ${String(maxBodyBytes)} bytes`));
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
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
    req.on('error', reject);
  });
}

function writeJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(body));
}

function isSender(value: unknown): value is { readonly id: string; readonly displayName?: string } {
  if (value === undefined) return false;
  if (typeof value !== 'object' || value === null) return false;
  const s = value as { id?: unknown; displayName?: unknown };
  return isNonEmptyString(s.id) && (s.displayName === undefined || isNonEmptyString(s.displayName));
}

function isPeer(value: unknown): value is { readonly kind: ChannelPeerKind; readonly id: string } {
  if (typeof value !== 'object' || value === null) return false;
  const p = value as { kind?: unknown; id?: unknown };
  return isPeerKind(p.kind) && isNonEmptyString(p.id);
}

function isPeerKind(value: unknown): value is ChannelPeerKind {
  return value === 'dm' || value === 'group' || value === 'channel' || value === 'room';
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}
