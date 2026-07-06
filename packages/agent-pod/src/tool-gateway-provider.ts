/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

import type {
  ContentBlock,
  ToolCall,
  ToolDescriptor,
  ToolInvocationContext,
  ToolProvider,
  ToolResult,
} from '@kagent/agent-loop';
import {
  BROWSER_TOOL_NAMES,
  CODE_INTERPRETER_TOOL_NAMES,
  SHELL_TOOL_NAMES,
  isToolRuntimeTool,
  type ToolRuntimeToolName,
} from '@kagent/dto';

export interface ToolGatewayTaskIdentity {
  readonly tenant: string;
  readonly namespace: string;
  readonly taskUid: string;
  readonly agentName: string;
}

export interface ToolGatewayProviderOptions {
  readonly id?: string;
  readonly baseUrl: string;
  readonly task: ToolGatewayTaskIdentity;
  readonly tools: readonly string[];
  readonly toolProfileRefs?: readonly string[];
  readonly fetch?: typeof fetch;
}

const DEFAULT_PROVIDER_ID = 'kagent-tool-gateway';

export class ToolGatewayProvider implements ToolProvider {
  public readonly id: string;
  private readonly baseUrl: string;
  private readonly task: ToolGatewayTaskIdentity;
  private readonly fetchImpl: typeof fetch;
  private readonly explicitGrantedToolNames: ReadonlySet<string>;
  private readonly profileGrantedToolNames = new Set<string>();
  private readonly toolProfileRefs: readonly string[];
  private readonly runtimeToolNames: readonly ToolRuntimeToolName[];
  private readonly externalToolNames: readonly string[];
  private readonly descriptors: ToolDescriptor[];
  private profileResolvedDescriptors: ToolDescriptor[] | undefined;

  constructor(options: ToolGatewayProviderOptions) {
    this.id = options.id ?? DEFAULT_PROVIDER_ID;
    this.baseUrl = trimTrailingSlash(options.baseUrl);
    this.task = options.task;
    this.fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
    const gatewayToolNames = requestedGatewayToolNames(options.tools);
    this.explicitGrantedToolNames = new Set(gatewayToolNames);
    this.toolProfileRefs = normalizeToolProfileRefs(options.toolProfileRefs);
    this.runtimeToolNames = gatewayToolNames.filter((tool): tool is ToolRuntimeToolName =>
      isToolRuntimeTool(tool),
    );
    this.externalToolNames = gatewayToolNames.filter((tool) => isExternalGatewayToolName(tool));
    this.descriptors = buildRuntimeToolDescriptors(this.runtimeToolNames);
  }

  describeTools(ctx?: ToolInvocationContext): ToolDescriptor[] | Promise<ToolDescriptor[]> {
    if (this.externalToolNames.length === 0 && this.toolProfileRefs.length === 0) {
      return this.descriptors;
    }
    return this.describeGatewayTools(ctx);
  }

