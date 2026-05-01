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
  /** Test-injectable clock; production uses Date. */
  readonly clock?: () => Date;
}

/**
 * Build the request handler. Exported so tests can drive it without
 * binding a real port.
 */
export function buildInstantiateHandler(deps: TemplateServerDeps) {
  return async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method !== 'POST') {
      writeJson(res, 405, { code: 'method_not_allowed', message: 'method must be POST' });
      return;
    }
    const url = req.url ?? '';
    const match = url.match(ROUTE_RE);
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
    writeJson(res, reused ? 200 : 201, response);
  };
}

/**
 * Bind the handler to a port. Returns the Server so main.ts can close
 * it on shutdown.
 */
export function startTemplateServer(
  port: number,
  deps: TemplateServerDeps,
): { readonly server: Server; close(): Promise<void> } {
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
  server.listen(port);
  return {
    server,
    close(): Promise<void> {
      return new Promise((resolve, reject) => {
        server.close((err) => {
          if (err) reject(err);
          else resolve();
        });
      });
    },
  };
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
