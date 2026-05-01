/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/**
 * WS-M — `ensure_agent_from_template` built-in tool.
 *
 * Wraps a POST to the operator's template-server endpoint
 * (`POST /v1alpha1/templates/{name}:instantiate`). The endpoint URL
 * is plumbed via `KAGENT_TEMPLATE_SERVER_URL` (set by the operator
 * chart on every spawned Job). Trust boundary is the cluster
 * NetworkPolicy — see template-server.ts.
 *
 * Tool contract per docs/AGENT-TEMPLATES.md §3.
 */

import type { ContentBlock } from '@kagent/agent-loop';
import { defineInProcessTool, InProcessToolProvider } from '@kagent/in-process-tool-provider';
import type { InProcessToolDefinition } from '@kagent/in-process-tool-provider';

export interface EnsureAgentToolDeps {
  /** URL of the operator's template-server (e.g. http://kagent-operator-template-server.kagent-system.svc.cluster.local:8081). */
  readonly serverUrl: string;
  /** Caller's task UID — threaded into createdByTaskUid for the audit annotation. */
  readonly createdByTaskUid: string;
  /** Test-injectable fetch. Production: global fetch. */
  readonly fetch?: typeof fetch;
}

interface EnsureArgs {
  readonly templateName: string;
  readonly parameterValues: Readonly<Record<string, string>>;
  readonly instanceName?: string;
}

/** Cap on a single instantiate POST — keeps a hung operator from pinning the pod. */
const POST_TIMEOUT_MS = 15_000;

export function defineEnsureAgentFromTemplate(deps: EnsureAgentToolDeps): InProcessToolDefinition {
  return defineInProcessTool({
    name: 'ensure_agent_from_template',
    description:
      'Materialize an Agent CR from an AgentTemplate the cluster admin ' +
      'authored in GitOps. Returns {agentName, namespace, reused, ' +
      'templateRef, parameterHash}. Idempotent — calling twice with the ' +
      'same parameterValues returns reused=true and the same agentName. ' +
      'You can then call spawn_child_task with the returned agentName. ' +
      'Refuses unknown / missing / invalid parameters with a structured error.',
    inputSchema: {
      type: 'object',
      required: ['templateName', 'parameterValues'],
      properties: {
        templateName: { type: 'string', minLength: 1, maxLength: 253 },
        parameterValues: {
          type: 'object',
          additionalProperties: { type: 'string' },
        },
        instanceName: { type: 'string', minLength: 1, maxLength: 63 },
      },
      additionalProperties: false,
    },
    tags: ['substrate', 'templates', 'write'],
    handler: async (rawArgs, ctx) => {
      const args = parseArgs(rawArgs);
      const fetchImpl = deps.fetch ?? fetch;

      const url = `${deps.serverUrl.replace(/\/+$/, '')}/v1alpha1/templates/${encodeURIComponent(args.templateName)}:instantiate`;

      const body = {
        parameterValues: args.parameterValues,
        createdByTaskUid: deps.createdByTaskUid,
        ...(args.instanceName !== undefined && { instanceName: args.instanceName }),
      };

      const timeoutSignal = AbortSignal.timeout(POST_TIMEOUT_MS);
      const signal = AbortSignal.any([ctx.abortSignal, timeoutSignal]);

      let res: Response;
      try {
        res = await fetchImpl(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
          signal,
        });
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        throw new Error(`ensure_agent_from_template: request failed: ${message}`);
      }

      const text = await res.text();
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        throw new Error(
          `ensure_agent_from_template: server returned non-JSON ${String(res.status)}: ${text.slice(0, 200)}`,
        );
      }

      if (res.status >= 200 && res.status < 300) {
        return jsonContent(parsed);
      }

      const errBody = parsed as { code?: string; message?: string };
      throw new Error(
        `policy_denied: ${errBody.code ?? 'unknown'}: ${errBody.message ?? 'no message'}`,
      );
    },
  });
}

export function buildTemplateToolProvider(deps: EnsureAgentToolDeps): InProcessToolProvider {
  return new InProcessToolProvider({
    id: 'kagent-substrate-template',
    tools: [defineEnsureAgentFromTemplate(deps)],
  });
}

function parseArgs(raw: Record<string, unknown>): EnsureArgs {
  const templateName = raw.templateName;
  if (typeof templateName !== 'string' || templateName.length === 0) {
    throw new Error('ensure_agent_from_template: templateName is required');
  }
  const parameterValues = raw.parameterValues;
  if (
    parameterValues === null ||
    typeof parameterValues !== 'object' ||
    Array.isArray(parameterValues)
  ) {
    throw new Error('ensure_agent_from_template: parameterValues must be an object');
  }
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(parameterValues as Record<string, unknown>)) {
    if (typeof v !== 'string') {
      throw new Error(
        `ensure_agent_from_template: parameter "${k}" must be a string (got ${typeof v})`,
      );
    }
    out[k] = v;
  }
  const instanceName = raw.instanceName;
  return {
    templateName,
    parameterValues: out,
    ...(typeof instanceName === 'string' && instanceName.length > 0 && { instanceName }),
  };
}

function jsonContent(value: unknown): ContentBlock[] {
  return [{ type: 'text', text: JSON.stringify(value) }];
}

export { InProcessToolProvider };
