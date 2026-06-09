/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/**
 * v0.1.12-keys-rest — HTTP-level tests for the /admin/keys routes
 * registered in server.ts. We boot the buildHandler() against
 * stub deps + a live Node http.Server on an OS-assigned port, then
 * issue real HTTP requests via fetch() so the wire format is what
 * gets asserted (status codes, headers, JSON bodies).
 *
 * The non-keys routes (/v1/*, /admin/capacity, /admin/usage,
 * /healthz, /readyz) already have unit-level coverage in their
 * own files; this file exists to lock the v0.1.12 routes' wire
 * contract.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { buildHandler, maybeEmitIdentityHeader, type ServerDeps } from './server.js';
import { hashApiKey } from './auth.js';
import { AimdController } from './aimd.js';
import { InFlightCounter } from './inflight-counter.js';
import { ModelIndex } from './model-index.js';
import type { ApiKeyAdminRow, ApiKeyRepo, InsertApiKeyInput, RevokeResult } from './db/api-keys.js';
import type { RouterDeps } from './router.js';
import type { UsageQueryFilter, UsageQueryRow, UsageRepo } from './db/usage.js';

const ADMIN_TOKEN = 'admin-test-token-1234567890';

class StubApiKeyRepo implements ApiKeyRepo {
  rowsToReturn: ApiKeyAdminRow[] = [];
  inserted: InsertApiKeyInput[] = [];
  revokedId: string | undefined;
  revokeMatches = true;
  insertId = '17';
  /** H18 — capture every keyHash passed to touchLastUsed for assertions. */
  touchedKeyHashes: string[] = [];

  async getByHash(): Promise<null> {
    return Promise.resolve(null);
  }
  async touchLastUsed(keyHash: string): Promise<void> {
    this.touchedKeyHashes.push(keyHash);
    return Promise.resolve();
  }
  async insert(input: InsertApiKeyInput): Promise<void> {
    this.inserted.push(input);
    return Promise.resolve();
  }
  async insertAndReturn(input: InsertApiKeyInput): Promise<{ readonly id: string }> {
    this.inserted.push(input);
    return Promise.resolve({ id: this.insertId });
  }
  async list(): Promise<readonly ApiKeyAdminRow[]> {
    return Promise.resolve(this.rowsToReturn);
  }
  async revoke(id: string): Promise<RevokeResult> {
    this.revokedId = id;
    return Promise.resolve({ revoked: this.revokeMatches });
  }
}

class StubUsageRepo implements UsageRepo {
  async record(): Promise<void> {
    return Promise.resolve();
  }
  // eslint-disable-next-line @typescript-eslint/require-await
  async query(_filter: UsageQueryFilter): Promise<readonly UsageQueryRow[]> {
    return [];
  }
}

interface BootedServer {
  readonly url: string;
  readonly server: Server;
  readonly repo: StubApiKeyRepo;
  close(): Promise<void>;
}

interface ProviderDispatchControl {
  readonly isDisabled: () => boolean;
  readonly setDisabled: (disabled: boolean) => void;
}

type TestServerDeps = ServerDeps & {
  readonly providerDispatchControl?: ProviderDispatchControl;
};

