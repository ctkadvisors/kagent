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
import { checkPublication } from './check-publication.js';
import { TaskToolResultStore, type RawResultStorageOptions } from './tool-result-reference.js';

import {
  BROWSER_TOOL_NAMES,
  CODE_INTERPRETER_TOOL_NAMES,
  DEFAULT_CODE_TIMEOUT_MS,
  SHELL_TOOL_NAMES,
  isExternalGatewayToolName,
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
  /**
   * The task's capability JWT. Sent as a bearer token so the gateway takes
   * the task's identity from a token the operator signed, not from headers.
   */
  readonly capabilityJwt?: string;
  readonly fetch?: typeof fetch;
  readonly rawResultStorage?: RawResultStorageOptions;
}

const DEFAULT_PROVIDER_ID = 'kagent-tool-gateway';

export class ToolGatewayProvider implements ToolProvider {
  public readonly id: string;
  private readonly baseUrl: string;
  private readonly task: ToolGatewayTaskIdentity;
  private readonly fetchImpl: typeof fetch;
  private readonly capabilityJwt: string | undefined;
  private readonly explicitGrantedToolNames: ReadonlySet<string>;
  private readonly profileGrantedToolNames = new Set<string>();
  private readonly toolProfileRefs: readonly string[];
  private readonly runtimeToolNames: readonly ToolRuntimeToolName[];
  private readonly externalToolNames: readonly string[];
  private readonly descriptors: ToolDescriptor[];
  private profileResolvedDescriptors: ToolDescriptor[] | undefined;
  private readonly resultStore: TaskToolResultStore | undefined;
  private readonly maxResultChars: number | undefined;

