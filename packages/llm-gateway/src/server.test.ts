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

import { buildHandler, type ServerDeps } from './server.js';
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

function bootServer(
  overrides: Partial<Pick<ServerDeps, 'apiKeyLookup' | 'modelIndex' | 'routerDeps'>> = {},
): Promise<BootedServer> {
  return new Promise((resolve, reject) => {
    const repo = new StubApiKeyRepo();
    const deps: ServerDeps = {
      modelIndex: overrides.modelIndex ?? new ModelIndex(),
      inFlight: new InFlightCounter(),
      aimd: new AimdController({ seed: 1, max: 4, minSafe: 1 }),
      routerDeps: overrides.routerDeps ?? ({} as unknown as RouterDeps),
      apiKeyLookup: overrides.apiKeyLookup ?? (() => Promise.resolve(null)),
      apiKeyRepo: repo,
      usageRepo: new StubUsageRepo(),
      adminToken: ADMIN_TOKEN,
      readinessProbe: () => Promise.resolve(true),
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
    const res = await fetch(`${booted.url}/admin/keys/missing`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
    });
    expect(res.status).toBe(404);
  });

  it('rejects without admin auth (401)', async () => {
    const res = await fetch(`${booted.url}/admin/keys/42`, { method: 'DELETE' });
    expect(res.status).toBe(401);
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
