/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/**
 * WS-M — in-cluster HTTP endpoint that materializes AgentTemplate
 * instances. Per AGENT-TEMPLATES.md §3:
 *
 *   POST /v1alpha1/templates/{name}:instantiate
 *   body: { instanceName?, parameterValues, createdByTaskUid }
 *   200:  { agentName, namespace, reused, templateRef, parameterHash, droppedTools }
 *   4xx:  { code: InstantiateErrorCode, message }
 *
 * Trust model: this server runs on a ClusterIP-only Service; the
 * NetworkPolicy gates ingress to the agent-pod label. No JWT / token
 * validation — the network boundary IS the trust boundary, same as
 * litellm-proxy / langfuse-server in the homelab pattern.
 *
 * The actual K8s `Agent` create call happens here too. The pure
 * `buildAgentManifest` lives in `template-instantiator.ts` so we can
 * unit-test the math without a live API server.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

import type { CustomObjectsApi } from '@kubernetes/client-node';

import type { AgentTemplate } from './crds/types.js';
import {
  buildAgentManifest,
  InstantiateError,
  type InstantiateInput,
  type InstantiateResult,
} from './template-instantiator.js';

const KAGENT_GROUP = 'kagent.knuteson.io';
const KAGENT_VERSION = 'v1alpha1';
const AGENTTEMPLATE_PLURAL = 'agenttemplates';
const AGENT_PLURAL = 'agents';

/** Body cap on POST requests — refuses anything larger to bound DoS. */
const MAX_BODY_BYTES = 64 * 1024;

/** Path regex captures the template name (group 1). */
const ROUTE_RE = /^\/v1alpha1\/templates\/([^/:]+):instantiate$/;

export interface InstantiatePostBody {
  readonly instanceName?: string;
  readonly parameterValues: Readonly<Record<string, string>>;
  readonly createdByTaskUid: string;
  /** The creating AgentTask's name; the ownerReference needs it (v0.2.53). */
  readonly createdByTaskName?: string;
}

export interface InstantiatePostResponse {
  readonly agentName: string;
  readonly namespace: string;
  readonly reused: boolean;
  readonly templateRef: string;
  readonly parameterHash: string;
  readonly droppedTools: readonly string[];
}

export interface InstantiatePostError {
  readonly code: string;
  readonly message: string;
}

export interface TemplateServerDeps {
  readonly customApi: CustomObjectsApi;
  /** Resolves to the namespace the agent-pod's task is in. */
  readonly resolveNamespace: (req: IncomingMessage) => string;
  /**
   * Enables the POST template-instantiation route. Defaults to true
   * for existing WS-M callers; main.ts passes false when the server is
   * booted only to serve capability JWKS.
   */
  readonly templatesEnabled?: boolean;
  /** Test-injectable clock; production uses Date. */
  readonly clock?: () => Date;
  /**
   * v0.3.0-capabilities — JWKS provider. When set, the server exposes
   * `GET /.well-known/jwks.json` returning the operator's CA public
   * keys (one + optionally a previous-key for rotation cutover).
   * Verifiers (agent-pod cap consumer) fetch this to verify minted
   * JWTs without a shared secret.
   */
  readonly jwksProvider?: () => { readonly keys: readonly unknown[] };
}

/**
 * Build the request handler. Exported so tests can drive it without
 * binding a real port.
 */
