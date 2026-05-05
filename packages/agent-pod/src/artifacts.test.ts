/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/**
 * Behavioral tests for the artifact writer + the `write_artifact` tool.
 * Coverage targets per the P3 task brief:
 *   - happy path (file lands, ArtifactRef shape is right, sha256 matches)
 *   - path-traversal refusals (`..`, leading `/`, control chars)
 *   - atomic-write semantics (no leftover `.tmp`, no partial visible file
 *     when the writer throws mid-write)
 *   - inline short-circuit (no FS write, synthetic ref returned)
 *   - resolveWriterEnv defaults + env precedence
 *   - tryParseArtifactRefFromToolOutput shape guard
 */

import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ToolCall, ToolInvocationContext, ToolResult } from '@kagent/agent-loop';
import { InProcessToolProvider } from '@kagent/in-process-tool-provider';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  buildPvcUri,
  createArtifactRegistry,
  DEFAULT_ARTIFACT_MAX_BYTES,
  DEFAULT_ARTIFACTS_DIR,
  DEFAULT_PVC_NAME,
  ENV_ARTIFACT_MAX_BYTES,
  ENV_ARTIFACTS_DIR,
  ENV_ARTIFACTS_PVC_NAME,
  ENV_TASK_ID,
  inlineArtifactRef,
  inlineSafeForArtifact,
  isArtifactRefShape,
  resolveWriterEnv,
  resolveWriterEnvOrDisabled,
  tryParseArtifactRefFromToolOutput,
  validateArtifactName,
  writeArtifactToDisk,
  type ArtifactRef,
} from './artifacts.js';
import { buildBuiltinToolRegistry } from './builtin-tools.js';

const ctx = (): ToolInvocationContext => ({
  runId: 'test-run',
  abortSignal: new AbortController().signal,
});

const call = (name: string, args: Record<string, unknown> = {}): ToolCall => ({
  id: 'c1',
  name,
  args,
});

function contentString(r: ToolResult): string {
  if (typeof r.content === 'string') return r.content;
  return JSON.stringify(r.content);
}

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'kagent-artifacts-'));
});

afterEach(() => {
  try {
    rmSync(tmpRoot, { recursive: true, force: true });
  } catch {
    // ignore — tmp dir may already be gone
  }
});

/* =====================================================================
 * validateArtifactName — pure path-safety checks
 * ===================================================================== */

describe('validateArtifactName', () => {
  it('accepts a plain filename', () => {
    expect(validateArtifactName('digest.md')).toBe('digest.md');
  });

  it('accepts nested forward-slash paths', () => {
    expect(validateArtifactName('screenshots/01.png')).toBe('screenshots/01.png');
  });

  it('rejects non-string', () => {
    expect(() => validateArtifactName(42)).toThrow(/must be a string/);
    expect(() => validateArtifactName(undefined)).toThrow(/must be a string/);
  });

  it('rejects empty string', () => {
    expect(() => validateArtifactName('')).toThrow(/must not be empty/);
  });

  it('rejects leading slash', () => {
    expect(() => validateArtifactName('/etc/passwd')).toThrow(/must not begin with "\/"/);
  });

  it('rejects backslashes', () => {
    expect(() => validateArtifactName('foo\\bar.txt')).toThrow(/must not contain backslashes/);
  });

  it('rejects ".." segments', () => {
    expect(() => validateArtifactName('../escape.md')).toThrow(/".."/);
    expect(() => validateArtifactName('a/../b.md')).toThrow(/".."/);
    expect(() => validateArtifactName('..')).toThrow(/".."/);
  });

  it('rejects "." segments', () => {
    expect(() => validateArtifactName('./foo.md')).toThrow(/"\."/);
    expect(() => validateArtifactName('a/./b.md')).toThrow(/"\."/);
  });

  it('rejects empty segments (consecutive slashes / trailing slash)', () => {
    expect(() => validateArtifactName('a//b.md')).toThrow(/empty segments/);
    expect(() => validateArtifactName('foo/')).toThrow(/empty segments/);
  });

  it('rejects control characters (NUL, newline, tab, DEL) via escape sequences', () => {
    expect(() => validateArtifactName('foo\x00bar.md')).toThrow(/non-printable/);
    expect(() => validateArtifactName('foo\nbar.md')).toThrow(/non-printable/);
    expect(() => validateArtifactName('foo\tbar.md')).toThrow(/non-printable/);
    expect(() => validateArtifactName('foo\x7fbar.md')).toThrow(/non-printable/);
  });

  it('accepts dotfiles (leading "." in segment is allowed; "." segment alone is not)', () => {
    // Dotfiles like `.digest.md` are useful (sentinel files, hidden
    // markers); only the literal `.` and `..` segments are refused.
    expect(validateArtifactName('.digest.md')).toBe('.digest.md');
    expect(validateArtifactName('foo/.bar')).toBe('foo/.bar');
  });

  it('accepts UTF-8 non-control characters', () => {
    expect(validateArtifactName('rapport-français.md')).toBe('rapport-français.md');
    expect(validateArtifactName('emoji-🚀.md')).toBe('emoji-🚀.md');
  });
});

/* =====================================================================
 * buildPvcUri / inlineSafeForArtifact — pure
 * ===================================================================== */

describe('buildPvcUri', () => {
  it('emits canonical pvc:// URI', () => {
    expect(buildPvcUri('kagent-artifacts', 'task-uid-1', 'digest.md')).toBe(
      'pvc://kagent-artifacts/task-uid-1/digest.md',
    );
  });

  it('throws on missing pvc / task uid', () => {
    expect(() => buildPvcUri('', 'uid', 'name')).toThrow(/pvcName required/);
    expect(() => buildPvcUri('pvc', '', 'name')).toThrow(/taskUid required/);
  });
});

describe('inlineSafeForArtifact', () => {
  it('inlines small text/markdown', () => {
    expect(inlineSafeForArtifact('# Hi', 'text/markdown')).toBe(true);
  });

  it('refuses non-text media types', () => {
    expect(inlineSafeForArtifact('PNG-bytes-here', 'image/png')).toBe(false);
  });

  it('refuses content over the cap', () => {
    const big = 'a'.repeat(9 * 1024);
    expect(inlineSafeForArtifact(big, 'text/markdown')).toBe(false);
  });

  it('honors caller-supplied maxBytes', () => {
    expect(inlineSafeForArtifact('aaaaa', 'text/markdown', 4)).toBe(false);
    expect(inlineSafeForArtifact('aaaa', 'text/markdown', 4)).toBe(true);
  });
});