function bootServer(
  overrides: Partial<
    Pick<
      TestServerDeps,
      | 'apiKeyLookup'
      | 'modelIndex'
      | 'routerDeps'
      | 'adminReadToken'
      | 'readinessProbe'
      | 'providerDispatchControl'
    >
  > = {},
): Promise<BootedServer> {
  return new Promise((resolve, reject) => {
    const repo = new StubApiKeyRepo();
    const deps: TestServerDeps = {
      modelIndex: overrides.modelIndex ?? new ModelIndex(),
      inFlight: new InFlightCounter(),
      aimd: new AimdController({ seed: 1, max: 4, minSafe: 1 }),
      routerDeps: overrides.routerDeps ?? ({} as unknown as RouterDeps),
      apiKeyLookup: overrides.apiKeyLookup ?? (() => Promise.resolve(null)),
      apiKeyRepo: repo,
      usageRepo: new StubUsageRepo(),
      adminToken: ADMIN_TOKEN,
      ...(overrides.adminReadToken !== undefined && { adminReadToken: overrides.adminReadToken }),
      ...(overrides.providerDispatchControl !== undefined && {
        providerDispatchControl: overrides.providerDispatchControl,
      }),
      readinessProbe: overrides.readinessProbe ?? (() => Promise.resolve(true)),
    };
    const handler = buildHandler(deps);
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      void handler(req, res).catch((err: unknown) => {
        console.error('[test handler] threw:', err);
        if (!res.headersSent) res.writeHead(500).end();
      });
    });
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${addr.port}`,
        server,
        repo,
        close: () => new Promise<void>((r, j) => server.close((e) => (e ? j(e) : r()))),
      });
    });
    server.on('error', reject);
  });
}

describe('GET /readyz', () => {
  it('returns 503 when the readiness probe reports not ready', async () => {
    const booted = await bootServer({
      readinessProbe: () => Promise.resolve(false),
    });
    try {
      const res = await fetch(`${booted.url}/readyz`);

      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ status: 'not_ready' });
    } finally {
      await booted.close();
    }
  });
});

describe('runtime provider dispatch control', () => {
  it('returns current dispatch-disabled state from GET /admin/provider-dispatch', async () => {
    const control: ProviderDispatchControl = {
      isDisabled: () => true,
      setDisabled: () => undefined,
    };
    const booted = await bootServer({ providerDispatchControl: control });
    try {
      const res = await fetch(`${booted.url}/admin/provider-dispatch`, {
        headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
      });

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ providerDispatchDisabled: true });
    } finally {
      await booted.close();
    }
  });

  it('PATCH /admin/provider-dispatch flips the in-memory kill switch', async () => {
    let disabled = false;
    const control: ProviderDispatchControl = {
      isDisabled: () => disabled,
      setDisabled: (next) => {
        disabled = next;
      },
    };
    const booted = await bootServer({ providerDispatchControl: control });
    try {
      const res = await fetch(`${booted.url}/admin/provider-dispatch`, {
        method: 'PATCH',
        headers: {
          authorization: `Bearer ${ADMIN_TOKEN}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ disabled: true }),
      });

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ providerDispatchDisabled: true });
      expect(disabled).toBe(true);
    } finally {
      await booted.close();
    }
  });

  it('rejects the read-only admin token on PATCH /admin/provider-dispatch', async () => {
    let disabled = false;
    const control: ProviderDispatchControl = {
      isDisabled: () => disabled,
      setDisabled: (next) => {
        disabled = next;
      },
    };
    const booted = await bootServer({
      adminReadToken: READ_TOKEN,
      providerDispatchControl: control,
    });
    try {
      const res = await fetch(`${booted.url}/admin/provider-dispatch`, {
        method: 'PATCH',
        headers: {
          authorization: `Bearer ${READ_TOKEN}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ disabled: true }),
      });

      expect(res.status).toBe(403);
      expect(disabled).toBe(false);
    } finally {
      await booted.close();
    }
  });
});

describe('POST /admin/keys', () => {
  let booted: BootedServer;
  beforeEach(async () => {
    booted = await bootServer();
  });
  afterEach(async () => {
    await booted.close();
  });

  it('rejects without admin auth (401)', async () => {
    const res = await fetch(`${booted.url}/admin/keys`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ label: 'cli' }),
    });
    expect(res.status).toBe(401);
  });

  it('rejects with the wrong admin token (403)', async () => {
    const res = await fetch(`${booted.url}/admin/keys`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer wrongtoken-${'x'.repeat(ADMIN_TOKEN.length - 11)}`,
      },
      body: JSON.stringify({ label: 'cli' }),
    });
    expect(res.status).toBe(403);
  });

  it('returns 200 + plaintext + id + hash on a valid request', async () => {
    const res = await fetch(`${booted.url}/admin/keys`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${ADMIN_TOKEN}`,
      },
      body: JSON.stringify({
        label: 'cli',
        modelAllowlist: ['gpt-4o'],
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      id: string;
      label: string;
      key: string;
      hash: string;
      hashPrefix: string;
      modelAllowlist?: string[];
    };
    expect(body.id).toBe(booted.repo.insertId);
    expect(body.label).toBe('cli');
    expect(body.key).toMatch(/^sk-[A-Za-z0-9_-]+$/);
    expect(body.hash).toBe(hashApiKey(body.key));
    expect(body.hashPrefix).toBe(body.key.slice(0, 8));
    expect(body.modelAllowlist).toEqual(['gpt-4o']);
    // Repo got the same hash + name we returned.
    const persisted = booted.repo.inserted[0];
    expect(persisted?.keyHash).toBe(body.hash);
    expect(persisted?.name).toBe('cli');
    expect(persisted?.modelAllowlist).toEqual(['gpt-4o']);
  });

  it('returns 400 on a malformed body (missing label)', async () => {
    const res = await fetch(`${booted.url}/admin/keys`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${ADMIN_TOKEN}`,
      },
      body: JSON.stringify({ modelAllowlist: ['gpt-4o'] }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: { message?: string } };
    expect(body.error?.message ?? '').toMatch(/label/);
  });
});

