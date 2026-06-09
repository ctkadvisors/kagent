/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

import type {
  ToolCall,
  ToolDescriptor,
  ToolInvocationContext,
  ToolProvider,
  ToolResult,
} from '@kagent/agent-loop';
import { ToolProviderRegistry } from '@kagent/agent-loop';
import { HttpToolProvider, type HttpToolDefinition } from '@kagent/http-tool-provider';
import { McpToolProvider, type McpToolProviderOptions } from '@kagent/mcp-tool-provider';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';

import type { ToolGatewayInvocation } from './http-server.js';

export interface ExternalToolProviderConfig {
  readonly providers: readonly ExternalToolProviderSpec[];
}

export type ExternalToolProviderSpec =
  | ExternalHttpProviderSpec
  | ExternalMcpStdioProviderSpec
  | ExternalRemoteMcpProviderSpec;

export interface ExternalHttpProviderSpec {
  readonly kind: 'http';
  readonly id?: string;
  readonly baseUrl?: string;
  readonly defaultHeaders?: Record<string, string>;
  readonly tools: readonly HttpToolDefinition[];
}

export interface ExternalMcpStdioProviderSpec {
  readonly kind: 'mcpStdio';
  readonly id?: string;
  readonly command: string;
  readonly args?: readonly string[];
  readonly env?: Record<string, string>;
  readonly envAllowlist?: readonly string[];
  readonly cwd?: string;
}

export interface ExternalRemoteMcpProviderSpec {
  readonly kind: 'remoteMcp';
  readonly id?: string;
  readonly url: string;
  readonly headers?: Record<string, string>;
}

export interface ExternalToolRegistry {
  readonly describeTools: (
    ctx?: ToolInvocationContext,
  ) => Promise<readonly ToolDescriptor[]> | readonly ToolDescriptor[];
  readonly executeTool: (
    invocation: ToolGatewayInvocation,
    ctx: ToolInvocationContext,
  ) => Promise<ToolResult>;
}

export interface BuildExternalToolRegistryOptions {
  readonly fetch?: typeof fetch;
}

export function parseExternalToolProviderConfig(
  raw: string | undefined,
): ExternalToolProviderConfig {
  if (raw === undefined || raw.trim().length === 0) return { providers: [] };

  const parsed: unknown = JSON.parse(raw);
  if (!isRecord(parsed) || !Array.isArray(parsed.providers)) {
    throw new Error('KAGENT_TOOL_GATEWAY_EXTERNAL_PROVIDERS_JSON must contain providers[]');
  }

  return {
    providers: parsed.providers.map(parseProviderSpec),
  };
}

export function buildExternalToolRegistry(
  config: ExternalToolProviderConfig,
  options: BuildExternalToolRegistryOptions = {},
): ExternalToolRegistry {
  const registry = new ToolProviderRegistry();

  for (const spec of config.providers) {
    registry.register(providerForSpec(spec, options));
  }

  return {
    describeTools: (ctx) => registry.describeAll(ctx),
    executeTool: async (invocation, ctx) => {
      await registry.ready();
      const provider = registry.providerFor(invocation.call.name);
      if (provider === undefined) {
        return {
          content: `unknown external tool "${invocation.call.name}"`,
          isError: true,
          metadata: { policy: 'unknown-external-tool' },
        };
      }
      return provider.executeTool(invocation.call, ctx);
    },
  };
}

function providerForSpec(
  spec: ExternalToolProviderSpec,
  options: BuildExternalToolRegistryOptions,
): ToolProvider {
  switch (spec.kind) {
    case 'http':
      return new HttpToolProvider({
        ...(spec.id !== undefined && { id: spec.id }),
        ...(spec.baseUrl !== undefined && { baseUrl: spec.baseUrl }),
        ...(spec.defaultHeaders !== undefined && { defaultHeaders: spec.defaultHeaders }),
        ...(options.fetch !== undefined && { fetch: options.fetch }),
        tools: [...spec.tools],
      });
    case 'mcpStdio': {
      const opts: McpToolProviderOptions = {
        command: spec.command,
        ...(spec.id !== undefined && { id: spec.id }),
        ...(spec.args !== undefined && { args: [...spec.args] }),
        ...(spec.env !== undefined && { env: spec.env }),
        ...(spec.envAllowlist !== undefined && { envAllowlist: spec.envAllowlist }),
        ...(spec.cwd !== undefined && { cwd: spec.cwd }),
      };
      return new McpToolProvider(opts);
    }
    case 'remoteMcp':
      return new RemoteMcpToolProvider({
        id: spec.id ?? 'remote-mcp',
        url: spec.url,
        ...(spec.headers !== undefined && { headers: spec.headers }),
        ...(options.fetch !== undefined && { fetch: options.fetch }),
      });
  }
}