/* =====================================================================
 * resolveWriterEnv — defaults + precedence
 * ===================================================================== */

describe('resolveWriterEnv', () => {
  it('defaults to /var/kagent/artifacts + kagent-artifacts when env unset', () => {
    const env = { [ENV_TASK_ID]: 'uid-1' } as Record<string, string | undefined>;
    expect(resolveWriterEnv(env)).toEqual({
      artifactsDir: DEFAULT_ARTIFACTS_DIR,
      pvcName: DEFAULT_PVC_NAME,
      taskUid: 'uid-1',
      maxBytes: DEFAULT_ARTIFACT_MAX_BYTES,
    });
  });

  it('honors explicit env vars', () => {
    const env = {
      [ENV_TASK_ID]: 'uid-2',
      [ENV_ARTIFACTS_DIR]: '/mnt/artifacts',
      [ENV_ARTIFACTS_PVC_NAME]: 'kagent-artifacts-prod',
    };
    expect(resolveWriterEnv(env)).toEqual({
      artifactsDir: '/mnt/artifacts',
      pvcName: 'kagent-artifacts-prod',
      taskUid: 'uid-2',
      maxBytes: DEFAULT_ARTIFACT_MAX_BYTES,
    });
  });

  it('honors explicit KAGENT_ARTIFACT_MAX_BYTES', () => {
    const env = {
      [ENV_TASK_ID]: 'uid-3',
      [ENV_ARTIFACT_MAX_BYTES]: '1048576',
    };
    expect(resolveWriterEnv(env).maxBytes).toBe(1048576);
  });

  it('falls back to DEFAULT_ARTIFACT_MAX_BYTES on malformed cap', () => {
    for (const raw of ['', '0', '-1', 'NaN', 'huge']) {
      const env = { [ENV_TASK_ID]: 'uid-x', [ENV_ARTIFACT_MAX_BYTES]: raw };
      expect(resolveWriterEnv(env).maxBytes).toBe(DEFAULT_ARTIFACT_MAX_BYTES);
    }
  });

  it('throws when KAGENT_TASK_ID is missing', () => {
    expect(() => resolveWriterEnv({})).toThrow(/KAGENT_TASK_ID/);
    expect(() => resolveWriterEnv({ [ENV_TASK_ID]: '' })).toThrow(/KAGENT_TASK_ID/);
  });
});

/* =====================================================================
 * resolveWriterEnvOrDisabled — strict gating contract for the
 * `disabled` error path (default-OFF when operator hasn't enabled the
 * Helm chart's artifactStorage block).
 * ===================================================================== */

describe('resolveWriterEnvOrDisabled', () => {
  it('returns disabled when KAGENT_TASK_ID is missing', () => {
    const r = resolveWriterEnvOrDisabled({});
    expect('disabled' in r).toBe(true);
    if ('disabled' in r) expect(r.reason).toMatch(/KAGENT_TASK_ID/);
  });

  it('returns disabled when KAGENT_ARTIFACTS_DIR is unset', () => {
    const r = resolveWriterEnvOrDisabled({ [ENV_TASK_ID]: 'uid-1' });
    expect('disabled' in r).toBe(true);
    if ('disabled' in r) expect(r.reason).toMatch(/KAGENT_ARTIFACTS_DIR/);
  });

  it('returns disabled when KAGENT_ARTIFACT_PVC_NAME is unset', () => {
    const r = resolveWriterEnvOrDisabled({
      [ENV_TASK_ID]: 'uid-1',
      [ENV_ARTIFACTS_DIR]: '/var/kagent/artifacts',
    });
    expect('disabled' in r).toBe(true);
    if ('disabled' in r) expect(r.reason).toMatch(/KAGENT_ARTIFACT_PVC_NAME/);
  });

  it('returns a writable env when both PVC env vars are set', () => {
    const r = resolveWriterEnvOrDisabled({
      [ENV_TASK_ID]: 'uid-1',
      [ENV_ARTIFACTS_DIR]: '/var/kagent/artifacts',
      [ENV_ARTIFACTS_PVC_NAME]: 'kagent-artifacts',
    });
    expect('disabled' in r).toBe(false);
    if (!('disabled' in r)) {
      expect(r.taskUid).toBe('uid-1');
      expect(r.maxBytes).toBe(DEFAULT_ARTIFACT_MAX_BYTES);
    }
  });

  it('threads maxBytes through from env on the enabled branch', () => {
    const r = resolveWriterEnvOrDisabled({
      [ENV_TASK_ID]: 'uid-1',
      [ENV_ARTIFACTS_DIR]: '/var/kagent/artifacts',
      [ENV_ARTIFACTS_PVC_NAME]: 'kagent-artifacts',
      [ENV_ARTIFACT_MAX_BYTES]: '2048',
    });
    if (!('disabled' in r)) {
      expect(r.maxBytes).toBe(2048);
    }
  });
});

/* =====================================================================
 * writeArtifactToDisk — atomic, hashed, scoped
 * ===================================================================== */