describe('POST /v1/chat/completions safety responses', () => {
  it('emits Retry-After on provider dispatch disabled responses', async () => {
    const key = 'sk-test-live-key';
    const modelIndex = new ModelIndex();
    modelIndex.upsert({
      apiVersion: 'kagent.knuteson.io/v1alpha1',
      kind: 'ModelEndpoint',
      metadata: { name: 'm', namespace: 'kagent-system' },
      spec: {
        model: 'm',
        backendKind: 'mock',
        backendUrl: 'http://mock',
        inFlight: { seed: 1, max: 1 },
      },
    });
    const booted = await bootServer({
      apiKeyLookup: () =>
        Promise.resolve({
          keyHash: hashApiKey(key),
          keyPrefix: 'sk-test',
          status: 'active',
          expiresAt: null,
        }),
      routerDeps: {
        modelIndex,
        inFlight: new InFlightCounter(),
        aimd: new AimdController({ seed: 1, max: 1, minSafe: 1 }),
        usage: new StubUsageRepo(),
        providerDispatchDisabled: true,
      } as unknown as RouterDeps,
    });
    try {
      const res = await fetch(`${booted.url}/v1/chat/completions`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${key}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model: 'm',
          messages: [{ role: 'user', content: 'hi' }],
        }),
      });

      expect(res.status).toBe(503);
      expect(res.headers.get('retry-after')).toBe('5');
    } finally {
      await booted.close();
    }
  });
});

describe('GET /admin/keys', () => {
  let booted: BootedServer;
  beforeEach(async () => {
    booted = await bootServer();
  });
  afterEach(async () => {
    await booted.close();
  });

  it('returns the admin-projection rows wrapped in {rows} (no plaintext)', async () => {
    booted.repo.rowsToReturn = [
      {
        id: '1',
        label: 'cli',
        hashPrefix: 'sk-abc12',
        status: 'active',
        modelAllowlist: ['gpt-4o'],
        expiresAt: null,
        revokedAt: null,
        createdAt: '2026-01-01T00:00:00.000Z',
      },
    ];
    const res = await fetch(`${booted.url}/admin/keys`, {
      headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
    });
    expect(res.status).toBe(200);
    const text = await res.text();
    // Belt + suspenders: nothing resembling a plaintext key body.
    expect(text).not.toMatch(/sk-[A-Za-z0-9_-]{16,}/);
    const body = JSON.parse(text) as { rows: ApiKeyAdminRow[] };
    expect(body.rows).toHaveLength(1);
    expect(body.rows[0]?.label).toBe('cli');
    expect(body.rows[0]?.hashPrefix).toBe('sk-abc12');
  });

  it('rejects without admin auth (401)', async () => {
    const res = await fetch(`${booted.url}/admin/keys`);
    expect(res.status).toBe(401);
  });
});

