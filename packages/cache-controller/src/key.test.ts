/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import {
  cacheStorageRelPath,
  cacheUri,
  DEFAULT_KEY_SUGAR,
  DEFAULT_KEY_TEMPLATE,
  deriveCacheKey,
  renderKeyTemplate,
} from './key.js';
import type { AgentLike, AgentTaskLike, KeyDerivationContext } from './types.js';

const sampleAgent: AgentLike = {
  spec: { model: 'workers-ai/@cf/meta/llama-4-scout-17b-16e-instruct' },
};
const sampleTask: AgentTaskLike = { spec: {} };
const baseCtx: KeyDerivationContext = {
  imageDigest: 'sha256:abc123',
  inputArtifactHashes: [],
};

const SHA256_HEX_RE = /^[0-9a-f]{64}$/;

function sha256Hex(s: string): string {
  return createHash('sha256').update(s, 'utf8').digest('hex');
}

describe('renderKeyTemplate', () => {
  it('expands the "default" sugar to the canonical recipe', () => {
    const out = renderKeyTemplate(DEFAULT_KEY_SUGAR, sampleAgent, sampleTask, baseCtx);
    expect(out).toBe(`+sha256:abc123+${sampleAgent.spec.model}`);
  });

  it('substitutes all three recognized tokens', () => {
    const out = renderKeyTemplate(
      'before-{input_artifact_hashes}-mid-{image_digest}-end-{model_name}!',
      sampleAgent,
      sampleTask,
      { imageDigest: 'sha256:dig', inputArtifactHashes: ['aaaa', 'bbbb'] },
    );
    expect(out).toBe(`before-aaaa+bbbb-mid-sha256:dig-end-${sampleAgent.spec.model}!`);
  });

  it('sorts artifact hashes lexicographically (order-independent)', () => {
    const a = renderKeyTemplate(DEFAULT_KEY_TEMPLATE, sampleAgent, sampleTask, {
      imageDigest: 'd',
      inputArtifactHashes: ['z', 'm', 'a'],
    });
    const b = renderKeyTemplate(DEFAULT_KEY_TEMPLATE, sampleAgent, sampleTask, {
      imageDigest: 'd',
      inputArtifactHashes: ['m', 'a', 'z'],
    });
    expect(a).toBe(b);
    expect(a).toContain('a+m+z');
  });

  it('renders empty inputArtifactHashes as an empty string', () => {
    const out = renderKeyTemplate(
      '{input_artifact_hashes}|{model_name}',
      sampleAgent,
      sampleTask,
      baseCtx,
    );
    expect(out).toBe(`|${sampleAgent.spec.model}`);
  });

  it('passes unrecognized {token} substrings through verbatim', () => {
    const out = renderKeyTemplate(
      'literal-{tenant}-{image_digest}',
      sampleAgent,
      sampleTask,
      baseCtx,
    );
    expect(out).toBe('literal-{tenant}-sha256:abc123');
  });
});

