/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/**
 * Who is calling. The gateway signs the calling task's identity onto
 * outbound calls (http providers with `identity`), and keys workspaces and
 * sessions by task, so the caller must prove which task it is. Headers and
 * body are the caller's own claims; the proof is the capability JWT the
 * operator minted for the task (`sub` = task uid, `agt` = the Agent),
 * verified against the operator's published keys.
 */

import {
  createLocalJWKSet,
  decodeCapabilityJwtUnsafe,
  verifyCapabilityJwt,
  type VerifierKey,
} from '@kagent/capability-types';

import type { ToolGatewayTaskIdentity } from './http-server.js';

export type CallerVerifier = (
  authorization: string | null,
  task: ToolGatewayTaskIdentity,
) => Promise<string | null>;

export interface CallerVerifierOptions {
  readonly jwksUrl: string;
  readonly issuer: string;
  readonly fetch?: typeof fetch;
  /** Milliseconds a fetched key set is trusted before it is fetched again. */
  readonly refreshMs?: number;
  readonly now?: () => number;
}

/** Returns null when the bearer token proves the task, else why not. */
export function createCallerVerifier(options: CallerVerifierOptions): CallerVerifier {
  const fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
  const refreshMs = options.refreshMs ?? 300_000;
  const clock = options.now ?? (() => Date.now());
  let keys: VerifierKey | undefined;
  let fetchedAt = 0;

  async function keySet(force: boolean): Promise<VerifierKey> {
    if (keys === undefined || force || clock() - fetchedAt > refreshMs) {
      const response = await fetchImpl(options.jwksUrl);
      if (!response.ok) throw new Error(`jwks ${String(response.status)}`);
      keys = { kind: 'jwks', jwks: createLocalJWKSet((await response.json()) as never) };
      fetchedAt = clock();
    }
    return keys;
  }

  return async (authorization, task) => {
    const match = /^Bearer\s+(\S+)$/.exec(authorization ?? '');
    if (match === null) return 'no capability token';
    const jwt = match[1] ?? '';
    // A Tenant mints under its own issuer (<operator issuer>/tenant/<name>, from
    // Tenant.spec.capabilityRoot.issuer); the operator's keys sign them all. Accept
    // the operator's issuer or one nested under it, and verify against that.
    const claimedIssuer = decodeCapabilityJwtUnsafe(jwt)?.iss ?? '';
    if (claimedIssuer !== options.issuer && !claimedIssuer.startsWith(`${options.issuer}/`)) {
      return `capability token issuer ${claimedIssuer || '(none)'} is not the operator's`;
    }
    let result;
    try {
      result = await verifyCapabilityJwt({
        jwt,
        keyOrJwks: await keySet(false),
        expectedIssuer: claimedIssuer,
      });
      // A key the cached set does not hold may be a rotation: fetch once more.
      if (!result.ok && /no applicable key|kid/i.test(result.error)) {
        result = await verifyCapabilityJwt({
          jwt,
          keyOrJwks: await keySet(true),
          expectedIssuer: claimedIssuer,
        });
      }
    } catch (err) {
      return `capability keys unavailable: ${err instanceof Error ? err.message : String(err)}`;
    }
    if (!result.ok) return result.error;
    if (result.bundle.sub !== `task-uid:${task.taskUid}`)
      return 'capability token is for another task';
    if (result.bundle.agt !== `${task.namespace}/${task.agentName}`) {
      return 'capability token is for another agent';
    }
    const tenant = result.bundle.claims.tenant;
    if (tenant !== undefined && tenant !== task.tenant) {
      return 'capability token is for another tenant';
    }
    return null;
  };
}