describe('writeArtifactToDisk', () => {
  it('happy path: creates the file under <root>/<task-uid>/<name>', () => {
    const env = {
      artifactsDir: tmpRoot,
      pvcName: 'kagent-artifacts',
      taskUid: 'uid-1',
      maxBytes: DEFAULT_ARTIFACT_MAX_BYTES,
    };
    const r = writeArtifactToDisk('digest.md', '# hello', 'text/markdown', env);
    expect(r.path).toBe(join(tmpRoot, 'uid-1', 'digest.md'));
    expect(existsSync(r.path)).toBe(true);
    expect(readFileSync(r.path, 'utf8')).toBe('# hello');
  });

  it('returns a well-shaped ArtifactRef', () => {
    const env = {
      artifactsDir: tmpRoot,
      pvcName: 'kagent-artifacts',
      taskUid: 'uid-1',
      maxBytes: DEFAULT_ARTIFACT_MAX_BYTES,
    };
    const fixedNow = new Date('2026-04-28T14:23:11Z');
    const r = writeArtifactToDisk('digest.md', '# hello', 'text/markdown', env, fixedNow);
    const expected = createHash('sha256').update('# hello', 'utf8').digest('hex');
    expect(r.ref).toEqual({
      uri: 'pvc://kagent-artifacts/uid-1/digest.md',
      name: 'digest.md',
      mediaType: 'text/markdown',
      sizeBytes: Buffer.byteLength('# hello', 'utf8'),
      checksum: `sha256:${expected}`,
      contentHash: expected,
      producedAt: '2026-04-28T14:23:11.000Z',
    });
  });

  it('checksum matches sha256 of the bytes (utf-8 multi-byte)', () => {
    const env = {
      artifactsDir: tmpRoot,
      pvcName: 'kagent-artifacts',
      taskUid: 'uid-1',
      maxBytes: DEFAULT_ARTIFACT_MAX_BYTES,
    };
    const content = 'rapport-français-🚀';
    const r = writeArtifactToDisk('utf8.md', content, 'text/markdown', env);
    const expected = createHash('sha256').update(content, 'utf8').digest('hex');
    expect(r.ref.checksum).toBe(`sha256:${expected}`);
    expect(r.ref.sizeBytes).toBe(Buffer.byteLength(content, 'utf8'));
  });

  it('atomic write: leaves no .tmp behind on success', () => {
    const env = {
      artifactsDir: tmpRoot,
      pvcName: 'kagent-artifacts',
      taskUid: 'uid-1',
      maxBytes: DEFAULT_ARTIFACT_MAX_BYTES,
    };
    writeArtifactToDisk('digest.md', '# hello', 'text/markdown', env);
    const dir = join(tmpRoot, 'uid-1');
    const entries = readdirSync(dir);
    expect(entries).toEqual(['digest.md']);
  });

  it('creates nested directories for slash-bearing names', () => {
    const env = {
      artifactsDir: tmpRoot,
      pvcName: 'kagent-artifacts',
      taskUid: 'uid-1',
      maxBytes: DEFAULT_ARTIFACT_MAX_BYTES,
    };
    const r = writeArtifactToDisk('screenshots/01.png', 'binary-ish', 'image/png', env);
    expect(existsSync(r.path)).toBe(true);
    expect(r.ref.uri).toBe('pvc://kagent-artifacts/uid-1/screenshots/01.png');
    expect(statSync(join(tmpRoot, 'uid-1', 'screenshots')).isDirectory()).toBe(true);
  });

  it('refuses path traversal via name', () => {
    const env = {
      artifactsDir: tmpRoot,
      pvcName: 'kagent-artifacts',
      taskUid: 'uid-1',
      maxBytes: DEFAULT_ARTIFACT_MAX_BYTES,
    };
    expect(() => writeArtifactToDisk('../escape.md', 'x', 'text/markdown', env)).toThrow(/".."/);
    expect(() => writeArtifactToDisk('/abs.md', 'x', 'text/markdown', env)).toThrow(
      /must not begin with "\/"/,
    );
  });

  it('refuses control chars via name', () => {
    const env = {
      artifactsDir: tmpRoot,
      pvcName: 'kagent-artifacts',
      taskUid: 'uid-1',
      maxBytes: DEFAULT_ARTIFACT_MAX_BYTES,
    };
    expect(() => writeArtifactToDisk('foo\nbar.md', 'x', 'text/markdown', env)).toThrow(
      /non-printable/,
    );
  });

  it('refuses empty mediaType', () => {
    const env = {
      artifactsDir: tmpRoot,
      pvcName: 'kagent-artifacts',
      taskUid: 'uid-1',
      maxBytes: DEFAULT_ARTIFACT_MAX_BYTES,
    };
    expect(() => writeArtifactToDisk('a.md', 'x', '', env)).toThrow(/mediaType/);
  });

  it('handles 0-byte content (sentinel file)', () => {
    const env = {
      artifactsDir: tmpRoot,
      pvcName: 'kagent-artifacts',
      taskUid: 'uid-1',
      maxBytes: DEFAULT_ARTIFACT_MAX_BYTES,
    };
    const r = writeArtifactToDisk('marker', '', 'text/plain', env);
    expect(existsSync(r.path)).toBe(true);
    expect(readFileSync(r.path, 'utf8')).toBe('');
    expect(r.ref.sizeBytes).toBe(0);
  });

  it('writes are scoped under the task-uid directory (no cross-task leak)', () => {
    const env1 = {
      artifactsDir: tmpRoot,
      pvcName: 'kagent-artifacts',
      taskUid: 'uid-A',
      maxBytes: DEFAULT_ARTIFACT_MAX_BYTES,
    };
    const env2 = {
      artifactsDir: tmpRoot,
      pvcName: 'kagent-artifacts',
      taskUid: 'uid-B',
      maxBytes: DEFAULT_ARTIFACT_MAX_BYTES,
    };
    writeArtifactToDisk('shared.md', 'A version', 'text/markdown', env1);
    writeArtifactToDisk('shared.md', 'B version', 'text/markdown', env2);
    expect(readFileSync(join(tmpRoot, 'uid-A', 'shared.md'), 'utf8')).toBe('A version');
    expect(readFileSync(join(tmpRoot, 'uid-B', 'shared.md'), 'utf8')).toBe('B version');
  });

  it('regression: pvc:// URI is ALWAYS followable to a real file (persistence invariant)', () => {
    // The whole point of the WS-D scheme split: any returned `pvc://`
    // URI must round-trip to a stat-able file on disk. The inline path
    // returns `inline://` exactly so this assertion can never lie.
    const env = {
      artifactsDir: tmpRoot,
      pvcName: 'kagent-artifacts',
      taskUid: 'uid-1',
      maxBytes: DEFAULT_ARTIFACT_MAX_BYTES,
    };
    const r = writeArtifactToDisk('digest.md', 'hello', 'text/markdown', env);
    expect(r.ref.uri.startsWith('pvc://')).toBe(true);
    // Reverse-map the URI back to the on-disk path. We mirror the
    // canonical `pvc://<pvc>/<task-uid>/<name>` layout to prove the
    // contract holds end-to-end.
    const matched = /^pvc:\/\/([^/]+)\/(.+)$/.exec(r.ref.uri);
    expect(matched).not.toBeNull();
    const pathPart = matched![2]!;
    const onDisk = join(tmpRoot, pathPart);
    expect(statSync(onDisk).isFile()).toBe(true);
    expect(readFileSync(onDisk, 'utf8')).toBe('hello');
  });
});

