/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/**
 * Recover tool calls a backend left as text.
 *
 * A serving engine turns the model's `<tool_call>` markup into structured
 * `tool_calls`. When it cannot (the model named a function the engine does
 * not know, or wrote the markup once in prose first), it returns the markup
 * as plain `content` with no `tool_calls`. The loop then reads that text as
 * the run's final answer and the task ends "Completed" having run nothing.
 *
 * Observed 2026-11-26 after the Spark moved to TensorFold: 147 of 222
 * completed tasks ended this way, 144 of them `<function=code_interpreter>`
 * for the tool named `code_interpreter.execute_code` (the model drops the
 * part after the dot, sometimes writing it as a first, empty parameter).
 *
 * The recovery is conservative. It applies only when the response has no
 * structured tool calls, tools were offered, and the content ENDS with a
 * complete `<tool_call>…</tool_call>` block: a call the model was making,
 * not markup it quoted mid-answer. Every recovered call must resolve to
 * exactly one offered tool, or nothing is recovered.
 */

import type { ChatResult, ToolCall, ToolDescriptor } from '@kagent/agent-loop';

// A block starts at the LAST `<tool_call>` before its close: the model often names the tag in
// prose first ("earlier runs emitted `<tool_call>` text"), and that mention is not a call.
const CALL_BLOCK = /<tool_call>((?:(?!<tool_call>)[\s\S])*?)<\/tool_call>/g;
const FUNCTION_TAG = /<function=([A-Za-z0-9_.-]+)>/;
/** `<parameter=key>` immediately followed by another parameter: a key with no value. */
const BARE_PARAMETER = /<parameter=([A-Za-z0-9_.-]+)>\s*(?=<parameter=)/g;
const PARAMETER = /<parameter=([A-Za-z0-9_.-]+)>\n?([\s\S]*?)\n?<\/parameter>/g;

interface ParsedCall {
  readonly name: string;
  readonly bare: readonly string[];
  readonly params: ReadonlyArray<readonly [string, string]>;
}

function parseBlock(block: string): ParsedCall | undefined {
  const body = block.trim();
  // The JSON form: {"name": "...", "arguments": {...}}
  if (body.startsWith('{')) {
    try {
      const parsed = JSON.parse(body) as { name?: unknown; arguments?: unknown };
      if (typeof parsed.name !== 'string') return undefined;
      const args =
        parsed.arguments !== null && typeof parsed.arguments === 'object'
          ? (parsed.arguments as Record<string, unknown>)
          : {};
      return {
        name: parsed.name,
        bare: [],
        params: Object.entries(args).map(([k, v]) => [
          k,
          typeof v === 'string' ? v : JSON.stringify(v),
        ]),
      };
    } catch {
      return undefined;
    }
  }
  const fn = FUNCTION_TAG.exec(body);
  if (fn?.[1] === undefined) return undefined;
  const bare = [...body.matchAll(BARE_PARAMETER)].map((m) => m[1] ?? '');
  const withoutBare = body.replace(BARE_PARAMETER, '');
  const params = [...withoutBare.matchAll(PARAMETER)].map((m) => [m[1] ?? '', m[2] ?? ''] as const);
  return { name: fn[1], bare, params };
}

/** The one offered tool this call means, or undefined when it is not exactly one. */
function resolveTool(
  call: ParsedCall,
  tools: readonly ToolDescriptor[],
): ToolDescriptor | undefined {
  const exact = tools.find((t) => t.name === call.name);
  if (exact !== undefined) return call.bare.length === 0 ? exact : undefined;
  // `code_interpreter` + an empty first parameter `execute_code`
  if (call.bare.length === 1) {
    return tools.find((t) => t.name === `${call.name}.${call.bare[0] ?? ''}`);
  }
  if (call.bare.length > 1) return undefined;
  // `code_interpreter` alone, when exactly one offered tool is `code_interpreter.<something>`
  const dotted = tools.filter((t) => t.name.startsWith(`${call.name}.`));
  return dotted.length === 1 ? dotted[0] : undefined;
}

/** A parameter's text as the type the tool's schema asks for; strings stay verbatim. */
function typedValue(raw: string, schema: unknown): unknown {
  const type =
    schema !== null && typeof schema === 'object' ? (schema as { type?: unknown }).type : undefined;
  if (type === 'string') return raw;
  const text = raw.trim();
  if (type === undefined) {
    // No declared type: only an unmistakable number or boolean is converted.
    if (/^-?\d+(\.\d+)?$/.test(text)) return Number(text);
    if (text === 'true' || text === 'false') return text === 'true';
    return raw;
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return raw;
  }
}

/**
 * Return `result` with its trailing text tool calls made structured, or
 * `result` unchanged when there is nothing to recover or anything about
 * the markup is not certain.
 */
export function recoverTextToolCalls(
  result: ChatResult,
  tools: readonly ToolDescriptor[] | undefined,
  newId: (index: number) => string = (index) =>
    `call_recovered_${Date.now().toString(36)}_${String(index)}`,
): ChatResult {
  if (result.tool_calls !== undefined && result.tool_calls.length > 0) return result;
  if (tools === undefined || tools.length === 0) return result;
  const content = result.content.trimEnd();
  if (!content.endsWith('</tool_call>')) return result;

  // Only the run of call blocks that ends the message: text may sit before
  // them, never between or after.
  const blocks = [...content.matchAll(CALL_BLOCK)];
  let start = content.length;
  const trailing: string[] = [];
  for (let i = blocks.length - 1; i >= 0; i -= 1) {
    const block = blocks[i];
    if (block?.index === undefined) break;
    const end = block.index + block[0].length;
    if (content.slice(end, start).trim() !== '') break;
    trailing.unshift(block[1] ?? '');
    start = block.index;
  }
  if (trailing.length === 0) return result;

  const calls: ToolCall[] = [];
  for (const [index, block] of trailing.entries()) {
    const parsed = parseBlock(block);
    if (parsed === undefined) return result;
    const tool = resolveTool(parsed, tools);
    if (tool === undefined) return result;
    const properties =
      (tool.inputSchema as { properties?: Record<string, unknown> } | undefined)?.properties ?? {};
    const args: Record<string, unknown> = {};
    for (const [key, raw] of parsed.params) {
      args[key] = typedValue(raw, properties[key]);
    }
    calls.push({ id: newId(index), name: tool.name, args });
  }

  return {
    ...result,
    content: content.slice(0, start).trimEnd(),
    tool_calls: calls,
    stopReason: 'tool_use',
  };
}