describe('DELETE /admin/keys/:id', () => {
  let booted: BootedServer;
  beforeEach(async () => {
    booted = await bootServer();
  });
  afterEach(async () => {
    await booted.close();
  });

  it('returns 200 + {revoked: true} when the id matches', async () => {
    booted.repo.revokeMatches = true;
    const res = await fetch(`${booted.url}/admin/keys/42`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
    });
    expect(res.status).toBe(200);
    expect(booted.repo.revokedId).toBe('42');
    const body = (await res.json()) as { revoked: boolean };
    expect(body.revoked).toBe(true);
  });

  it('returns 404 when the id does not match an existing row', async () => {
    booted.repo.revokeMatches = false;
    // Numeric id that simply doesn't exist in the repo (M19: id-shape
    // validation passes because it's a valid BIGSERIAL).
    const res = await fetch(`${booted.url}/admin/keys/9999`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
    });
    expect(res.status).toBe(404);
  });

  it('rejects without admin auth (401)', async () => {
    const res = await fetch(`${booted.url}/admin/keys/42`, { method: 'DELETE' });
    expect(res.status).toBe(401);
  });

  /* =====================================================================
   * M19 — admin numeric validation. The pg query is parameterized
   * (safe from SQLi) but pg's BIGSERIAL cast THROWS on a non-numeric
   * input, surfacing as a 500 + parse-error text leakage. Reject
   * non-numeric / out-of-range ids with structured 400 BEFORE hitting
   * the repo.
   * ===================================================================== */

  it('rejects a non-numeric id with 400 (M19)', async () => {
    const res = await fetch(`${booted.url}/admin/keys/abc-def`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: { message?: string } };
    expect(body.error?.message ?? '').toMatch(/positive decimal integer/);
    expect(booted.repo.revokedId).toBeUndefined(); // never reached the repo
  });

  it('rejects a negative-shaped id with 400 (M19)', async () => {
    const res = await fetch(`${booted.url}/admin/keys/-5`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
    });
    expect(res.status).toBe(400);
    expect(booted.repo.revokedId).toBeUndefined();
  });

  it('rejects an id with leading zeros with 400 (M19)', async () => {
    const res = await fetch(`${booted.url}/admin/keys/0042`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
    });
    expect(res.status).toBe(400);
    expect(booted.repo.revokedId).toBeUndefined();
  });

  it('rejects an id that exceeds BIGSERIAL range with 400 (M19)', async () => {
    // BIGSERIAL max is 2^63-1 = 9_223_372_036_854_775_807
    const res = await fetch(`${booted.url}/admin/keys/9223372036854775808`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
    });
    expect(res.status).toBe(400);
    expect(booted.repo.revokedId).toBeUndefined();
  });
});

/* =====================================================================
 * M23 — admin scope split. /admin/capacity + /admin/usage accept the
 * read-only admin token; /admin/keys POST/GET/DELETE require the full
 * admin token. Workbench-api can be wired with the read token so a
 * workbench memory-disclosure CVE cannot mint or revoke API keys.
 * ===================================================================== */

const READ_TOKEN = 'admin-read-only-token-7654321098';