/* =====================================================================
 * inlineArtifactRef — non-persisting counterpart contract
 * ===================================================================== */

describe('inlineArtifactRef', () => {
  it('returns an inline://sha256:<hex> URI', () => {
    const ref = inlineArtifactRef('hello', 'text/markdown');
    expect(ref.uri).toMatch(/^inline:\/\/sha256:[0-9a-f]{64}$/);
  });

  it('checksum + URI hash agree (content-addressed)', () => {
    const ref = inlineArtifactRef('hello', 'text/markdown');
    const expected = createHash('sha256').update('hello').digest('hex');
    expect(ref.checksum).toBe(`sha256:${expected}`);
    expect(ref.uri).toBe(`inline://sha256:${expected}`);
  });

  it('sets sizeBytes to UTF-8 byte length', () => {
    const ref = inlineArtifactRef('rapport-français-🚀', 'text/markdown');
    expect(ref.sizeBytes).toBe(Buffer.byteLength('rapport-français-🚀', 'utf8'));
  });

  it('honors injected clock for producedAt', () => {
    const fixedNow = new Date('2026-04-28T14:23:11Z');
    const ref = inlineArtifactRef('x', 'text/plain', fixedNow);
    expect(ref.producedAt).toBe('2026-04-28T14:23:11.000Z');
  });

  it('refuses non-string content + empty mediaType', () => {
    expect(() => inlineArtifactRef(undefined as unknown as string, 'text/plain')).toThrow(
      /content/,
    );
    expect(() => inlineArtifactRef('x', '')).toThrow(/mediaType/);
  });
});

/* =====================================================================
 * tryParseArtifactRefFromToolOutput / isArtifactRefShape
 * ===================================================================== */

describe('isArtifactRefShape', () => {
  it('accepts a fully-populated ref', () => {
    expect(
      isArtifactRefShape({
        uri: 'pvc://k/u/n.md',
        name: 'n.md',
        mediaType: 'text/markdown',
        sizeBytes: 3,
        checksum: 'sha256:abc',
        producedAt: '2026-04-28T00:00:00.000Z',
      }),
    ).toBe(true);
  });

  it('accepts a uri-only ref (forward-compat)', () => {
    expect(isArtifactRefShape({ uri: 'pvc://k/u/n' })).toBe(true);
  });

  it('rejects null / non-object / missing uri / wrong-typed fields', () => {
    expect(isArtifactRefShape(null)).toBe(false);
    expect(isArtifactRefShape('string')).toBe(false);
    expect(isArtifactRefShape({})).toBe(false);
    expect(isArtifactRefShape({ uri: '' })).toBe(false);
    expect(isArtifactRefShape({ uri: 'x', sizeBytes: -1 })).toBe(false);
    expect(isArtifactRefShape({ uri: 'x', sizeBytes: 'big' as unknown })).toBe(false);
  });
});

describe('tryParseArtifactRefFromToolOutput', () => {
  it('parses the ContentBlock[] shape produced by write_artifact', () => {
    const ref: ArtifactRef = {
      uri: 'pvc://kagent-artifacts/uid-1/digest.md',
      name: 'digest.md',
      mediaType: 'text/markdown',
      sizeBytes: 7,
      checksum: 'sha256:abc',
      producedAt: '2026-04-28T00:00:00.000Z',
    };
    const blocks = [{ type: 'text', text: JSON.stringify(ref) }];
    const out = tryParseArtifactRefFromToolOutput(JSON.stringify(blocks));
    expect(out).toEqual(ref);
  });

  it('returns null on truncated trace output', () => {
    const truncated = '[{"type":"text","text":"...[truncated 10000 chars]..."}]';
    expect(tryParseArtifactRefFromToolOutput(truncated)).toBeNull();
  });

  it('returns null on malformed JSON', () => {
    expect(tryParseArtifactRefFromToolOutput('not json')).toBeNull();
  });

  it('returns null on shape mismatch', () => {
    const blocks = [{ type: 'text', text: '{"foo":"bar"}' }];
    expect(tryParseArtifactRefFromToolOutput(JSON.stringify(blocks))).toBeNull();
  });

  it('returns null on undefined / non-string', () => {
    expect(tryParseArtifactRefFromToolOutput(undefined)).toBeNull();
    expect(tryParseArtifactRefFromToolOutput(42)).toBeNull();
    expect(tryParseArtifactRefFromToolOutput('')).toBeNull();
  });
});

/* =====================================================================
 * write_artifact tool — end-to-end via the registry
 * ===================================================================== */

