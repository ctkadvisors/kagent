/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

import { generateKeyPairSync } from 'node:crypto';

import { buildCapabilityJwt, exportJWK } from '@kagent/capability-types';
import { describe, expect, it } from 'vitest';

import { createCallerVerifier } from './caller-verifier.js';
import { ToolGatewayHttpHandler } from './http-server.js';

const ISSUER = 'kagent.knuteson.io/operator';
const task = {
  tenant: 'default',
  namespace: 'kagent-system',
  taskUid: 'uid-1',
  agentName: 'fleet-disposer',
};

async function setup() {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwk = { ...(await exportJWK(publicKey)), kid: 'k1', alg: 'ES256', use: 'sig' };
  const fetchJwks = (() =>
    Promise.resolve(new Response(JSON.stringify({ keys: [jwk] })))) as typeof fetch;
  const mint = (sub: string, agt: string) =>
    buildCapabilityJwt({
      issuer: ISSUER,
      subjectTaskUid: sub,
      subjectAgent: agt,
      jti: 'cap-1',
      claims: {},
    })
      .setProtectedHeader({ alg: 'ES256', kid: 'k1' })
      .sign(privateKey);
  const verify = createCallerVerifier({
    jwksUrl: 'http://op/jwks',
    issuer: ISSUER,
    fetch: fetchJwks,
  });
  return { mint, verify };
}

describe('createCallerVerifier', () => {
  it('accepts the task and agent the operator signed, and nothing else', async () => {
    const { mint, verify } = await setup();
    expect(
      await verify(`Bearer ${await mint('uid-1', 'kagent-system/fleet-disposer')}`, task),
    ).toBeNull();
    expect(await verify(null, task)).toBe('no capability token');
    expect(
      await verify(`Bearer ${await mint('uid-2', 'kagent-system/fleet-disposer')}`, task),
    ).toBe('capability token is for another task');
    expect(
      await verify(`Bearer ${await mint('uid-1', 'kagent-system/fleet-inventor')}`, task),
    ).toBe('capability token is for another agent');
  });

  it('refuses a token signed by any other key', async () => {
    const { verify } = await setup();
    const other = await setup();
    const forged = await other.mint('uid-1', 'kagent-system/fleet-disposer');
    expect(await verify(`Bearer ${forged}`, task)).not.toBeNull();
  });
});

describe('ToolGatewayHttpHandler with verifyCaller', () => {
  it('answers 401 to a call that names a task without proving it', async () => {
    const { verify } = await setup();
    const handler = new ToolGatewayHttpHandler({ verifyCaller: verify });
    const response = await handler.handle(
      new Request('http://gw/v1/tool-runtime/invoke', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-kagent-agent': task.agentName,
          'x-kagent-namespace': task.namespace,
          'x-kagent-task-uid': task.taskUid,
          'x-kagent-tenant': task.tenant,
        },
        body: JSON.stringify({ task, call: { id: 'c1', name: 'fleet.forum_post', args: {} } }),
      }),
    );
    expect(response.status).toBe(401);
  });
});
