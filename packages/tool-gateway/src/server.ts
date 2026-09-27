/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

import { inClusterSandboxKube } from './kube-jobs.js';
import { createPodCodeRunnerFactory } from './pod-code-runner.js';
import { createCallerVerifier } from './caller-verifier.js';
import {
  FLEET_RUN_TOOL_DESCRIPTOR,
  FLEET_RUN_TOOL_NAME,
  defineFleetRunTool,
} from './fleet-run-tool.js';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { SteelBrowserAdapter } from './browser-steel.js';
import type { SteelBrowserAdapterOptions } from './browser-steel.js';
import { LocalCodeRunner } from './code-runner.js';
import { buildSandboxEnv } from './env-policy.js';
import {
  buildExternalToolRegistry,
  parseExternalToolProviderConfig,
  type ExternalToolProviderConfig,
} from './external-providers.js';
import {
  ToolGatewayHttpHandler,
  type ToolGatewayHttpHandlerOptions,
  type ToolGatewayCodeRunnerFactory,
  type ToolGatewayTaskIdentity,
} from './http-server.js';
import { createPlaywrightCdpDriver } from './playwright-driver.js';
import { SshShellRunner, parseShellHostsEnv } from './shell-runner.js';
import { parseToolProfileConfig, type ToolProfileConfig } from './tool-profiles.js';

export interface ToolGatewayServerConfig {
  readonly port: number;
  readonly workspaceRoot: string;
  readonly paused: boolean;
  readonly steelBaseUrl?: string;
  readonly steelApiKey?: string;
  readonly steelConnectBaseUrl?: string;
  readonly shellSshKeyPath?: string;
  readonly shellSshUser?: string;
  /** Allowlisted shell.exec targets, `name -> address`. Empty = tool inert. */
  readonly shellHosts: Readonly<Record<string, string>>;
  readonly externalProviders: ExternalToolProviderConfig;
  readonly toolProfiles: ToolProfileConfig;
  readonly fleetPlaygroundUrl?: string;
  readonly fleetSigningKey?: string;
  readonly callerJwksUrl?: string;
  readonly callerIssuer?: string;
  readonly sandbox?: {
    readonly image: string;
    readonly namespace: string;
    readonly runtimeClassName?: string;
    readonly idleSeconds?: number;
    readonly resources?: Record<string, unknown>;
    readonly nodeSelector?: Record<string, string>;
  };
}

export interface ToolGatewayServerHandlerOptions {
  readonly runtimeHandler: ToolGatewayHttpHandler;
  readonly isReady: () => boolean;
}

const DEFAULT_PORT = 8080;
const DEFAULT_WORKSPACE_ROOT = '/tmp/kagent-tool-gateway-workspaces';