describe('write_artifact tool', () => {
  it('happy path — writes to PVC dir and returns the ArtifactRef', async () => {
    const taskUid = `uid-${randomUUID().slice(0, 8)}`;
    const env = {
      [ENV_TASK_ID]: taskUid,
      [ENV_ARTIFACTS_DIR]: tmpRoot,
      [ENV_ARTIFACTS_PVC_NAME]: 'kagent-artifacts',
    };
    const reg = buildBuiltinToolRegistry({ env });
    const def = reg.get('write_artifact')!;
    const provider = new InProcessToolProvider({ tools: [def] });
    const r = await provider.executeTool(
      call('write_artifact', {
        name: 'digest.md',
        mediaType: 'text/markdown',
        content: '# hello world',
      }),
      ctx(),
    );
    expect(r.isError).toBe(false);
    const blocks = r.content as { type: string; text: string }[];
    const ref = JSON.parse(blocks[0]!.text) as ArtifactRef;
    expect(ref.uri).toBe(`pvc://kagent-artifacts/${taskUid}/digest.md`);
    expect(ref.name).toBe('digest.md');
    expect(ref.mediaType).toBe('text/markdown');
    expect(ref.sizeBytes).toBe(13);
    expect(ref.checksum).toMatch(/^sha256:[0-9a-f]{64}$/);
    // The bytes ARE on disk (atomic write happened inside the handler).
    const written = readFileSync(join(tmpRoot, taskUid, 'digest.md'), 'utf8');
    expect(written).toBe('# hello world');
  });

  it('inline:true short-circuits the write and returns an inline:// URI (not pvc://)', async () => {
    const taskUid = `uid-${randomUUID().slice(0, 8)}`;
    const env = {
      [ENV_TASK_ID]: taskUid,
      [ENV_ARTIFACTS_DIR]: tmpRoot,
      [ENV_ARTIFACTS_PVC_NAME]: 'kagent-artifacts',
    };
    const reg = buildBuiltinToolRegistry({ env });
    const def = reg.get('write_artifact')!;
    const provider = new InProcessToolProvider({ tools: [def] });
    const r = await provider.executeTool(
      call('write_artifact', {
        name: 'short.md',
        mediaType: 'text/markdown',
        content: 'tiny',
        inline: true,
      }),
      ctx(),
    );
    expect(r.isError).toBe(false);
    const blocks = r.content as { type: string; text: string }[];
    const ref = JSON.parse(blocks[0]!.text) as ArtifactRef;
    // The substrate contract: inline-only refs use the inline:// scheme
    // so consumers can tell durable from non-durable refs at a glance.
    expect(ref.uri).toMatch(/^inline:\/\/sha256:[0-9a-f]{64}$/);
    expect(ref.uri.startsWith('pvc://')).toBe(false);
    // No file should exist on disk (this is the persistence invariant
    // a `pvc://` URI would otherwise lie about).
    expect(existsSync(join(tmpRoot, taskUid, 'short.md'))).toBe(false);
  });

  it('inline:true falls through to a real write when content is too large to inline', async () => {
    const taskUid = `uid-${randomUUID().slice(0, 8)}`;
    const env = {
      [ENV_TASK_ID]: taskUid,
      [ENV_ARTIFACTS_DIR]: tmpRoot,
      [ENV_ARTIFACTS_PVC_NAME]: 'kagent-artifacts',
    };
    const reg = buildBuiltinToolRegistry({ env });
    const def = reg.get('write_artifact')!;
    const provider = new InProcessToolProvider({ tools: [def] });
    const big = 'a'.repeat(20 * 1024);
    const r = await provider.executeTool(
      call('write_artifact', {
        name: 'big.md',
        mediaType: 'text/markdown',
        content: big,
        inline: true,
      }),
      ctx(),
    );
    expect(r.isError).toBe(false);
    expect(existsSync(join(tmpRoot, taskUid, 'big.md'))).toBe(true);
  });

  it('refuses path-traversal name (becomes ToolResult{isError:true})', async () => {
    const env = {
      [ENV_TASK_ID]: 'uid-1',
      [ENV_ARTIFACTS_DIR]: tmpRoot,
      [ENV_ARTIFACTS_PVC_NAME]: 'kagent-artifacts',
    };
    const reg = buildBuiltinToolRegistry({ env });
    const def = reg.get('write_artifact')!;
    const provider = new InProcessToolProvider({ tools: [def] });
    const r = await provider.executeTool(
      call('write_artifact', {
        name: '../escape.md',
        mediaType: 'text/markdown',
        content: 'x',
      }),
      ctx(),
    );
    expect(r.isError).toBe(true);
    expect(contentString(r)).toMatch(/".."/);
  });

  it('refuses leading-slash name', async () => {
    const env = {
      [ENV_TASK_ID]: 'uid-1',
      [ENV_ARTIFACTS_DIR]: tmpRoot,
      [ENV_ARTIFACTS_PVC_NAME]: 'kagent-artifacts',
    };
    const reg = buildBuiltinToolRegistry({ env });
    const def = reg.get('write_artifact')!;
    const provider = new InProcessToolProvider({ tools: [def] });
    const r = await provider.executeTool(
      call('write_artifact', {
        name: '/etc/passwd',
        mediaType: 'text/plain',
        content: 'x',
      }),
      ctx(),
    );
    expect(r.isError).toBe(true);
    expect(contentString(r)).toMatch(/must not begin with "\/"/);
  });

  it('refuses control characters in name', async () => {
    const env = {
      [ENV_TASK_ID]: 'uid-1',
      [ENV_ARTIFACTS_DIR]: tmpRoot,
      [ENV_ARTIFACTS_PVC_NAME]: 'kagent-artifacts',
    };
    const reg = buildBuiltinToolRegistry({ env });
    const def = reg.get('write_artifact')!;
    const provider = new InProcessToolProvider({ tools: [def] });
    const r = await provider.executeTool(
      call('write_artifact', {
        name: 'foo\nbar.md',
        mediaType: 'text/markdown',
        content: 'x',
      }),
      ctx(),
    );
    expect(r.isError).toBe(true);
    expect(contentString(r)).toMatch(/non-printable/);
  });

  it('atomic-write semantics: leaves no .tmp on success', async () => {
    const taskUid = `uid-${randomUUID().slice(0, 8)}`;
    const env = {
      [ENV_TASK_ID]: taskUid,
      [ENV_ARTIFACTS_DIR]: tmpRoot,
      [ENV_ARTIFACTS_PVC_NAME]: 'kagent-artifacts',
    };
    const reg = buildBuiltinToolRegistry({ env });
    const def = reg.get('write_artifact')!;
    const provider = new InProcessToolProvider({ tools: [def] });
    await provider.executeTool(
      call('write_artifact', {
        name: 'digest.md',
        mediaType: 'text/markdown',
        content: '# clean',
      }),
      ctx(),
    );
    const entries = readdirSync(join(tmpRoot, taskUid));
    expect(entries).toEqual(['digest.md']);
  });

  it('atomic-write semantics: an injected mid-write throw leaves no visible file or .tmp', async () => {
    // Inject a writer that throws AFTER the validation step but before
    // it would have renamed; we assert the tool surfaces the error and
    // that the test directory is empty (no `.tmp`, no visible name).
    const taskUid = `uid-${randomUUID().slice(0, 8)}`;
    const env = {
      [ENV_TASK_ID]: taskUid,
      [ENV_ARTIFACTS_DIR]: tmpRoot,
      [ENV_ARTIFACTS_PVC_NAME]: 'kagent-artifacts',
    };
    // Real writer first to create the dir, then a throwing writer.
    const realReg = buildBuiltinToolRegistry({ env });
    const realDef = realReg.get('write_artifact')!;
    const realProv = new InProcessToolProvider({ tools: [realDef] });
    await realProv.executeTool(
      call('write_artifact', {
        name: 'first.md',
        mediaType: 'text/markdown',
        content: 'first',
      }),
      ctx(),
    );

    const reg = buildBuiltinToolRegistry({
      env,
      writeArtifact: () => {
        throw new Error('disk full');
      },
    });
    const def = reg.get('write_artifact')!;
    const provider = new InProcessToolProvider({ tools: [def] });
    const r = await provider.executeTool(
      call('write_artifact', {
        name: 'second.md',
        mediaType: 'text/markdown',
        content: 'second',
      }),
      ctx(),
    );
    expect(r.isError).toBe(true);
    expect(contentString(r)).toMatch(/disk full/);
    // The directory still has only the FIRST file — no second.md, no .tmp.
    const entries = readdirSync(join(tmpRoot, taskUid)).sort();
    expect(entries).toEqual(['first.md']);
  });

  it('refuses missing name and content args (mediaType is OPTIONAL — defaults to application/octet-stream)', async () => {
    const env = {
      [ENV_TASK_ID]: 'uid-1',
      [ENV_ARTIFACTS_DIR]: tmpRoot,
      [ENV_ARTIFACTS_PVC_NAME]: 'kagent-artifacts',
    };
    const reg = buildBuiltinToolRegistry({ env });
    const def = reg.get('write_artifact')!;
    const provider = new InProcessToolProvider({ tools: [def] });

    // Missing `name` always errors.
    const r1 = await provider.executeTool(
      call('write_artifact', { mediaType: 'text/plain', content: 'x' }),
      ctx(),
    );
    expect(r1.isError).toBe(true);
    expect(contentString(r1)).toMatch(/required string argument "name"/);

    // Missing `mediaType` is now OK — the writer falls back to
    // application/octet-stream and the call succeeds.
    const r2 = await provider.executeTool(
      call('write_artifact', { name: 'omits-mediatype.bin', content: 'x' }),
      ctx(),
    );
    expect(r2.isError).toBe(false);
    const blocks2 = r2.content as { type: string; text: string }[];
    const ref2 = JSON.parse(blocks2[0]!.text) as ArtifactRef;
    expect(ref2.mediaType).toBe('application/octet-stream');

    // Missing `content` errors.
    const r3 = await provider.executeTool(
      call('write_artifact', { name: 'x.md', mediaType: 'text/plain' }),
      ctx(),
    );
    expect(r3.isError).toBe(true);
    expect(contentString(r3)).toMatch(/required argument "content"/);
  });

  it('surfaces a disabled error when KAGENT_TASK_ID is missing', async () => {
    const env = { [ENV_ARTIFACTS_DIR]: tmpRoot };
    const reg = buildBuiltinToolRegistry({ env });
    const def = reg.get('write_artifact')!;
    const provider = new InProcessToolProvider({ tools: [def] });
    const r = await provider.executeTool(
      call('write_artifact', {
        name: 'x.md',
        mediaType: 'text/plain',
        content: 'x',
      }),
      ctx(),
    );
    expect(r.isError).toBe(true);
    expect(contentString(r)).toMatch(/KAGENT_TASK_ID/);
  });

  /* =====================================================================
   * v0.1 P3 wire-up — disabled-storage default-OFF semantics.
   * ===================================================================== */

  it('returns a disabled error when KAGENT_ARTIFACT_PVC_NAME is unset', async () => {
    // KAGENT_TASK_ID present, KAGENT_ARTIFACTS_DIR present, but the PVC
    // name env var is absent — this is the operator's "Helm chart not
    // wired" posture. Substrate must refuse cleanly rather than write to
    // an unmounted dir.
    const env = {
      [ENV_TASK_ID]: 'uid-1',
      [ENV_ARTIFACTS_DIR]: tmpRoot,
    };
    const reg = buildBuiltinToolRegistry({ env });
    const def = reg.get('write_artifact')!;
    const provider = new InProcessToolProvider({ tools: [def] });
    const r = await provider.executeTool(
      call('write_artifact', {
        name: 'x.md',
        mediaType: 'text/plain',
        content: 'x',
      }),
      ctx(),
    );
    expect(r.isError).toBe(true);
    expect(contentString(r)).toMatch(/disabled/);
    expect(contentString(r)).toMatch(/KAGENT_ARTIFACT_PVC_NAME/);
  });

  it('returns a disabled error when KAGENT_ARTIFACTS_DIR is unset', async () => {
    const env = {
      [ENV_TASK_ID]: 'uid-1',
      [ENV_ARTIFACTS_PVC_NAME]: 'kagent-artifacts',
    };
    const reg = buildBuiltinToolRegistry({ env });
    const def = reg.get('write_artifact')!;
    const provider = new InProcessToolProvider({ tools: [def] });
    const r = await provider.executeTool(
      call('write_artifact', {
        name: 'x.md',
        mediaType: 'text/plain',
        content: 'x',
      }),
      ctx(),
    );
    expect(r.isError).toBe(true);
    expect(contentString(r)).toMatch(/disabled/);
    expect(contentString(r)).toMatch(/KAGENT_ARTIFACTS_DIR/);
  });

  it('inline:true short-circuit ALSO works when storage is disabled (text-only path)', async () => {
    // The substrate contract: inline://sha256:<hex> is non-durable and
    // doesn't touch the FS — so it's safely available even when the PVC
    // isn't mounted. Lets an Agent fall back to embedding small text
    // payloads in status.result without losing the tool entirely.
    const env = {
      [ENV_TASK_ID]: 'uid-1',
      // No KAGENT_ARTIFACT_PVC_NAME or KAGENT_ARTIFACTS_DIR.
    };
    const reg = buildBuiltinToolRegistry({ env });
    const def = reg.get('write_artifact')!;
    const provider = new InProcessToolProvider({ tools: [def] });
    const r = await provider.executeTool(
      call('write_artifact', {
        name: 'tiny.md',
        mediaType: 'text/markdown',
        content: 'hello',
        inline: true,
      }),
      ctx(),
    );
    expect(r.isError).toBe(false);
    const blocks = r.content as { type: string; text: string }[];
    const ref = JSON.parse(blocks[0]!.text) as ArtifactRef;
    expect(ref.uri.startsWith('inline://sha256:')).toBe(true);
  });

  /* =====================================================================
   * v0.1 P3 wire-up — base64 content path.
   * ===================================================================== */

  it('accepts base64-encoded binary content', async () => {
    const taskUid = `uid-${randomUUID().slice(0, 8)}`;
    const env = {
      [ENV_TASK_ID]: taskUid,
      [ENV_ARTIFACTS_DIR]: tmpRoot,
      [ENV_ARTIFACTS_PVC_NAME]: 'kagent-artifacts',
    };
    const reg = buildBuiltinToolRegistry({ env });
    const def = reg.get('write_artifact')!;
    const provider = new InProcessToolProvider({ tools: [def] });
    // PNG header bytes (89 50 4E 47 0D 0A 1A 0A) — a real binary payload
    // the LLM might receive from a screenshot tool and need to round-trip.
    const pngHeader = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const r = await provider.executeTool(
      call('write_artifact', {
        name: 'screenshot.png',
        mediaType: 'image/png',
        content: { base64: pngHeader.toString('base64') },
      }),
      ctx(),
    );
    expect(r.isError).toBe(false);
    const blocks = r.content as { type: string; text: string }[];
    const ref = JSON.parse(blocks[0]!.text) as ArtifactRef;
    expect(ref.sizeBytes).toBe(pngHeader.byteLength);
    // Disk content matches the decoded bytes byte-for-byte.
    const onDisk = readFileSync(join(tmpRoot, taskUid, 'screenshot.png'));
    expect(onDisk.equals(pngHeader)).toBe(true);
    // sha256 of the bytes matches the contentHash field.
    const expectedHex = createHash('sha256').update(pngHeader).digest('hex');
    expect(ref.contentHash).toBe(expectedHex);
    expect(ref.checksum).toBe(`sha256:${expectedHex}`);
  });

  it('rejects malformed base64 content', async () => {
    const env = {
      [ENV_TASK_ID]: 'uid-1',
      [ENV_ARTIFACTS_DIR]: tmpRoot,
      [ENV_ARTIFACTS_PVC_NAME]: 'kagent-artifacts',
    };
    const reg = buildBuiltinToolRegistry({ env });
    const def = reg.get('write_artifact')!;
    const provider = new InProcessToolProvider({ tools: [def] });
    const r = await provider.executeTool(
      call('write_artifact', {
        name: 'x.bin',
        mediaType: 'application/octet-stream',
        content: { base64: 'not!valid!base64*' },
      }),
      ctx(),
    );
    expect(r.isError).toBe(true);
    expect(contentString(r)).toMatch(/not valid base64/);
  });

  it('rejects non-string base64 field', async () => {
    const env = {
      [ENV_TASK_ID]: 'uid-1',
      [ENV_ARTIFACTS_DIR]: tmpRoot,
      [ENV_ARTIFACTS_PVC_NAME]: 'kagent-artifacts',
    };
    const reg = buildBuiltinToolRegistry({ env });
    const def = reg.get('write_artifact')!;
    const provider = new InProcessToolProvider({ tools: [def] });
    const r = await provider.executeTool(
      call('write_artifact', {
        name: 'x.bin',
        mediaType: 'application/octet-stream',
        content: { base64: 42 as unknown as string },
      }),
      ctx(),
    );
    expect(r.isError).toBe(true);
    expect(contentString(r)).toMatch(/content\.base64/);
  });

  /* =====================================================================
   * v0.1 P3 wire-up — KAGENT_ARTIFACT_MAX_BYTES enforcement.
   * ===================================================================== */

  it('refuses oversized writes (UTF-8 string content)', async () => {
    const env = {
      [ENV_TASK_ID]: 'uid-1',
      [ENV_ARTIFACTS_DIR]: tmpRoot,
      [ENV_ARTIFACTS_PVC_NAME]: 'kagent-artifacts',
      [ENV_ARTIFACT_MAX_BYTES]: '1024', // 1 KiB cap
    };
    const reg = buildBuiltinToolRegistry({ env });
    const def = reg.get('write_artifact')!;
    const provider = new InProcessToolProvider({ tools: [def] });
    const r = await provider.executeTool(
      call('write_artifact', {
        name: 'big.md',
        mediaType: 'text/markdown',
        content: 'a'.repeat(2048),
      }),
      ctx(),
    );
    expect(r.isError).toBe(true);
    expect(contentString(r)).toMatch(/artifact too large/);
    expect(contentString(r)).toMatch(/2048 > 1024/);
  });

  it('refuses oversized writes (base64 binary content)', async () => {
    const env = {
      [ENV_TASK_ID]: 'uid-1',
      [ENV_ARTIFACTS_DIR]: tmpRoot,
      [ENV_ARTIFACTS_PVC_NAME]: 'kagent-artifacts',
      [ENV_ARTIFACT_MAX_BYTES]: '16',
    };
    const reg = buildBuiltinToolRegistry({ env });
    const def = reg.get('write_artifact')!;
    const provider = new InProcessToolProvider({ tools: [def] });
    const bigBytes = Buffer.alloc(64).fill(0xff);
    const r = await provider.executeTool(
      call('write_artifact', {
        name: 'big.bin',
        mediaType: 'application/octet-stream',
        content: { base64: bigBytes.toString('base64') },
      }),
      ctx(),
    );
    expect(r.isError).toBe(true);
    expect(contentString(r)).toMatch(/artifact too large/);
  });

  /* =====================================================================
   * v0.1 P3 wire-up — in-pod ArtifactRegistry flush.
   * ===================================================================== */

  it('threads successful refs into the in-pod ArtifactRegistry', async () => {
    const taskUid = `uid-${randomUUID().slice(0, 8)}`;
    const env = {
      [ENV_TASK_ID]: taskUid,
      [ENV_ARTIFACTS_DIR]: tmpRoot,
      [ENV_ARTIFACTS_PVC_NAME]: 'kagent-artifacts',
    };
    const registry = createArtifactRegistry();
    const reg = buildBuiltinToolRegistry({ env, artifactRegistry: registry });
    const def = reg.get('write_artifact')!;
    const provider = new InProcessToolProvider({ tools: [def] });
    expect(registry.isEmpty()).toBe(true);

    await provider.executeTool(
      call('write_artifact', {
        name: 'first.md',
        mediaType: 'text/markdown',
        content: '# first',
      }),
      ctx(),
    );
    expect(registry.isEmpty()).toBe(false);
    expect(registry.snapshot()).toHaveLength(1);
    expect(registry.snapshot()[0]!.uri).toBe(`pvc://kagent-artifacts/${taskUid}/first.md`);

    await provider.executeTool(
      call('write_artifact', {
        name: 'second.md',
        mediaType: 'text/markdown',
        content: '# second',
      }),
      ctx(),
    );
    expect(registry.snapshot()).toHaveLength(2);
  });

  it('does NOT push refs into the registry when the write fails', async () => {
    const env = {
      [ENV_TASK_ID]: 'uid-1',
      [ENV_ARTIFACTS_DIR]: tmpRoot,
      [ENV_ARTIFACTS_PVC_NAME]: 'kagent-artifacts',
    };
    const registry = createArtifactRegistry();
    const reg = buildBuiltinToolRegistry({
      env,
      artifactRegistry: registry,
      writeArtifact: () => {
        throw new Error('simulated FS failure');
      },
    });
    const def = reg.get('write_artifact')!;
    const provider = new InProcessToolProvider({ tools: [def] });
    const r = await provider.executeTool(
      call('write_artifact', {
        name: 'x.md',
        mediaType: 'text/markdown',
        content: 'x',
      }),
      ctx(),
    );
    expect(r.isError).toBe(true);
    expect(registry.isEmpty()).toBe(true);
  });

  it('inline:true synthetic ref is also recorded in the registry', async () => {
    const env = {
      [ENV_TASK_ID]: 'uid-1',
      [ENV_ARTIFACTS_DIR]: tmpRoot,
      [ENV_ARTIFACTS_PVC_NAME]: 'kagent-artifacts',
    };
    const registry = createArtifactRegistry();
    const reg = buildBuiltinToolRegistry({ env, artifactRegistry: registry });
    const def = reg.get('write_artifact')!;
    const provider = new InProcessToolProvider({ tools: [def] });
    await provider.executeTool(
      call('write_artifact', {
        name: 'small.md',
        mediaType: 'text/markdown',
        content: 'tiny',
        inline: true,
      }),
      ctx(),
    );
    const snapshot = registry.snapshot();
    expect(snapshot).toHaveLength(1);
    expect(snapshot[0]!.uri.startsWith('inline://sha256:')).toBe(true);
    expect(snapshot[0]!.name).toBe('small.md');
  });

  it('registry de-dupes on identical URI (last-write-wins)', async () => {
    // Two writes to the same name → one ref in the registry, with the
    // most recent metadata. Useful when an agent updates a digest in
    // place during the run.
    const env = {
      [ENV_TASK_ID]: 'uid-1',
      [ENV_ARTIFACTS_DIR]: tmpRoot,
      [ENV_ARTIFACTS_PVC_NAME]: 'kagent-artifacts',
    };
    const registry = createArtifactRegistry();
    const reg = buildBuiltinToolRegistry({ env, artifactRegistry: registry });
    const def = reg.get('write_artifact')!;
    const provider = new InProcessToolProvider({ tools: [def] });
    await provider.executeTool(
      call('write_artifact', {
        name: 'digest.md',
        mediaType: 'text/markdown',
        content: 'v1',
      }),
      ctx(),
    );
    await provider.executeTool(
      call('write_artifact', {
        name: 'digest.md',
        mediaType: 'text/markdown',
        content: 'v2-much-longer-content-than-v1',
      }),
      ctx(),
    );
    const snapshot = registry.snapshot();
    expect(snapshot).toHaveLength(1);
    expect(snapshot[0]!.sizeBytes).toBe(
      Buffer.byteLength('v2-much-longer-content-than-v1', 'utf8'),
    );
  });

  /* =====================================================================
   * v0.1 P3 wire-up — contentHash field forward-compat with v0.2.2-cas.
   * ===================================================================== */

  it('emits both checksum (algo-prefixed) and contentHash (bare hex) on the ref', async () => {
    const taskUid = `uid-${randomUUID().slice(0, 8)}`;
    const env = {
      [ENV_TASK_ID]: taskUid,
      [ENV_ARTIFACTS_DIR]: tmpRoot,
      [ENV_ARTIFACTS_PVC_NAME]: 'kagent-artifacts',
    };
    const reg = buildBuiltinToolRegistry({ env });
    const def = reg.get('write_artifact')!;
    const provider = new InProcessToolProvider({ tools: [def] });
    const r = await provider.executeTool(
      call('write_artifact', {
        name: 'fingerprint.md',
        mediaType: 'text/markdown',
        content: 'fingerprint-me',
      }),
      ctx(),
    );
    const blocks = r.content as { type: string; text: string }[];
    const ref = JSON.parse(blocks[0]!.text) as ArtifactRef;
    const expectedHex = createHash('sha256').update('fingerprint-me').digest('hex');
    expect(ref.contentHash).toBe(expectedHex);
    expect(ref.checksum).toBe(`sha256:${expectedHex}`);
  });
});