function parseProviderSpec(raw: unknown): ExternalToolProviderSpec {
  if (!isRecord(raw) || typeof raw.kind !== 'string') {
    throw new Error('external provider kind must be a string');
  }

  switch (raw.kind) {
    case 'http':
      return parseHttpProvider(raw);
    case 'mcpStdio':
      return parseMcpStdioProvider(raw);
    case 'remoteMcp':
      return parseRemoteMcpProvider(raw);
    default:
      throw new Error(`unsupported external provider kind: ${raw.kind}`);
  }
}

function parseHttpProvider(raw: Record<string, unknown>): ExternalHttpProviderSpec {
  if (!Array.isArray(raw.tools)) throw new Error('http external provider requires tools[]');
  const spec: {
    kind: 'http';
    id?: string;
    baseUrl?: string;
    defaultHeaders?: Record<string, string>;
    tools: readonly HttpToolDefinition[];
  } = {
    kind: 'http',
    tools: raw.tools.map(parseHttpToolDefinition),
  };
  if (typeof raw.id === 'string') spec.id = raw.id;
  if (typeof raw.baseUrl === 'string') spec.baseUrl = raw.baseUrl;
  if (isStringRecord(raw.defaultHeaders)) spec.defaultHeaders = raw.defaultHeaders;
  return spec;
}

function parseHttpToolDefinition(raw: unknown): HttpToolDefinition {
  if (
    !isRecord(raw) ||
    typeof raw.name !== 'string' ||
    typeof raw.description !== 'string' ||
    !isRecord(raw.inputSchema) ||
    !isHttpMethod(raw.method) ||
    typeof raw.path !== 'string'
  ) {
    throw new Error('invalid http external tool definition');
  }

  const tool: HttpToolDefinition = {
    name: raw.name,
    description: raw.description,
    inputSchema: raw.inputSchema,
    method: raw.method,
    path: raw.path,
  };
  if (isStringRecord(raw.headers)) tool.headers = raw.headers;
  if (raw.body === 'json' || raw.body === 'none') tool.body = raw.body;
  if (Array.isArray(raw.tags) && raw.tags.every((tag): tag is string => typeof tag === 'string')) {
    tool.tags = raw.tags;
  }
  return tool;
}

function parseMcpStdioProvider(raw: Record<string, unknown>): ExternalMcpStdioProviderSpec {
  if (typeof raw.command !== 'string' || raw.command.length === 0) {
    throw new Error('mcpStdio external provider requires command');
  }

  const spec: {
    kind: 'mcpStdio';
    id?: string;
    command: string;
    args?: readonly string[];
    env?: Record<string, string>;
    envAllowlist?: readonly string[];
    cwd?: string;
  } = {
    kind: 'mcpStdio',
    command: raw.command,
  };
  if (typeof raw.id === 'string') spec.id = raw.id;
  if (Array.isArray(raw.args) && raw.args.every((arg): arg is string => typeof arg === 'string')) {
    spec.args = raw.args;
  }
  if (isStringRecord(raw.env)) spec.env = raw.env;
  if (
    Array.isArray(raw.envAllowlist) &&
    raw.envAllowlist.every((key): key is string => typeof key === 'string')
  ) {
    spec.envAllowlist = raw.envAllowlist;
  }
  if (typeof raw.cwd === 'string') spec.cwd = raw.cwd;
  return spec;
}

function parseRemoteMcpProvider(raw: Record<string, unknown>): ExternalRemoteMcpProviderSpec {
  if (typeof raw.url !== 'string' || raw.url.length === 0) {
    throw new Error('remoteMcp external provider requires url');
  }

  const spec: {
    kind: 'remoteMcp';
    id?: string;
    url: string;
    headers?: Record<string, string>;
  } = {
    kind: 'remoteMcp',
    url: raw.url,
  };
  if (typeof raw.id === 'string') spec.id = raw.id;
  if (isStringRecord(raw.headers)) spec.headers = raw.headers;
  return spec;
}

interface RemoteMcpToolProviderOptions {
  readonly id: string;
  readonly url: string;
  readonly headers?: Record<string, string>;
  readonly fetch?: typeof fetch;
}