describe('deriveCacheKey', () => {
  it('returns a 64-char lowercase hex sha256', () => {
    const out = deriveCacheKey(DEFAULT_KEY_SUGAR, sampleAgent, sampleTask, baseCtx);
    expect(SHA256_HEX_RE.test(out)).toBe(true);
  });

  it('matches sha256 of the rendered template', () => {
    const rendered = renderKeyTemplate(DEFAULT_KEY_SUGAR, sampleAgent, sampleTask, baseCtx);
    expect(deriveCacheKey(DEFAULT_KEY_SUGAR, sampleAgent, sampleTask, baseCtx)).toBe(
      sha256Hex(rendered),
    );
  });

  it('is deterministic across calls with same inputs', () => {
    const a = deriveCacheKey('npm-{image_digest}', sampleAgent, sampleTask, baseCtx);
    const b = deriveCacheKey('npm-{image_digest}', sampleAgent, sampleTask, baseCtx);
    expect(a).toBe(b);
  });

  it('changes when image digest changes', () => {
    const a = deriveCacheKey(DEFAULT_KEY_SUGAR, sampleAgent, sampleTask, {
      ...baseCtx,
      imageDigest: 'sha256:v1',
    });
    const b = deriveCacheKey(DEFAULT_KEY_SUGAR, sampleAgent, sampleTask, {
      ...baseCtx,
      imageDigest: 'sha256:v2',
    });
    expect(a).not.toBe(b);
  });

  it('changes when model changes', () => {
    const a = deriveCacheKey(DEFAULT_KEY_SUGAR, sampleAgent, sampleTask, baseCtx);
    const b = deriveCacheKey(
      DEFAULT_KEY_SUGAR,
      { spec: { model: 'other/model' } },
      sampleTask,
      baseCtx,
    );
    expect(a).not.toBe(b);
  });

  it('changes when artifact hashes change', () => {
    const a = deriveCacheKey(DEFAULT_KEY_SUGAR, sampleAgent, sampleTask, {
      ...baseCtx,
      inputArtifactHashes: ['hashA'],
    });
    const b = deriveCacheKey(DEFAULT_KEY_SUGAR, sampleAgent, sampleTask, {
      ...baseCtx,
      inputArtifactHashes: ['hashB'],
    });
    expect(a).not.toBe(b);
  });

  it('does NOT change when artifact-hash order changes', () => {
    const a = deriveCacheKey(DEFAULT_KEY_SUGAR, sampleAgent, sampleTask, {
      ...baseCtx,
      inputArtifactHashes: ['x', 'y'],
    });
    const b = deriveCacheKey(DEFAULT_KEY_SUGAR, sampleAgent, sampleTask, {
      ...baseCtx,
      inputArtifactHashes: ['y', 'x'],
    });
    expect(a).toBe(b);
  });

  it('throws on empty template', () => {
    expect(() => deriveCacheKey('', sampleAgent, sampleTask, baseCtx)).toThrow(/non-empty string/);
  });

  it('throws on non-string template', () => {
    expect(() =>
      deriveCacheKey(undefined as unknown as string, sampleAgent, sampleTask, baseCtx),
    ).toThrow(/non-empty string/);
  });

  it('throws when agent.spec.model is not a string', () => {
    expect(() =>
      deriveCacheKey(
        'npm-cache',
        { spec: { model: 42 as unknown as string } },
        sampleTask,
        baseCtx,
      ),
    ).toThrow(/model must be a string/);
  });
});

describe('cacheStorageRelPath', () => {
  const validHash = 'a'.repeat(64);

  it('shards on the first 2 hex chars + remaining 62', () => {
    expect(cacheStorageRelPath(validHash, 'node_modules')).toBe(
      `cache/sha256/aa/${'a'.repeat(62)}/node_modules`,
    );
  });

  it('rejects non-sha256-hex keys', () => {
    expect(() => cacheStorageRelPath('not-a-hash', 'x')).toThrow(/64-char lowercase sha256/);
    expect(() => cacheStorageRelPath('A'.repeat(64), 'x')).toThrow(/64-char lowercase sha256/);
  });

  it('rejects empty / leading-slash names', () => {
    expect(() => cacheStorageRelPath(validHash, '')).toThrow(/name required/);
    expect(() => cacheStorageRelPath(validHash, '/x')).toThrow(/must not begin with/);
  });

  it('rejects ".." in name segments', () => {
    expect(() => cacheStorageRelPath(validHash, '../escape')).toThrow(/".."/);
  });

  it('accepts nested name segments', () => {
    expect(cacheStorageRelPath(validHash, 'a/b/c')).toContain('/a/b/c');
  });
});

describe('cacheUri', () => {
  const validHash = 'b'.repeat(64);

  it('builds the canonical scheme', () => {
    expect(cacheUri(validHash, 'pip-cache')).toBe(`cache://sha256:${validHash}/pip-cache`);
  });

  it('rejects invalid keys / names', () => {
    expect(() => cacheUri('zzz', 'x')).toThrow();
    expect(() => cacheUri(validHash, '')).toThrow();
    expect(() => cacheUri(validHash, '/x')).toThrow();
    expect(() => cacheUri(validHash, '../etc')).toThrow();
  });
});