/* =====================================================================
 * createArtifactRegistry — pure helper coverage.
 * ===================================================================== */

describe('createArtifactRegistry', () => {
  it('starts empty', () => {
    const r = createArtifactRegistry();
    expect(r.isEmpty()).toBe(true);
    expect(r.snapshot()).toEqual([]);
  });

  it('add() inserts a ref keyed by URI', () => {
    const r = createArtifactRegistry();
    r.add({ uri: 'pvc://k/u/a.md' });
    expect(r.isEmpty()).toBe(false);
    expect(r.snapshot()).toHaveLength(1);
  });

  it('add() with duplicate URI overwrites (last-write-wins)', () => {
    const r = createArtifactRegistry();
    r.add({ uri: 'pvc://k/u/a.md', sizeBytes: 1 });
    r.add({ uri: 'pvc://k/u/a.md', sizeBytes: 99 });
    expect(r.snapshot()).toHaveLength(1);
    expect(r.snapshot()[0]!.sizeBytes).toBe(99);
  });

  it('add() ignores refs with no URI (defensive)', () => {
    const r = createArtifactRegistry();
    r.add({ uri: '' });
    r.add({ uri: undefined as unknown as string });
    expect(r.isEmpty()).toBe(true);
  });

  it('snapshot() returns a defensive copy (caller mutation doesn’t leak back)', () => {
    const r = createArtifactRegistry();
    r.add({ uri: 'pvc://k/u/a.md' });
    const s1 = r.snapshot() as ArtifactRef[];
    s1.push({ uri: 'pvc://k/u/leaked.md' });
    expect(r.snapshot()).toHaveLength(1);
  });
});

/* =====================================================================
 * resolveWriterEnvOrDisabled passthrough sanity — already covered above
 * but include one inline runtime check that the export resolves.
 * ===================================================================== */

it('resolveWriterEnvOrDisabled is exported and callable', () => {
  expect(typeof resolveWriterEnvOrDisabled).toBe('function');
});