  async executeTool(call: ToolCall, ctx: ToolInvocationContext): Promise<ToolResult> {
    if (!this.isGranted(call.name)) {
      if (this.toolProfileRefs.length > 0) {
        await this.describeGatewayTools(ctx);
      }
    }
    if (!this.isGranted(call.name)) {
      return {
        content: `policy_denied: tool "${call.name}" was not granted to this Agent`,
        isError: true,
        metadata: { policy: 'tool-not-granted' },
      };
    }

    const response = await this.fetchImpl(`${this.baseUrl}/v1/tool-runtime/invoke`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-kagent-agent': this.task.agentName,
        'x-kagent-namespace': this.task.namespace,
        'x-kagent-task-uid': this.task.taskUid,
        'x-kagent-tenant': this.task.tenant,
      },
      body: JSON.stringify({
        task: this.task,
        call: {
          id: call.id,
          name: call.name,
          args: call.args ?? {},
        },
      }),
      signal: ctx.abortSignal,
    });

    if (!response.ok) {
      return {
        content: `Gateway ${response.status}: ${await responseMessage(response)}`,
        isError: true,
        metadata: { status: response.status },
      };
    }

    return parseToolResult(await response.json());
  }

  private async describeGatewayTools(ctx?: ToolInvocationContext): Promise<ToolDescriptor[]> {
    if (this.profileResolvedDescriptors !== undefined) return this.profileResolvedDescriptors;

    const init: RequestInit = {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-kagent-agent': this.task.agentName,
        'x-kagent-namespace': this.task.namespace,
        'x-kagent-task-uid': this.task.taskUid,
        'x-kagent-tenant': this.task.tenant,
      },
      body: JSON.stringify({
        task: this.task,
        toolNames:
          this.toolProfileRefs.length > 0
            ? [...this.runtimeToolNames, ...this.externalToolNames]
            : this.externalToolNames,
        ...(this.toolProfileRefs.length > 0 && { toolProfileRefs: this.toolProfileRefs }),
      }),
    };
    if (ctx?.abortSignal !== undefined) init.signal = ctx.abortSignal;

    const response = await this.fetchImpl(`${this.baseUrl}/v1/tool-runtime/describe`, init);

    if (!response.ok) {
      throw new Error(`Gateway ${response.status}: ${await responseMessage(response)}`);
    }

    const gatewayDescriptors = parseToolDescriptors(await response.json());
    if (this.toolProfileRefs.length === 0) {
      return [...this.descriptors, ...gatewayDescriptors];
    }

    for (const descriptor of gatewayDescriptors) {
      this.profileGrantedToolNames.add(descriptor.name);
    }
    this.profileResolvedDescriptors = gatewayDescriptors;
    return gatewayDescriptors;
  }

  private isGranted(name: string): boolean {
    return this.explicitGrantedToolNames.has(name) || this.profileGrantedToolNames.has(name);
  }
}

export function requestedRuntimeToolNames(
  tools: readonly string[] | undefined,
): readonly ToolRuntimeToolName[] {
  if (tools === undefined) return [];
  const out: ToolRuntimeToolName[] = [];
  const seen = new Set<string>();

  for (const tool of tools) {
    if (!isToolRuntimeTool(tool) || seen.has(tool)) continue;
    seen.add(tool);
    out.push(tool);
  }

  return out;
}

export function requestedGatewayToolNames(tools: readonly string[] | undefined): readonly string[] {
  if (tools === undefined) return [];
  const out: string[] = [];
  const seen = new Set<string>();

  for (const tool of tools) {
    if ((!isToolRuntimeTool(tool) && !isExternalGatewayToolName(tool)) || seen.has(tool)) continue;
    seen.add(tool);
    out.push(tool);
  }

  return out;
}

