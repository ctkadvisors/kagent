/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

import { createHash } from 'node:crypto';
import type { StoredToolResult } from './tool-result-reference.js';
const unavailable = () => new Error('check publication unavailable');
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);

/** Resolve only a complete pinned check envelope; never infer a result from prose. */
export function checkPublication(source: StoredToolResult): {
  body: string;
  metadata: Record<string, unknown>;
} {
  const ref = source.reference;
  if (
    ref.encoding !== 'utf8-provider-content' ||
    !['fleet.run_tool', 'fleet.run_capability'].includes(ref.sourceTool)
  )
    throw unavailable();
  const result: unknown = JSON.parse(source.content);
  if (
    !object(result) ||
    !object(source.arguments) ||
    !Number.isSafeInteger(result.exit) ||
    (result.exit as number) < 0 ||
    result.timedOut !== false ||
    result.outputComplete !== true ||
    typeof result.stdout !== 'string' ||
    typeof result.folder !== 'string' ||
    typeof result.run !== 'string' ||
    typeof result.sha !== 'string' ||
    !/^[a-f0-9]{40}$/.test(result.sha)
  )
    throw unavailable();
  const keys =
    ref.sourceTool === 'fleet.run_tool'
      ? ['folder', 'sha', 'run']
      : ['template', 'sha', 'revision'];
  if (
    keys.some(
      (key) =>
        source.arguments && (source.arguments as Record<string, unknown>)[key] !== result[key],
    )
  )
    throw unavailable();
  const stdout = result.stdout;
  const header = stdout.split('\n', 1)[0]!;
  const exit = /: exit (\d+)\b/.exec(header);
  if (!exit || Number(exit[1]) !== result.exit) throw unavailable();
  const selected = firstObject(stdout);
  const proof = {
    schema: 'fleet-check-publication/v1',
    source_task: ref.taskUid,
    source_operation: ref.operationId,
    source_tool: ref.sourceTool,
    source_result_sha256: ref.artifact.contentHash,
    source_stdout_sha256: hash(stdout),
    source_arguments_sha256: ref.sourceArgumentsHash,
    pin: result.sha,
    received_at: ref.receivedAt,
  };
  const footer =
    '\n\nSource receipt (ephemeral source; retain evidence separately):\n' + JSON.stringify(proof);
  let body = stdout + footer;
  let format = 'full-stdout';
  if ([...body].length > 8000) {
    format = 'numeric-projection';
    body =
      header +
      '\n\n' +
      project(selected) +
      '\n\nNumeric projection: strings and nonnumeric list entries are omitted; original nulls and numeric parser values are preserved.' +
      footer;
  }
  if ([...body].length > 8000) throw unavailable();
  return { body, metadata: { ...proof, format, body_sha256: hash(body) } };
}

type Node =
  | { kind: 'object'; entries: Array<{ key: string; value: Node }> }
  | { kind: 'array'; items: Node[] }
  | { kind: 'number' | 'boolean' | 'null' | 'string'; raw: string };
/** Keep raw numeric lexemes and member order: Python owns precision, list means and MAX_VALUES. */
function project(node: Node): string {
  if (node.kind === 'object')
    return (
      '{' +
      node.entries
        .filter((entry) => entry.value.kind !== 'string')
        .map((entry) => entry.key + ':' + project(entry.value))
        .join(',') +
      '}'
    );
  if (node.kind === 'array') {
    if (!node.items.some((item) => item.kind === 'number'))
      return '{"count":' + node.items.length + '}';
    return (
      '[' + node.items.map((item) => (item.kind === 'number' ? item.raw : 'null')).join(',') + ']'
    );
  }
  return node.raw;
}

/** Match the protected parser's bounded first balanced-object scan; no new scoring rules. */
function firstObject(stdout: string): Node {
  const text = [...stdout].slice(0, 64 * 1024).join('');
  let start = text.indexOf('{');
  while (start >= 0) {
    let depth = 0;
    for (let i = start; i < text.length; i++) {
      if (text[i] === '{') depth++;
      else if (text[i] === '}' && --depth === 0) {
        const candidate = text.slice(start, i + 1);
        let parsed: unknown;
        try {
          parsed = JSON.parse(candidate);
        } catch {
          break;
        }
        if (!object(parsed)) throw unavailable();
        // Once the ruler's first valid object is selected, semantic ambiguity
        // refuses publication; it must never select a later nested object.
        return parseNode(candidate);
      }
    }
    start = text.indexOf('{', start + 1);
  }
  throw unavailable();
}

/** A structural JSON reader, not a numeric evaluator. Duplicated keys/deep ambiguity refuse. */
function parseNode(text: string): Node {
  let at = 0;
  const whitespace = () => {
    while (/\s/.test(text[at] ?? '') && at < text.length) at++;
  };
  const string = (): string => {
    const start = at++;
    while (at < text.length) {
      if (text[at++] === '\\') at++;
      else if (text[at - 1] === '"') return text.slice(start, at);
    }
    throw unavailable();
  };
  const value = (depth: number): Node => {
    if (depth > 100) throw unavailable();
    whitespace();
    if (text[at] === '{') {
      at++;
      whitespace();
      const entries: Array<{ key: string; value: Node }> = [];
      const seen = new Set<string>();
      while (text[at] !== '}') {
        if (text[at] !== '"') throw unavailable();
        const key = string();
        const decoded = JSON.parse(key) as string;
        if (seen.has(decoded)) throw unavailable();
        seen.add(decoded);
        whitespace();
        if (text[at++] !== ':') throw unavailable();
        entries.push({ key, value: value(depth + 1) });
        whitespace();
        if (text[at] !== ',') break;
        at++;
        whitespace();
      }
      if (text[at++] !== '}') throw unavailable();
      return { kind: 'object', entries };
    }
    if (text[at] === '[') {
      at++;
      whitespace();
      const items: Node[] = [];
      while (text[at] !== ']') {
        items.push(value(depth + 1));
        whitespace();
        if (text[at] !== ',') break;
        at++;
      }
      if (text[at++] !== ']') throw unavailable();
      return { kind: 'array', items };
    }
    if (text[at] === '"') return { kind: 'string', raw: string() };
    const match = /^(?:-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null)/.exec(
      text.slice(at),
    );
    if (!match) throw unavailable();
    const raw = match[0];
    at += raw.length;
    return {
      kind: raw === 'null' ? 'null' : raw === 'true' || raw === 'false' ? 'boolean' : 'number',
      raw,
    };
  };
  const result = value(0);
  whitespace();
  if (at !== text.length) throw unavailable();
  return result;
}
