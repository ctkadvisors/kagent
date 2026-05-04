/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/**
 * Tests for the `read_artifact` substrate tool + the
 * `agentHasArtifactInputOrOutput` capability gate. Wave 1 / CAS sub-team
 * (v0.2.2-cas).
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ToolInvocationContext } from '@kagent/agent-loop';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { defineReadArtifact } from './builtin-tools.js';
import { PvcCasBackend, type CasBackend, type CasWriteResult } from './cas-backend.js';
import { agentHasArtifactInputOrOutput, type AgentSpecEnv } from './env.js';

const NEVER_ABORT_CTX: ToolInvocationContext = {
  abortSignal: new AbortController().signal,
};

function freshMount(): string {
  return mkdtempSync(join(tmpdir(), 'kagent-read-artifact-test-'));
}

function getJsonResult(blocks: { type: string; text: string }[]): Record<string, unknown> {
  expect(blocks).toHaveLength(1);
  const first = blocks[0];
  if (first === undefined) throw new Error('no content block');
  expect(first.type).toBe('text');
  return JSON.parse(first.text) as Record<string, unknown>;
}

describe('agentHasArtifactInputOrOutput', () => {
  it('returns false when no inputs / outputs', () => {
    expect(agentHasArtifactInputOrOutput({ model: 'test' })).toBe(false);
  });

  it('returns false when only scalar / workspace inputs', () => {
    const spec: AgentSpecEnv = {
      model: 'test',
      inputs: [
        { name: 'corpus', kind: 'workspace', mountPath: '/mnt' },
        { name: 'k', kind: 'scalar' },
      ],
    };
    expect(agentHasArtifactInputOrOutput(spec)).toBe(false);
  });

  it('returns true when at least one input is artifact', () => {
    const spec: AgentSpecEnv = {
      model: 'test',
      inputs: [{ name: 'brief', kind: 'artifact', mountPath: '/mnt' }],
    };
    expect(agentHasArtifactInputOrOutput(spec)).toBe(true);
  });

  it('returns true when at least one output is artifact', () => {
    const spec: AgentSpecEnv = {
      model: 'test',
      outputs: [{ name: 'digest', kind: 'artifact' }],
    };
    expect(agentHasArtifactInputOrOutput(spec)).toBe(true);
  });

  it('returns true when only outputs but artifact', () => {
    const spec: AgentSpecEnv = {
      model: 'test',
      inputs: [{ name: 'k', kind: 'scalar' }],
      outputs: [{ name: 'digest', kind: 'artifact' }],
    };
    expect(agentHasArtifactInputOrOutput(spec)).toBe(true);
  });
});

describe('defineReadArtifact', () => {
  let mount: string;

  beforeEach(() => {
    mount = freshMount();
  });

  afterEach(() => {
    rmSync(mount, { recursive: true, force: true });
  });

  it('reads back a text/markdown artifact as UTF-8 text', async () => {
    const backend = new PvcCasBackend(mount);
    const bytes = new TextEncoder().encode('# heading\n\ncontent');
    const { uri } = await backend.write(bytes, 'doc.md');

    const tool = defineReadArtifact({ backend });
    const result = await tool.handler({ uri, mediaType: 'text/markdown' }, NEVER_ABORT_CTX);

    const json = getJsonResult(result);
    expect(json.uri).toBe(uri);
    expect(json.mediaType).toBe('text/markdown');
    expect(json.base64Encoded).toBe(false);
    expect(json.sizeBytes).toBe(bytes.byteLength);
    expect(json.content).toBe('# heading\n\ncontent');
  });

  it('reads back application/json as text', async () => {
    const backend = new PvcCasBackend(mount);
    const bytes = new TextEncoder().encode('{"k":"v"}');
    const { uri } = await backend.write(bytes, 'a.json');
    const tool = defineReadArtifact({ backend });

    const result = await tool.handler({ uri, mediaType: 'application/json' }, NEVER_ABORT_CTX);
    const json = getJsonResult(result);
    expect(json.base64Encoded).toBe(false);
    expect(json.content).toBe('{"k":"v"}');
  });

  it('base64-encodes binary media types', async () => {
    const backend = new PvcCasBackend(mount);
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47]); // PNG magic
    const { uri } = await backend.write(bytes, 'a.png');
    const tool = defineReadArtifact({ backend });

    const result = await tool.handler({ uri, mediaType: 'image/png' }, NEVER_ABORT_CTX);
    const json = getJsonResult(result);
    expect(json.mediaType).toBe('image/png');
    expect(json.base64Encoded).toBe(true);
    expect(json.content).toBe('iVBORw=='); // base64(0x89,0x50,0x4e,0x47)
  });

  it('falls back to text when no mediaType supplied', async () => {
    const backend = new PvcCasBackend(mount);
    const bytes = new TextEncoder().encode('plain');
    const { uri } = await backend.write(bytes, 'a.txt');
    const tool = defineReadArtifact({ backend });

    const result = await tool.handler({ uri }, NEVER_ABORT_CTX);
    const json = getJsonResult(result);
    // No mediaType → defaults to application/octet-stream + base64.
    expect(json.mediaType).toBe('application/octet-stream');
    expect(json.base64Encoded).toBe(true);
  });

  it('rejects an empty / missing uri', async () => {
    const backend = new PvcCasBackend(mount);
    const tool = defineReadArtifact({ backend });
    await expect(tool.handler({}, NEVER_ABORT_CTX)).rejects.toThrow(/uri.*non-empty/);
    await expect(tool.handler({ uri: '' }, NEVER_ABORT_CTX)).rejects.toThrow();
    await expect(tool.handler({ uri: 42 }, NEVER_ABORT_CTX)).rejects.toThrow();
  });

  it('surfaces hash-mismatch as a tool error (not silent corruption)', async () => {
    // Stub backend whose read() unconditionally throws hash-mismatch.
    const backend: CasBackend = {
      read: () => Promise.reject(new Error('cas-backend: hash mismatch reading "x"')),
      write: (): Promise<CasWriteResult> => Promise.resolve({ uri: 'x', contentHash: 'x' }),
      exists: () => Promise.resolve(false),
    };
    const tool = defineReadArtifact({ backend });
    await expect(
      tool.handler({ uri: 'cas://sha256:' + 'a'.repeat(64) + '/x.md' }, NEVER_ABORT_CTX),
    ).rejects.toThrow(/hash mismatch/);
  });

  it('refuses payloads larger than the 8 MiB cap', async () => {
    // Stub backend returning a 10-MiB Uint8Array (no real disk write needed).
    const big = new Uint8Array(10 * 1024 * 1024);
    const backend: CasBackend = {
      read: () => Promise.resolve(big),
      write: (): Promise<CasWriteResult> => Promise.resolve({ uri: 'x', contentHash: 'x' }),
      exists: () => Promise.resolve(true),
    };
    const tool = defineReadArtifact({ backend });
    await expect(
      tool.handler({ uri: 'cas://sha256:' + 'a'.repeat(64) + '/big.bin' }, NEVER_ABORT_CTX),
    ).rejects.toThrow(/exceeds 8388608 bytes/);
  });

  it('exposes name + tags for tool registration', () => {
    const backend = new PvcCasBackend(mount);
    const tool = defineReadArtifact({ backend });
    expect(tool.name).toBe('read_artifact');
    expect(tool.tags).toContain('substrate');
    expect(tool.tags).toContain('artifacts');
    expect(tool.tags).toContain('read-only');
  });
});