export function parseToolGatewayServerConfig(
  env: Readonly<Record<string, string | undefined>> = process.env,
): ToolGatewayServerConfig {
  const config: {
    port: number;
    workspaceRoot: string;
    paused: boolean;
    externalProviders: ExternalToolProviderConfig;
    toolProfiles: ToolProfileConfig;
    steelBaseUrl?: string;
    steelApiKey?: string;
    steelConnectBaseUrl?: string;
    shellSshKeyPath?: string;
    shellSshUser?: string;
    shellHosts: Readonly<Record<string, string>>;
    fleetPlaygroundUrl?: string;
    fleetSigningKey?: string;
    callerJwksUrl?: string;
    callerIssuer?: string;
    sandbox?: {
      image: string;
      namespace: string;
      runtimeClassName?: string;
      idleSeconds?: number;
      resources?: Record<string, unknown>;
      nodeSelector?: Record<string, string>;
    };
  } = {
    shellHosts: parseShellHostsEnv(env.KAGENT_SHELL_HOSTS),
    port: parsePositiveInteger(env.KAGENT_TOOL_GATEWAY_PORT, DEFAULT_PORT),
    workspaceRoot: nonEmpty(env.KAGENT_TOOL_RUNTIME_WORKSPACE_ROOT) ?? DEFAULT_WORKSPACE_ROOT,
    paused: env.KAGENT_TOOL_RUNTIME_PAUSED === 'true',
    // Two sources, concatenated: the Secret-borne JSON (providers that carry
    // credentials) and a plain values-borne JSON for providers that carry none
    // (the fleet's own services, whose signing key arrives by env), so those
    // stay reviewable in git instead of inside a sealed blob.
    externalProviders: {
      providers: [
        ...parseExternalToolProviderConfig(
          nonEmpty(env.KAGENT_TOOL_GATEWAY_EXTERNAL_PROVIDERS_JSON),
        ).providers,
        ...parseExternalToolProviderConfig(
          nonEmpty(env.KAGENT_TOOL_GATEWAY_EXTERNAL_PROVIDERS_EXTRA_JSON),
        ).providers,
      ],
    },
    toolProfiles: parseToolProfileConfig(nonEmpty(env.KAGENT_TOOL_GATEWAY_TOOL_PROFILES_JSON)),
  };
  const fleetPlaygroundUrl = nonEmpty(env.KAGENT_FLEET_PLAYGROUND_URL);
  const fleetSigningKey = nonEmpty(env.KAGENT_FLEET_SIGNING_KEY);
  if (fleetPlaygroundUrl !== undefined) config.fleetPlaygroundUrl = fleetPlaygroundUrl;
  if (fleetSigningKey !== undefined) config.fleetSigningKey = fleetSigningKey;
  // Callers prove their task with the operator-minted capability JWT; set the
  // operator's JWKS URL to require it.
  // Agent code runs in a per-task sandbox Job from this image, not in the gateway.
  const sandboxImage = nonEmpty(env.KAGENT_TOOL_GATEWAY_SANDBOX_IMAGE);
  if (sandboxImage !== undefined) {
    const runtimeClassName = nonEmpty(env.KAGENT_TOOL_GATEWAY_SANDBOX_RUNTIME_CLASS);
    const resources = nonEmpty(env.KAGENT_TOOL_GATEWAY_SANDBOX_RESOURCES_JSON);
    const nodeSelector = nonEmpty(env.KAGENT_TOOL_GATEWAY_SANDBOX_NODE_SELECTOR_JSON);
    config.sandbox = {
      image: sandboxImage,
      namespace: nonEmpty(env.KAGENT_TOOL_GATEWAY_SANDBOX_NAMESPACE) ?? 'default',
      idleSeconds: parsePositiveInteger(env.KAGENT_TOOL_GATEWAY_SANDBOX_IDLE_SECONDS, 1800),
      ...(runtimeClassName !== undefined && { runtimeClassName }),
      ...(resources !== undefined && {
        resources: JSON.parse(resources) as Record<string, unknown>,
      }),
      ...(nodeSelector !== undefined && {
        nodeSelector: JSON.parse(nodeSelector) as Record<string, string>,
      }),
    };
  }
  const callerJwksUrl = nonEmpty(env.KAGENT_TOOL_GATEWAY_CALLER_JWKS_URL);
  if (callerJwksUrl !== undefined) {
    config.callerJwksUrl = callerJwksUrl;
    config.callerIssuer = nonEmpty(env.KAGENT_CAP_ISSUER) ?? 'kagent.knuteson.io/operator';
  }
  const steelBaseUrl = nonEmpty(env.KAGENT_STEEL_BASE_URL);
  const steelApiKey = nonEmpty(env.KAGENT_STEEL_API_KEY);
  const steelConnectBaseUrl = nonEmpty(env.KAGENT_STEEL_CONNECT_BASE_URL);
  if (steelBaseUrl !== undefined) config.steelBaseUrl = steelBaseUrl;
  if (steelApiKey !== undefined) config.steelApiKey = steelApiKey;
  if (steelConnectBaseUrl !== undefined) config.steelConnectBaseUrl = steelConnectBaseUrl;
  const shellSshKeyPath = nonEmpty(env.KAGENT_SHELL_SSH_KEY_PATH);
  const shellSshUser = nonEmpty(env.KAGENT_SHELL_SSH_USER);
  if (shellSshKeyPath !== undefined) config.shellSshKeyPath = shellSshKeyPath;
  if (shellSshUser !== undefined) config.shellSshUser = shellSshUser;
  return config;
}

export function buildToolGatewayHandler(config: ToolGatewayServerConfig): ToolGatewayHttpHandler {
  let browser: SteelBrowserAdapter | undefined;
  if (config.steelBaseUrl !== undefined) {
    const browserOptions: SteelBrowserAdapterOptions = {
      baseUrl: config.steelBaseUrl,
      driver: createPlaywrightCdpDriver(),
      ...(config.steelApiKey !== undefined && { apiKey: config.steelApiKey }),
      ...(config.steelConnectBaseUrl !== undefined && {
        connectBaseUrl: config.steelConnectBaseUrl,
      }),
    };
    browser = new SteelBrowserAdapter(browserOptions);
  }

  let shellRunner: SshShellRunner | undefined;
  if (config.shellSshKeyPath !== undefined && config.shellSshUser !== undefined) {
    shellRunner = new SshShellRunner({
      sshKeyPath: config.shellSshKeyPath,
      sshUser: config.shellSshUser,
      hosts: config.shellHosts,
    });
    // Loud, because the symptom otherwise is a tool that advertises
    // itself and then refuses every call with "unknown host".
    if (Object.keys(config.shellHosts).length === 0) {
      console.warn(
        '[tool-gateway] shell.exec has an SSH user + key but no hosts — every call will be refused. Set toolRuntime.shell.hosts (env KAGENT_SHELL_HOSTS).',
      );
    }
  }

  const codeRunnerFactory: ToolGatewayCodeRunnerFactory =
    config.sandbox !== undefined
      ? createPodCodeRunnerFactory({ kube: inClusterSandboxKube(), ...config.sandbox })
      : (task: ToolGatewayTaskIdentity) => buildLocalCodeRunner(config.workspaceRoot, task);
  // fleet.run_tool: the catalog's executable half. Present only when the
  // gateway knows the playground and holds the fleet signing key.
  const fleetTool =
    config.fleetPlaygroundUrl !== undefined && config.fleetSigningKey !== undefined
      ? {
          externalHandlers: {
            [FLEET_RUN_TOOL_NAME]: defineFleetRunTool({
              playgroundUrl: config.fleetPlaygroundUrl,
              signingKey: config.fleetSigningKey,
              codeRunnerFor: codeRunnerFactory,
            }),
          },
          externalDescriptors: [FLEET_RUN_TOOL_DESCRIPTOR],
        }
      : {};

  const options: ToolGatewayHttpHandlerOptions = {
    paused: config.paused,
    codeRunnerFactory,
    externalRegistry: buildExternalToolRegistry(config.externalProviders),
    toolProfiles: config.toolProfiles,
    ...(browser !== undefined && { browser }),
    ...(shellRunner !== undefined && { shellRunner }),
    ...fleetTool,
    ...(config.callerJwksUrl !== undefined && {
      verifyCaller: createCallerVerifier({
        jwksUrl: config.callerJwksUrl,
        issuer: config.callerIssuer ?? 'kagent.knuteson.io/operator',
      }),
    }),
  };

  return new ToolGatewayHttpHandler(options);
}