function normalizeToolProfileRefs(values: readonly string[] | undefined): readonly string[] {
  if (values === undefined) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    if (value.length === 0 || seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
}

export function buildRuntimeToolDescriptors(
  toolNames: readonly ToolRuntimeToolName[],
): ToolDescriptor[] {
  return toolNames.map((name) => RUNTIME_TOOL_DESCRIPTORS[name]);
}

const RUNTIME_TOOL_DESCRIPTORS: Record<ToolRuntimeToolName, ToolDescriptor> = Object.fromEntries(
  [...BROWSER_TOOL_NAMES, ...CODE_INTERPRETER_TOOL_NAMES, ...SHELL_TOOL_NAMES].map((name) => [
    name,
    descriptorForRuntimeTool(name),
  ]),
) as Record<ToolRuntimeToolName, ToolDescriptor>;

function descriptorForRuntimeTool(name: ToolRuntimeToolName): ToolDescriptor {
  return {
    name,
    description: runtimeToolDescription(name),
    inputSchema: runtimeToolInputSchema(name),
    tags: runtimeToolTags(name),
  };
}

function runtimeToolDescription(name: ToolRuntimeToolName): string {
  switch (name) {
    case 'browser.start_session':
      return 'Start or fetch the task-scoped isolated browser session.';
    case 'browser.goto':
      return 'Navigate the task-scoped browser session to a URL.';
    case 'browser.click':
      return 'Click an element in the task-scoped browser session.';
    case 'browser.type':
      return 'Type text into an element in the task-scoped browser session.';
    case 'browser.select':
      return 'Select options in a dropdown in the task-scoped browser session.';
    case 'browser.wait_for':
      return 'Wait for visible text or a selector in the task-scoped browser session.';
    case 'browser.screenshot':
      return 'Capture a screenshot from the task-scoped browser session.';
    case 'browser.extract_text':
      return 'Extract visible text from the current browser page.';
    case 'browser.cdp_url':
      return 'Return the internal CDP URL for approved automation clients.';
    case 'browser.live_view_url':
      return 'Return the live viewer URL for human inspection.';
    case 'browser.recording_url':
      return 'Return the browser session recording URL when available.';
    case 'browser.terminate_session':
      return 'Release the task-scoped browser session.';
    case 'code_interpreter.start_session':
      return 'Start or fetch the task-scoped code interpreter session.';
    case 'code_interpreter.execute_code':
      return 'Execute inline Python, JavaScript, or TypeScript in the code workspace.';
    case 'code_interpreter.execute_command':
      return 'Execute an allowlisted command in the code workspace.';
    case 'code_interpreter.start_command':
      return 'Start a long-running allowlisted command in the code workspace.';
    case 'code_interpreter.read_files':
      return 'Read files under the code workspace root.';
    case 'code_interpreter.write_files':
      return 'Write files under the code workspace root.';
    case 'code_interpreter.list_files':
      return 'List files under the code workspace root.';
    case 'code_interpreter.stop_task':
      return 'Stop a long-running code interpreter command.';
    case 'code_interpreter.terminate_session':
      return 'Release the task-scoped code interpreter session.';
    case 'shell.exec':
      return 'Run a shell command over SSH on a specific homelab node (elitemini2 or jetson2 only).';
  }
}

function runtimeToolTags(name: ToolRuntimeToolName): readonly string[] {
  if (name.endsWith('.terminate_session') || name === 'code_interpreter.stop_task') {
    return ['destructive', 'idempotent'];
  }
  if (
    name === 'browser.cdp_url' ||
    name === 'browser.live_view_url' ||
    name === 'browser.recording_url' ||
    name === 'browser.extract_text' ||
    name === 'browser.screenshot' ||
    name === 'code_interpreter.read_files' ||
    name === 'code_interpreter.list_files'
  ) {
    return ['read-only'];
  }
  if (name === 'shell.exec') return ['destructive'];
  return [];
}

function runtimeToolInputSchema(name: ToolRuntimeToolName): Record<string, unknown> {
  switch (name) {
    case 'browser.goto':
      return objectSchema(
        {
          url: { type: 'string', minLength: 1 },
          timeoutMs: { type: 'number', minimum: 1 },
        },
        ['url'],
      );
    case 'browser.click':
      return objectSchema({
        selector: { type: 'string' },
        text: { type: 'string' },
        timeoutMs: { type: 'number', minimum: 1 },
      });
    case 'browser.type':
      return objectSchema(
        {
          selector: { type: 'string', minLength: 1 },
          text: { type: 'string' },
        },
        ['selector', 'text'],
      );
    case 'browser.select':
      return objectSchema(
        {
          selector: { type: 'string', minLength: 1 },
          value: { type: 'string', minLength: 1 },
        },
        ['selector', 'value'],
      );
    case 'browser.wait_for':
      return objectSchema({
        text: { type: 'string' },
        selector: { type: 'string' },
        timeoutMs: { type: 'number', minimum: 1 },
      });
    case 'browser.screenshot':
      return objectSchema({
        fullPage: { type: 'boolean' },
      });
    case 'browser.extract_text':
      return objectSchema({
        maxChars: { type: 'number', minimum: 1 },
      });
    case 'code_interpreter.execute_code':
      return objectSchema(
        {
          language: { type: 'string', enum: ['python', 'javascript', 'typescript'] },
          code: { type: 'string', minLength: 1 },
          timeoutMs: { type: 'number', minimum: 1 },
        },
        ['language', 'code'],
      );
    case 'code_interpreter.execute_command':
    case 'code_interpreter.start_command':
      return objectSchema(
        {
          command: { type: 'string', minLength: 1 },
          args: { type: 'array', items: { type: 'string' } },
          timeoutMs: { type: 'number', minimum: 1 },
        },
        ['command'],
      );
    case 'code_interpreter.read_files':
      return objectSchema(
        {
          paths: { type: 'array', items: { type: 'string', minLength: 1 }, minItems: 1 },
        },
        ['paths'],
      );
    case 'code_interpreter.write_files':
      return objectSchema(
        {
          files: {
            type: 'array',
            minItems: 1,
            items: objectSchema(
              {
                path: { type: 'string', minLength: 1 },
                content: { type: 'string' },
              },
              ['path', 'content'],
            ),
          },
        },
        ['files'],
      );
    case 'code_interpreter.list_files':
      return objectSchema({
        root: { type: 'string' },
      });
    case 'code_interpreter.stop_task':
      return objectSchema(
        {
          taskId: { type: 'string', minLength: 1 },
        },
        ['taskId'],
      );
    case 'shell.exec':
      return objectSchema(
        {
          host: { type: 'string', enum: ['elitemini2', 'jetson2'] },
          command: { type: 'string', minLength: 1 },
          timeoutSeconds: { type: 'number', minimum: 1, maximum: 600 },
        },
        ['host', 'command'],
      );
    default:
      return objectSchema({});
  }
}

function objectSchema(
  properties: Record<string, unknown>,
  required: readonly string[] = [],
): Record<string, unknown> {
  return {
    type: 'object',
    properties,
    required,
    additionalProperties: false,
  };
}

function parseToolResult(value: unknown): ToolResult {
  if (!isRecord(value)) {
    return { content: 'Gateway returned a non-object tool result', isError: true };
  }

  const content = value.content;
  return {
    content: parseContent(content),
    isError: value.isError === true,
    ...(isRecord(value.metadata) && { metadata: value.metadata }),
  };
}

function parseToolDescriptors(value: unknown): ToolDescriptor[] {
  if (!isRecord(value) || !Array.isArray(value.tools)) return [];
  const descriptors: ToolDescriptor[] = [];

  for (const tool of value.tools) {
    if (
      !isRecord(tool) ||
      typeof tool.name !== 'string' ||
      typeof tool.description !== 'string' ||
      !isRecord(tool.inputSchema)
    ) {
      continue;
    }
    descriptors.push({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
      ...(Array.isArray(tool.tags) &&
        tool.tags.every((tag): tag is string => typeof tag === 'string') && { tags: tool.tags }),
    });
  }

  return descriptors;
}

function parseContent(value: unknown): string | ContentBlock[] {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value as ContentBlock[];
  return JSON.stringify(value ?? '');
}

async function responseMessage(response: Response): Promise<string> {
  const text = await response.text();
  if (text.length === 0) return response.statusText;
  try {
    const parsed = JSON.parse(text) as { readonly error?: unknown; readonly message?: unknown };
    if (typeof parsed.error === 'string') return parsed.error;
    if (typeof parsed.message === 'string') return parsed.message;
  } catch {
    return text;
  }
  return text;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function trimTrailingSlash(value: string): string {
  return value.endsWith('/') ? value.slice(0, -1) : value;
}

function isExternalGatewayToolName(name: string): boolean {
  return name.startsWith('mcp.') || name.startsWith('http.');
}