export function buildInstantiateHandler(deps: TemplateServerDeps) {
  return async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = req.url ?? '';

    // v0.3.0-capabilities — JWKS endpoint for verifiers (agent-pod
    // cap consumer + downstream substrate gates). GET only; cache
    // for the JWT TTL window so verifiers minimize key fetches.
    if (url === '/.well-known/jwks.json') {
      if (req.method !== 'GET') {
        writeJson(res, 405, { code: 'method_not_allowed', message: 'method must be GET' });
        return;
      }
      if (deps.jwksProvider === undefined) {
        writeJson(res, 404, {
          code: 'jwks_disabled',
          message: 'capability JWKS not configured on this operator',
        });
        return;
      }
      const jwks = deps.jwksProvider();
      writeJsonWithCache(res, 200, jwks, 'public, max-age=300');
      return;
    }

    const match = url.match(ROUTE_RE);
    if (match !== null && deps.templatesEnabled === false) {
      writeJson(res, 404, {
        code: 'templates_disabled',
        message: 'AgentTemplate instantiation is disabled on this operator',
      });
      return;
    }

    if (req.method !== 'POST') {
      writeJson(res, 405, { code: 'method_not_allowed', message: 'method must be POST' });
      return;
    }
    if (match === null) {
      writeJson(res, 404, { code: 'not_found', message: 'unknown route' });
      return;
    }
    const templateName = decodeURIComponent(match[1] ?? '');
    if (templateName.length === 0) {
      writeJson(res, 400, { code: 'bad_request', message: 'template name is required' });
      return;
    }

    let body: InstantiatePostBody;
    try {
      body = (await readJsonBody(req)) as InstantiatePostBody;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      writeJson(res, 400, { code: 'bad_request', message });
      return;
    }
    if (
      typeof body.createdByTaskUid !== 'string' ||
      body.createdByTaskUid.length === 0 ||
      typeof body.parameterValues !== 'object' ||
      body.parameterValues === null ||
      Array.isArray(body.parameterValues)
    ) {
      writeJson(res, 400, {
        code: 'bad_request',
        message: 'createdByTaskUid + parameterValues object are required',
      });
      return;
    }

    const namespace = deps.resolveNamespace(req);
    const now = (deps.clock ?? (() => new Date()))();
    let template: AgentTemplate;
    try {
      template = await fetchTemplate(deps.customApi, namespace, templateName);
    } catch (err: unknown) {
      const status = extractK8sStatus(err);
      if (status === 404) {
        writeJson(res, 404, {
          code: 'template_not_found',
          message: `AgentTemplate ${namespace}/${templateName} not found`,
        });
        return;
      }
      writeJson(res, 500, {
        code: 'k8s_error',
        message: `failed to fetch template: ${err instanceof Error ? err.message : String(err)}`,
      });
      return;
    }

    let result: InstantiateResult;
    try {
      const input: InstantiateInput = {
        templateName,
        parameterValues: body.parameterValues,
        createdByTaskUid: body.createdByTaskUid,
        ...(typeof body.createdByTaskName === 'string' &&
          body.createdByTaskName.length > 0 && { createdByTaskName: body.createdByTaskName }),
        ...(body.instanceName !== undefined && { instanceName: body.instanceName }),
        ...(deps.clock !== undefined && { clock: deps.clock }),
      };
      result = buildAgentManifest(template, input);
    } catch (err: unknown) {
      if (err instanceof InstantiateError) {
        writeJson(res, 400, { code: err.code, message: err.message });
        return;
      }
      writeJson(res, 500, {
        code: 'internal_error',
        message: err instanceof Error ? err.message : String(err),
      });
      return;
    }

    let reused = false;
    try {
      await deps.customApi.createNamespacedCustomObject({
        group: KAGENT_GROUP,
        version: KAGENT_VERSION,
        namespace: result.manifest.metadata.namespace,
        plural: AGENT_PLURAL,
        body: result.manifest,
      });
    } catch (err: unknown) {
      const status = extractK8sStatus(err);
      if (status === 409) {
        // Already exists — treat as reused success per AGENT-TEMPLATES.md §4.
        reused = true;
      } else {
        writeJson(res, 500, {
          code: 'k8s_error',
          message: `failed to create Agent: ${err instanceof Error ? err.message : String(err)}`,
        });
        return;
      }
    }

    const response: InstantiatePostResponse = {
      agentName: result.agentName,
      namespace: result.manifest.metadata.namespace,
      reused,
      templateRef: result.templateRef,
      parameterHash: result.parameterHash,
      droppedTools: result.droppedTools,
    };
    if (reused) {
      try {
        await deps.customApi.patchNamespacedCustomObject({
          group: KAGENT_GROUP,
          version: KAGENT_VERSION,
          namespace: result.manifest.metadata.namespace,
          plural: AGENT_PLURAL,
          name: result.agentName,
          body: {
            metadata: {
              annotations: { 'kagent.knuteson.io/last-used-at': now.toISOString() },
            },
          },
        });
      } catch (err: unknown) {
        console.warn(
          `[template-server] last-used-at refresh failed for ${result.agentName}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    // Best-effort sweep: retire this template's stale instances. A sweep
    // failure must never fail the instantiate response.
    try {
      await sweepStaleInstances(deps.customApi, result.manifest.metadata.namespace, templateName, now);
    } catch (err: unknown) {
      console.warn(
        `[template-server] stale-instance sweep failed for ${templateName}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    writeJson(res, reused ? 200 : 201, response);
  };
}

const IDLE_THRESHOLD_MS = 3_600_000;
const TERMINAL_TASK_PHASES = new Set(['Completed', 'Failed']);

async function sweepStaleInstances(
  customApi: CustomObjectsApi,
  namespace: string,
  templateName: string,
  now: Date,
): Promise<void> {
  const agentsResp = (await customApi.listNamespacedCustomObject({
    group: KAGENT_GROUP,
    version: KAGENT_VERSION,
    namespace,
    plural: AGENT_PLURAL,
    labelSelector: `kagent.knuteson.io/from-template=${templateName}`,
  })) as { items?: unknown[] };
  const agents = agentsResp.items ?? [];
  if (agents.length === 0) return;

  const tasksResp = (await customApi.listNamespacedCustomObject({
    group: KAGENT_GROUP,
    version: KAGENT_VERSION,
    namespace,
    plural: 'agenttasks',
  })) as { items?: unknown[] };
  const tasks = tasksResp.items ?? [];

  const targeted = new Set<string>();
  for (const t of tasks) {
    const obj = t as {
      spec?: { targetAgent?: string };
      status?: { phase?: string };
    };
    const target = obj.spec?.targetAgent;
    if (typeof target !== 'string' || target.length === 0) continue;
    const phase = obj.status?.phase;
    if (phase === undefined || !TERMINAL_TASK_PHASES.has(phase)) {
      targeted.add(target);
    }
  }

  const cutoff = now.getTime() - IDLE_THRESHOLD_MS;
  for (const a of agents) {
    const obj = a as {
      metadata?: { name?: string; annotations?: Record<string, string> };
    };
    const name = obj.metadata?.name;
    if (typeof name !== 'string' || name.length === 0) continue;
    if (targeted.has(name)) continue;
    const usedAt = obj.metadata?.annotations?.['kagent.knuteson.io/last-used-at'];
    if (typeof usedAt !== 'string') continue;
    const usedMs = Date.parse(usedAt);
    if (Number.isNaN(usedMs)) continue;
    if (usedMs >= cutoff) continue;
    await customApi.deleteNamespacedCustomObject({
      group: KAGENT_GROUP,
      version: KAGENT_VERSION,
      namespace,
      plural: AGENT_PLURAL,
      name,
    });
  }
}

/**
 * Bind the handler to a port. Returns the Server so main.ts can close
 * it on shutdown.
 */
export function startTemplateServer(
  port: number,
  deps: TemplateServerDeps,
): Promise<{ readonly server: Server; close(): Promise<void> } | undefined> {
  const handler = buildInstantiateHandler(deps);
  const server = createServer((req, res) => {
    void handler(req, res).catch((err: unknown) => {
      console.error('[template-server] handler threw:', err);
      try {
        writeJson(res, 500, {
          code: 'internal_error',
          message: err instanceof Error ? err.message : String(err),
        });
      } catch {
        /* response already sent */
      }
    });
  });
  return new Promise((resolve) => {
    server.once('error', (err: NodeJS.ErrnoException) => {
      console.warn(
        `[template-server] bind failed (port=${port.toString()}): ${err.message} — template instantiation + JWKS disabled`,
      );
      resolve(undefined);
    });
    server.listen(port, () => {
      resolve({
        server,
        close(): Promise<void> {
          return new Promise((closeResolve, reject) => {
            server.close((err) => {
              if (err) reject(err);
              else closeResolve();
            });
          });
        },
      });
    });
  });
}

/* =====================================================================
 * Helpers
 * ===================================================================== */

async function fetchTemplate(
  customApi: CustomObjectsApi,
  namespace: string,
  name: string,
): Promise<AgentTemplate> {
  const obj: unknown = await customApi.getNamespacedCustomObject({
    group: KAGENT_GROUP,
    version: KAGENT_VERSION,
    namespace,
    plural: AGENTTEMPLATE_PLURAL,
    name,
  });
  if (obj === null || typeof obj !== 'object') {
    throw new Error(`AgentTemplate ${namespace}/${name} returned non-object`);
  }
  return obj as AgentTemplate;
}

function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let total = 0;
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => {
      total += chunk.byteLength;
      if (total > MAX_BODY_BYTES) {
        reject(new Error(`request body exceeds ${String(MAX_BODY_BYTES)} bytes`));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (total === 0) {
        reject(new Error('request body is empty'));
        return;
      }
      try {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve(JSON.parse(text));
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
    req.on('error', (err) => reject(err));
  });
}

function writeJsonWithCache(
  res: ServerResponse,
  status: number,
  body: unknown,
  cacheControl: string,
): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload, 'utf8').toString(),
    'cache-control': cacheControl,
  });
  res.end(payload);
}

function writeJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload, 'utf8').toString(),
  });
  res.end(payload);
}

function extractK8sStatus(err: unknown): number | undefined {
  if (err === null || typeof err !== 'object') return undefined;
  const e = err as Record<string, unknown>;
  if (typeof e.code === 'number') return e.code;
  if (typeof e.statusCode === 'number') return e.statusCode;
  return undefined;
}