class RemoteMcpToolProvider implements ToolProvider {
  public readonly id: string;
  private readonly url: string;
  private readonly headers: Record<string, string>;
  private readonly fetchImpl: typeof fetch | undefined;
  private client: Client | null = null;
  private toolsCache: ToolDescriptor[] | null = null;

  constructor(options: RemoteMcpToolProviderOptions) {
    this.id = options.id;
    this.url = options.url;
    this.headers = options.headers ?? {};
    this.fetchImpl = options.fetch;
  }

  async describeTools(ctx?: ToolInvocationContext): Promise<ToolDescriptor[]> {
    if (this.toolsCache !== null) return this.toolsCache;
    if (ctx?.abortSignal.aborted) throw new Error('remote MCP describe aborted');

    const client = await this.ensureConnected();
    const listed = await client.listTools(
      undefined,
      ctx?.abortSignal === undefined ? undefined : { signal: ctx.abortSignal },
    );
    this.toolsCache = listed.tools.map((tool) => ({
      name: tool.name,
      description: tool.description ?? '',
      inputSchema: tool.inputSchema ?? {},
    }));
    return this.toolsCache;
  }

  async executeTool(call: ToolCall, ctx: ToolInvocationContext): Promise<ToolResult> {
    const client = await this.ensureConnected();
    const result = await client.callTool(
      { name: call.name, arguments: (call.args ?? {}) as Record<string, unknown> },
      CallToolResultSchema,
      { signal: ctx.abortSignal },
    );
    return mapMcpResultToToolResult(result as McpCallToolResult);
  }

  private async ensureConnected(): Promise<Client> {
    if (this.client !== null) return this.client;

    const requestInit: RequestInit =
      Object.keys(this.headers).length === 0 ? {} : { headers: this.headers };
    const transport = new StreamableHTTPClientTransport(new URL(this.url), {
      requestInit,
      ...(this.fetchImpl !== undefined && { fetch: this.fetchImpl }),
    });
    const client = new Client(
      { name: '@kagent/tool-gateway', version: '0.0.0' },
      { capabilities: {} },
    );
    await client.connect(transport as unknown as Transport);
    this.client = client;
    return client;
  }
}

interface McpContentBlock {
  readonly type: 'text' | 'image' | 'audio' | 'resource' | 'resource_link';
  readonly text?: string;
  readonly data?: string;
  readonly mimeType?: string;
  readonly uri?: string;
  readonly resource?: { readonly uri: string; readonly text?: string; readonly mimeType?: string };
}

interface McpCallToolResult {
  readonly content: readonly McpContentBlock[];
  readonly isError?: boolean;
  readonly _meta?: Record<string, unknown>;
}

function mapMcpResultToToolResult(raw: McpCallToolResult): ToolResult {
  const textBlocks = raw.content.filter((block) => block.type === 'text');
  if (textBlocks.length === 1 && raw.content.length === 1) {
    return {
      content: textBlocks[0]?.text ?? '',
      isError: raw.isError ?? false,
      ...(raw._meta !== undefined && { metadata: { _meta: raw._meta } }),
    };
  }

  return {
    content: raw.content
      .map((block) => {
        if (block.type === 'image' && block.data !== undefined && block.mimeType !== undefined) {
          return { type: 'image' as const, bytes: block.data, mimeType: block.mimeType };
        }
        if (block.type === 'resource' && block.resource !== undefined) {
          return {
            type: 'resource' as const,
            uri: block.resource.uri,
            ...(block.resource.text !== undefined && { text: block.resource.text }),
            ...(block.resource.mimeType !== undefined && { mimeType: block.resource.mimeType }),
          };
        }
        if (block.type === 'resource_link' && block.uri !== undefined) {
          return {
            type: 'resource' as const,
            uri: block.uri,
            ...(block.mimeType !== undefined && { mimeType: block.mimeType }),
          };
        }
        return { type: 'text' as const, text: block.text ?? `[${block.type} block]` };
      })
      .filter((block) => block.type !== 'text' || block.text.length > 0),
    isError: raw.isError ?? false,
    ...(raw._meta !== undefined && { metadata: { _meta: raw._meta } }),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return (
    isRecord(value) &&
    Object.values(value).every((item): item is string => typeof item === 'string')
  );
}

function isHttpMethod(value: unknown): value is HttpToolDefinition['method'] {
  return (
    value === 'GET' ||
    value === 'POST' ||
    value === 'PUT' ||
    value === 'PATCH' ||
    value === 'DELETE'
  );
}