describe('admin scope split (M23)', () => {
  it('accepts the read-only token on GET /admin/capacity', async () => {
    const booted = await bootServer({ adminReadToken: READ_TOKEN });
    try {
      const res = await fetch(`${booted.url}/admin/capacity`, {
        headers: { authorization: `Bearer ${READ_TOKEN}` },
      });
      expect(res.status).toBe(200);
    } finally {
      await booted.close();
    }
  });

  it('accepts the read-only token on GET /admin/usage', async () => {
    const booted = await bootServer({ adminReadToken: READ_TOKEN });
    try {
      const res = await fetch(`${booted.url}/admin/usage`, {
        headers: { authorization: `Bearer ${READ_TOKEN}` },
      });
      expect(res.status).toBe(200);
    } finally {
      await booted.close();
    }
  });

  it('REJECTS the read-only token on POST /admin/keys (key-mgmt)', async () => {
    const booted = await bootServer({ adminReadToken: READ_TOKEN });
    try {
      const res = await fetch(`${booted.url}/admin/keys`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${READ_TOKEN}`,
        },
        body: JSON.stringify({ label: 'cli' }),
      });
      expect(res.status).toBe(403);
    } finally {
      await booted.close();
    }
  });

  it('REJECTS the read-only token on GET /admin/keys', async () => {
    const booted = await bootServer({ adminReadToken: READ_TOKEN });
    try {
      const res = await fetch(`${booted.url}/admin/keys`, {
        headers: { authorization: `Bearer ${READ_TOKEN}` },
      });
      expect(res.status).toBe(403);
    } finally {
      await booted.close();
    }
  });

  it('REJECTS the read-only token on DELETE /admin/keys/:id', async () => {
    const booted = await bootServer({ adminReadToken: READ_TOKEN });
    try {
      const res = await fetch(`${booted.url}/admin/keys/42`, {
        method: 'DELETE',
        headers: { authorization: `Bearer ${READ_TOKEN}` },
      });
      expect(res.status).toBe(403);
    } finally {
      await booted.close();
    }
  });

  it('still accepts the full token on read endpoints (back-compat)', async () => {
    const booted = await bootServer({ adminReadToken: READ_TOKEN });
    try {
      const res = await fetch(`${booted.url}/admin/capacity`, {
        headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
      });
      expect(res.status).toBe(200);
    } finally {
      await booted.close();
    }
  });

  it('without read token configured, only the full token works (back-compat)', async () => {
    const booted = await bootServer(); // adminReadToken not set
    try {
      const a = await fetch(`${booted.url}/admin/capacity`, {
        headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
      });
      expect(a.status).toBe(200);
      const b = await fetch(`${booted.url}/admin/capacity`, {
        headers: { authorization: 'Bearer some-other-token' },
      });
      expect(b.status).toBe(403);
    } finally {
      await booted.close();
    }
  });
});

/* =====================================================================
 * H18 (MCALL sibling) — touchLastUsed is wired into the chat-completions
 * auth path so admin-list rendering reflects key activity. The audit
 * surfaced this as "wired-but-dead" by spirit (test passes / production
 * dead) but the WBD paradigm doc reclassifies it as MCALL: the dep is
 * required + threaded; the call is just missing. Fix is: call it.
 * ===================================================================== */

describe('POST /v1/chat/completions — touchLastUsed (H18)', () => {
  it('invokes apiKeyRepo.touchLastUsed with the auth keyHash on every authenticated request', async () => {
    const validKey = 'sk-h18-regression-test-key-1234';
    const validHash = hashApiKey(validKey);
    const lookup = (
      hash: string,
    ): Promise<{
      readonly keyHash: string;
      readonly keyPrefix: string;
      readonly status: 'active';
      readonly expiresAt: null;
    } | null> => {
      if (hash === validHash) {
        return Promise.resolve({
          keyHash: validHash,
          keyPrefix: validKey.slice(0, 8),
          status: 'active' as const,
          expiresAt: null,
        });
      }
      return Promise.resolve(null);
    };
    const booted = await bootServer({ apiKeyLookup: lookup });
    try {
      // Issue a request that AUTHENTICATES but is then rejected at body
      // validation — validates wiring without needing a router stub.
      const res = await fetch(`${booted.url}/v1/chat/completions`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${validKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({}),
      });
      // Body fails validation (no model+messages) → 400. Auth still ran.
      expect(res.status).toBe(400);
      // Allow the fire-and-forget Promise to flush.
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(booted.repo.touchedKeyHashes).toContain(validHash);
    } finally {
      await booted.close();
    }
  });

  it('does NOT invoke touchLastUsed when authentication fails', async () => {
    const booted = await bootServer({ apiKeyLookup: () => Promise.resolve(null) });
    try {
      const res = await fetch(`${booted.url}/v1/chat/completions`, {
        method: 'POST',
        headers: {
          authorization: 'Bearer sk-bogus-key-not-in-repo',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ model: 'm', messages: [] }),
      });
      expect(res.status).toBe(401);
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(booted.repo.touchedKeyHashes).toEqual([]);
    } finally {
      await booted.close();
    }
  });
});

/* =====================================================================
 * Audit-rev2 M7 follow-up — `X-Kagent-Identity-Verified` header
 * emission.
 *
 * The agent-pod's `probeGatewayMtls` (svid-client.ts:249-298) treats
 * the header's PRESENCE as "VERIFIED=spiffe://..." and absence as
 * "UNVERIFIED". Per docs/GATEWAY-CONTRACT.md §4.3, the gateway-side
 * emission is the closing of that loop. Contract:
 *
 *   - Header emitted ONLY when an mTLS resolver returns a non-null
 *     SPIFFE id for the request — i.e. real handshake material.
 *   - Header omitted when resolver is unwired (today's HTTP-only
 *     deploy) OR when resolver returns null (no peer cert, no SAN,
 *     unauthorized handshake). NEVER stub-emit; the agent-pod's
 *     UNVERIFIED branch is the safe posture.
 *
 * Tests drive `maybeEmitIdentityHeader` directly — booting the full
 * chat-completions success path requires real model dispatch. The
 * helper is the seam between the resolver contract and the wire,
 * which is what we need to lock.
 * ===================================================================== */
describe('maybeEmitIdentityHeader (M7 follow-up)', () => {
  function makeRes(): ServerResponse & { _headers: Record<string, unknown> } {
    const headers: Record<string, unknown> = {};
    const res = {
      _headers: headers,
      setHeader(name: string, value: unknown): void {
        headers[name] = value;
      },
      getHeader(name: string): unknown {
        return headers[name];
      },
    } as unknown as ServerResponse & { _headers: Record<string, unknown> };
    return res;
  }

  function makeReq(): IncomingMessage {
    return {} as IncomingMessage;
  }

  it('omits the header when the resolver is undefined (HTTP-only deploy / pre-mTLS gateway)', () => {
    const res = makeRes();
    maybeEmitIdentityHeader(makeReq(), res, undefined);
    expect(res.getHeader('X-Kagent-Identity-Verified')).toBeUndefined();
  });

  it('omits the header when the resolver returns null (mTLS unverified for this request)', () => {
    const res = makeRes();
    maybeEmitIdentityHeader(makeReq(), res, () => null);
    expect(res.getHeader('X-Kagent-Identity-Verified')).toBeUndefined();
  });

  it('emits the resolved SPIFFE id when the resolver returns a verified identity', () => {
    const res = makeRes();
    const spiffeId = 'spiffe://kagent.knuteson.io/agent/researcher';
    maybeEmitIdentityHeader(makeReq(), res, () => ({ spiffeId }));
    expect(res.getHeader('X-Kagent-Identity-Verified')).toBe(spiffeId);
  });

  it('passes the IncomingMessage through to the resolver (so it can inspect req.socket / TLSSocket)', () => {
    const res = makeRes();
    const req = makeReq();
    let captured: IncomingMessage | undefined;
    maybeEmitIdentityHeader(req, res, (r) => {
      captured = r;
      return null;
    });
    expect(captured).toBe(req);
  });
});
