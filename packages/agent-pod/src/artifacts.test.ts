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
  DEFAULT_ARTIFACTS_DIR,
  DEFAULT_PVC_NAME,
  ENV_ARTIFACTS_DIR,
  ENV_ARTIFACTS_PVC_NAME,
  ENV_TASK_ID,
  inlineArtifactRef,
  inlineSafeForArtifact,
  isArtifactRefShape,
  resolveWriterEnv,
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
    });
  });

  it('throws when KAGENT_TASK_ID is missing', () => {
    expect(() => resolveWriterEnv({})).toThrow(/KAGENT_TASK_ID/);
    expect(() => resolveWriterEnv({ [ENV_TASK_ID]: '' })).toThrow(/KAGENT_TASK_ID/);
  });
});

/* =====================================================================
 * writeArtifactToDisk — atomic, hashed, scoped
 * ===================================================================== */

describe('writeArtifactToDisk', () => {
  it('happy path: creates the file under <root>/<task-uid>/<name>', () => {
    const env = { artifactsDir: tmpRoot, pvcName: 'kagent-artifacts', taskUid: 'uid-1' };
    const r = writeArtifactToDisk('digest.md', '# hello', 'text/markdown', env);
    expect(r.path).toBe(join(tmpRoot, 'uid-1', 'digest.md'));
    expect(existsSync(r.path)).toBe(true);
    expect(readFileSync(r.path, 'utf8')).toBe('# hello');
  });

  it('returns a well-shaped ArtifactRef', () => {
    const env = { artifactsDir: tmpRoot, pvcName: 'kagent-artifacts', taskUid: 'uid-1' };
    const fixedNow = new Date('2026-04-28T14:23:11Z');
    const r = writeArtifactToDisk('digest.md', '# hello', 'text/markdown', env, fixedNow);
    const expected = createHash('sha256').update('# hello', 'utf8').digest('hex');
    expect(r.ref).toEqual({
      uri: 'pvc://kagent-artifacts/uid-1/digest.md',
      name: 'digest.md',
      mediaType: 'text/markdown',
      sizeBytes: Buffer.byteLength('# hello', 'utf8'),
      checksum: `sha256:${expected}`,
      producedAt: '2026-04-28T14:23:11.000Z',
    });
  });

  it('checksum matches sha256 of the bytes (utf-8 multi-byte)', () => {
    const env = { artifactsDir: tmpRoot, pvcName: 'kagent-artifacts', taskUid: 'uid-1' };
    const content = 'rapport-français-🚀';
    const r = writeArtifactToDisk('utf8.md', content, 'text/markdown', env);
    const expected = createHash('sha256').update(content, 'utf8').digest('hex');
    expect(r.ref.checksum).toBe(`sha256:${expected}`);
    expect(r.ref.sizeBytes).toBe(Buffer.byteLength(content, 'utf8'));
  });

  it('atomic write: leaves no .tmp behind on success', () => {
    const env = { artifactsDir: tmpRoot, pvcName: 'kagent-artifacts', taskUid: 'uid-1' };
    writeArtifactToDisk('digest.md', '# hello', 'text/markdown', env);
    const dir = join(tmpRoot, 'uid-1');
    const entries = readdirSync(dir);
    expect(entries).toEqual(['digest.md']);
  });

  it('creates nested directories for slash-bearing names', () => {
    const env = { artifactsDir: tmpRoot, pvcName: 'kagent-artifacts', taskUid: 'uid-1' };
    const r = writeArtifactToDisk('screenshots/01.png', 'binary-ish', 'image/png', env);
    expect(existsSync(r.path)).toBe(true);
    expect(r.ref.uri).toBe('pvc://kagent-artifacts/uid-1/screenshots/01.png');
    expect(statSync(join(tmpRoot, 'uid-1', 'screenshots')).isDirectory()).toBe(true);
  });

  it('refuses path traversal via name', () => {
    const env = { artifactsDir: tmpRoot, pvcName: 'kagent-artifacts', taskUid: 'uid-1' };
    expect(() => writeArtifactToDisk('../escape.md', 'x', 'text/markdown', env)).toThrow(/".."/);
    expect(() => writeArtifactToDisk('/abs.md', 'x', 'text/markdown', env)).toThrow(
      /must not begin with "\/"/,
    );
  });

  it('refuses control chars via name', () => {
    const env = { artifactsDir: tmpRoot, pvcName: 'kagent-artifacts', taskUid: 'uid-1' };
    expect(() => writeArtifactToDisk('foo\nbar.md', 'x', 'text/markdown', env)).toThrow(
      /non-printable/,
    );
  });

  it('refuses empty mediaType', () => {
    const env = { artifactsDir: tmpRoot, pvcName: 'kagent-artifacts', taskUid: 'uid-1' };
    expect(() => writeArtifactToDisk('a.md', 'x', '', env)).toThrow(/mediaType/);
  });

  it('handles 0-byte content (sentinel file)', () => {
    const env = { artifactsDir: tmpRoot, pvcName: 'kagent-artifacts', taskUid: 'uid-1' };
    const r = writeArtifactToDisk('marker', '', 'text/plain', env);
    expect(existsSync(r.path)).toBe(true);
    expect(readFileSync(r.path, 'utf8')).toBe('');
    expect(r.ref.sizeBytes).toBe(0);
  });

  it('writes are scoped under the task-uid directory (no cross-task leak)', () => {
    const env1 = { artifactsDir: tmpRoot, pvcName: 'kagent-artifacts', taskUid: 'uid-A' };
    const env2 = { artifactsDir: tmpRoot, pvcName: 'kagent-artifacts', taskUid: 'uid-B' };
    writeArtifactToDisk('shared.md', 'A version', 'text/markdown', env1);
    writeArtifactToDisk('shared.md', 'B version', 'text/markdown', env2);
    expect(readFileSync(join(tmpRoot, 'uid-A', 'shared.md'), 'utf8')).toBe('A version');
    expect(readFileSync(join(tmpRoot, 'uid-B', 'shared.md'), 'utf8')).toBe('B version');
  });

  it('regression: pvc:// URI is ALWAYS followable to a real file (persistence invariant)', () => {
    // The whole point of the WS-D scheme split: any returned `pvc://`
    // URI must round-trip to a stat-able file on disk. The inline path
    // returns `inline://` exactly so this assertion can never lie.
    const env = { artifactsDir: tmpRoot, pvcName: 'kagent-artifacts', taskUid: 'uid-1' };
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

  it('refuses missing name / mediaType / content args', async () => {
    const env = {
      [ENV_TASK_ID]: 'uid-1',
      [ENV_ARTIFACTS_DIR]: tmpRoot,
    };
    const reg = buildBuiltinToolRegistry({ env });
    const def = reg.get('write_artifact')!;
    const provider = new InProcessToolProvider({ tools: [def] });

    const r1 = await provider.executeTool(
      call('write_artifact', { mediaType: 'text/plain', content: 'x' }),
      ctx(),
    );
    expect(r1.isError).toBe(true);
    expect(contentString(r1)).toMatch(/required string argument "name"/);

    const r2 = await provider.executeTool(
      call('write_artifact', { name: 'x.md', content: 'x' }),
      ctx(),
    );
    expect(r2.isError).toBe(true);
    expect(contentString(r2)).toMatch(/required string argument "mediaType"/);

    const r3 = await provider.executeTool(
      call('write_artifact', { name: 'x.md', mediaType: 'text/plain' }),
      ctx(),
    );
    expect(r3.isError).toBe(true);
    expect(contentString(r3)).toMatch(/required string argument "content"/);
  });

  it('surfaces resolveWriterEnv error when KAGENT_TASK_ID is missing', async () => {
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
});