export function createToolGatewayServerHandler(
  options: ToolGatewayServerHandlerOptions,
): (request: Request) => Promise<Response> {
  return async (request: Request) => {
    const url = new URL(request.url);
    if (request.method === 'GET' && url.pathname === '/healthz') {
      return jsonResponse({ ok: true });
    }
    if (request.method === 'GET' && url.pathname === '/readyz') {
      return options.isReady()
        ? jsonResponse({ ok: true })
        : jsonResponse({ ok: false, reason: 'paused' }, 503);
    }

    return options.runtimeHandler.handle(request);
  };
}

export async function startToolGatewayServer(
  config: ToolGatewayServerConfig = parseToolGatewayServerConfig(),
): Promise<Server> {
  const runtimeHandler = buildToolGatewayHandler(config);
  const handler = createToolGatewayServerHandler({
    runtimeHandler,
    isReady: () => !config.paused,
  });

  const server = createServer((req, res) => {
    void handleNodeRequest(handler, req, res);
  });

  await new Promise<void>((resolve) => {
    server.listen(config.port, resolve);
  });

  return server;
}

function buildLocalCodeRunner(
  workspaceRoot: string,
  task: ToolGatewayTaskIdentity,
): LocalCodeRunner {
  const workspaceDir = join(
    workspaceRoot,
    safePathSegment(task.tenant),
    safePathSegment(task.namespace),
    safePathSegment(task.taskUid),
  );
  mkdirSync(workspaceDir, { recursive: true });

  return new LocalCodeRunner({
    workspaceDir,
    env: buildSandboxEnv({
      ambientEnv: process.env,
      context: {
        taskUid: task.taskUid,
        agentName: task.agentName,
        namespace: task.namespace,
        sessionId: `code-${task.taskUid}`,
        toolKind: 'code_interpreter',
      },
    }),
  });
}

async function handleNodeRequest(
  handler: (request: Request) => Promise<Response>,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  try {
    const response = await handler(await toWebRequest(req));
    res.statusCode = response.status;
    response.headers.forEach((value, key) => {
      res.setHeader(key, value);
    });
    res.end(Buffer.from(await response.arrayBuffer()));
  } catch (err) {
    res.statusCode = 500;
    res.setHeader('content-type', 'application/json');
    res.end(
      JSON.stringify({
        error: err instanceof Error ? err.message : String(err),
      }),
    );
  }
}

async function toWebRequest(req: IncomingMessage): Promise<Request> {
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      for (const item of value) headers.append(key, item);
    } else {
      headers.set(key, value);
    }
  }

  const chunks: Uint8Array[] = [];
  for await (const chunk of req) {
    chunks.push(toUint8Array(chunk));
  }

  const method = req.method ?? 'GET';
  const host = headers.get('host') ?? 'localhost';
  const init: RequestInit = { method, headers };
  if (method !== 'GET' && method !== 'HEAD') {
    init.body = concatUint8Arrays(chunks);
  }

  return new Request(`http://${host}${req.url ?? '/'}`, init);
}

function parsePositiveInteger(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.length === 0) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed <= 0) return fallback;
  return parsed;
}

function nonEmpty(value: string | undefined): string | undefined {
  return value === undefined || value.length === 0 ? undefined : value;
}

function safePathSegment(value: string): string {
  return value.replaceAll(/[^a-zA-Z0-9._-]/g, '_');
}

function toUint8Array(chunk: unknown): Uint8Array {
  if (typeof chunk === 'string') return new TextEncoder().encode(chunk);
  if (chunk instanceof Uint8Array) return chunk;
  throw new Error('unsupported request body chunk type');
}

function concatUint8Arrays(chunks: readonly Uint8Array[]): Uint8Array {
  const length = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const out = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}