  constructor(options: ToolGatewayProviderOptions) {
    this.id = options.id ?? DEFAULT_PROVIDER_ID;
    this.resultStore = options.rawResultStorage
      ? new TaskToolResultStore(options.task, options.rawResultStorage)
      : undefined;
    this.maxResultChars = options.rawResultStorage?.maxContentChars;
    this.baseUrl = trimTrailingSlash(options.baseUrl);
    this.task = Object.freeze({ ...options.task });
    this.fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.capabilityJwt = options.capabilityJwt;
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

    let args = call.args ?? {};
    let publication: Record<string, unknown> | undefined;
    if (call.name === 'fleet.forum_post' && isRecord(args) && 'bodyFromToolResult' in args) {
      try {
        const request = args.bodyFromToolResult;
        if (
          !this.resultStore ||
          'body' in args ||
          !isRecord(request) ||
          Object.keys(request).length !== 1 ||
          typeof request.uri !== 'string'
        )
          throw new Error('invalid publication reference');
        const canonical = checkPublication(
          await this.resultStore.resolve(request.uri, ctx.runId, ctx.abortSignal),
        );
        const ordinary = { ...args };
        delete ordinary.bodyFromToolResult;
        args = { ...ordinary, body: canonical.body };
        publication = canonical.metadata;
      } catch {
        return { content: 'check publication unavailable', isError: true };
      }
    }
    if (
      call.name === 'code_interpreter.execute_code' &&
      args &&
      typeof args === 'object' &&
      !Array.isArray(args)
    ) {
      const input = args as Record<string, unknown>;
      if ('inputFiles' in input)
        return {
          content: 'tool-result reference unavailable: reserved import field',
          isError: true,
        };
      if ('inputArtifacts' in input) {
        try {
          if (!this.resultStore) throw new Error('capture disabled');
          const started = Date.now();
          const requested =
            typeof input.timeoutMs === 'number' && input.timeoutMs > 0
              ? input.timeoutMs
              : DEFAULT_CODE_TIMEOUT_MS;
          const budget = Math.min(requested, this.resultStore.remainingMs());
          const files = await this.resultStore.importFiles(
            input.inputArtifacts,
            ctx.runId,
            ctx.abortSignal,
          );
          const ordinary = { ...input };
          delete ordinary.inputArtifacts;
          ordinary.timeoutMs = budget - (Date.now() - started);
          if ((ordinary.timeoutMs as number) <= 0) throw new Error('import deadline elapsed');
          args = { ...ordinary, inputFiles: files };
        } catch {
          return { content: 'tool-result reference unavailable', isError: true };
        }
      }
    }
    ctx.abortSignal.throwIfAborted();
    const response = await this.fetchImpl(`${this.baseUrl}/v1/tool-runtime/invoke`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-kagent-agent': this.task.agentName,
        'x-kagent-namespace': this.task.namespace,
        'x-kagent-task-uid': this.task.taskUid,
        'x-kagent-tenant': this.task.tenant,
        ...(this.capabilityJwt !== undefined && {
          authorization: `Bearer ${this.capabilityJwt}`,
        }),
      },
      body: JSON.stringify({
        task: this.task,
        call: {
          id: call.id,
          name: call.name,
          args,
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

    const received = parseToolResult(await response.json());
    const result = publication
      ? { ...received, metadata: { ...received.metadata, checkPublication: publication } }
      : received;
    const text =
      typeof result.content === 'string' ? result.content : JSON.stringify(result.content);
    const publicationSource =
      this.isGranted('fleet.forum_post') &&
      ['fleet.run_tool', 'fleet.run_capability'].includes(call.name);
    if (
      !result.isError &&
      this.resultStore &&
      this.maxResultChars !== undefined &&
      ((text.length > this.maxResultChars && this.isGranted('code_interpreter.execute_code')) ||
        publicationSource)
    ) {
      try {
        const reference = await this.resultStore.retain(
          call,
          ctx.runId,
          result.content,
          ctx.abortSignal,
        );
        return {
          ...result,
          content: attachResultNotice(result.content, { _kagent_tool_result_ref: reference }),
        };
      } catch {
        return {
          ...result,
          content: attachResultNotice(result.content, {
            _kagent_tool_result_ref_unavailable: true,
          }),
        };
      }
    }
    return result;
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
        ...(this.capabilityJwt !== undefined && {
          authorization: `Bearer ${this.capabilityJwt}`,
        }),
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

    const gatewayDescriptors = parseToolDescriptors(await response.json()).map(
      publicationDescriptor,
    );
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
    case 'browser.capture_page':
      return 'Save exact current browser-visible text and HTTP(S) links plus URL/title/time/SHA-256 provenance to unique files in this task code workspace. Returns saved paths/hash/counts; use existing code tools to read or process them. Accepts no output path. Writes workspace files; does not modify the website.';
    case 'browser.extract_text':
      return 'Extract visible text from the current browser page (maxChars bounds what is shown), ending with the SHA-256 of the whole text, the same textSha256 browser.capture_page records.';
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
      return 'Execute inline Python, JavaScript, or TypeScript in the code workspace. Optional inputArtifacts [{uri,path}] imports same-task ephemeral tool-result references and path.source.json metadata before this explicit call; these references expire with the task.';
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
      // Offline fallback only -- the gateway's /describe response is the
      // real descriptor and names this deployment's actual hosts. We
      // cannot know them from in-pod, so stay generic rather than
      // advertising hosts that may not exist here.
      return 'Run a shell command over SSH on a host allowlisted by the tool gateway. Call the gateway describe endpoint for the permitted host names.';
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
    case 'browser.capture_page':
      return objectSchema({});
    case 'browser.extract_text':
      return objectSchema({
        maxChars: { type: 'number', minimum: 1 },
      });
    case 'code_interpreter.execute_code':
      return objectSchema(
        {
          language: { type: 'string', enum: ['python', 'javascript', 'typescript'] },
          code: { type: 'string', minLength: 1 },
          inputArtifacts: {
            type: 'array',
            minItems: 1,
            items: {
              type: 'object',
              required: ['uri', 'path'],
              additionalProperties: false,
              properties: { uri: { type: 'string' }, path: { type: 'string' } },
            },
          },
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
          // No enum: the allowlist is gateway-side deployment config.
          // The gateway rejects unknown hosts with `policy_denied`, so
          // omitting it here loosens advertisement, not enforcement.
          host: { type: 'string', minLength: 1 },
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

/** Preserve JSON-envelope and first-content-block parser contracts. */
function attachResultNotice(
  content: ToolResult['content'],
  notice: Record<string, unknown>,
): ToolResult['content'] {
  const block: ContentBlock = { type: 'text', text: JSON.stringify(notice) };
  if (typeof content !== 'string') return [...content, block];
  try {
    const parsed: unknown = JSON.parse(content);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const object = parsed as Record<string, unknown>;
      if ('_kagent_tool_result_ref' in object || '_kagent_tool_result_ref_unavailable' in object)
        return content;
      return JSON.stringify({ ...notice, ...object });
    }
    if (
      Array.isArray(parsed) &&
      parsed.length > 0 &&
      parsed.every(
        (value) =>
          value &&
          typeof value === 'object' &&
          ['text', 'image', 'resource'].includes(String((value as Record<string, unknown>).type)),
      )
    ) {
      return JSON.stringify([...(parsed as unknown[]), block]);
    }
  } catch {
    /* Opaque text remains the original first text block. */
  }
  return [{ type: 'text', text: content }, block];
}

function publicationDescriptor(descriptor: ToolDescriptor): ToolDescriptor {
  if (descriptor.name !== 'fleet.forum_post' || !isRecord(descriptor.inputSchema))
    return descriptor;
  const schema = descriptor.inputSchema;
  const required = Array.isArray(schema.required)
    ? (schema.required as unknown[]).filter((key) => key !== 'body')
    : [];
  return {
    ...descriptor,
    description:
      descriptor.description +
      ' To publish an exact complete check result without retyping, explicitly use bodyFromToolResult:{uri} from its same-task tool-result reference instead of body. This preserves actual exit/numeric/null values and refuses unavailable or oversized results.',
    inputSchema: {
      ...schema,
      required,
      properties: {
        ...(isRecord(schema.properties) ? schema.properties : {}),
        bodyFromToolResult: {
          type: 'object',
          required: ['uri'],
          additionalProperties: false,
          properties: { uri: { type: 'string' } },
        },
      },
      oneOf: [
        { required: ['body'], not: { required: ['bodyFromToolResult'] } },
        { required: ['bodyFromToolResult'], not: { required: ['body'] } },
      ],
    },
  };
}
