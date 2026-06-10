/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/**
 * Workbench channel sessions.
 *
 * This route intentionally stores no second copy of runtime state.
 * A "session" is the ordered projection of AgentTasks stamped with
 * channel labels. Sending a message creates another AgentTask, so the
 * controller path stays governed by the same operator, gateway, quota,
 * trace, and kill-switch mechanisms as every other workload.
 */

import { Hono } from 'hono';
import type { CustomObjectsApi } from '@kubernetes/client-node';

import { API_GROUP_VERSION, type Agent, type AgentTask } from '@kagent/dto';

import type { SnapshotCache } from '../cache.js';

const KAGENT_GROUP = 'kagent.knuteson.io';
const KAGENT_VERSION = 'v1alpha1';
const AGENTTASK_PLURAL = 'agenttasks';

const CHANNEL_LABEL = 'kagent.knuteson.io/channel';
const SESSION_LABEL = 'kagent.knuteson.io/channel-session';
const TURN_LABEL = 'kagent.knuteson.io/channel-turn';
const CREATED_BY_LABEL = 'app.kubernetes.io/created-by';
const MANAGED_BY_LABEL = 'kagent.knuteson.io/managed-by';
const MESSAGE_ANNOTATION = 'kagent.knuteson.io/channel-message';

const CHANNEL = 'workbench';
const CREATED_BY = 'kagent-workbench-channel';
const MAX_MESSAGE_BYTES = 32_768;
const MAX_HISTORY_CHARS = 8_000;
const NAME_RE = /^[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?$/;
const DEFAULT_TIMEOUT_SECONDS = 300;
const DEFAULT_MAX_ITERATIONS = 8;

export interface SessionsRouteDeps {
  readonly cache: SnapshotCache;
  readonly customApi?: CustomObjectsApi;
  readonly defaultNamespace?: string;
  readonly generateName?: () => string;
}

interface SessionSummary {
  readonly id: string;
  readonly namespace?: string;
  readonly targetAgent?: string;
  readonly turnCount: number;
  readonly lastPhase?: string;
  readonly lastActivityAt?: string;
  readonly lastMessagePreview?: string;
}

interface SessionTaskLink {
  readonly namespace: string;
  readonly name: string;
  readonly uid: string;
  readonly phase?: string;
  readonly ui: string;
}

interface SessionMessage {
  readonly id: string;
  readonly role: 'user' | 'assistant';
  readonly content: string;
  readonly createdAt?: string;
  readonly task?: SessionTaskLink;
}

interface SessionRunConfig {
  readonly timeoutSeconds?: number;
  readonly maxIterations?: number;
}

interface SessionProfile {
  readonly id: string;
  readonly profileName: string;
  readonly source: 'Agent';
  readonly targetAgent: string;
  readonly namespace: string;
  readonly model?: string;
  readonly modelClass?: string;
  readonly toolProfileRef?: string;
  readonly sandboxProfile: 'default' | 'strict';
  readonly capabilities: readonly string[];
  readonly tools: readonly string[];
  readonly defaults: {
    readonly runConfig: {
      readonly timeoutSeconds: number;
      readonly maxIterations: number;
    };
  };
  readonly launchability: {
    readonly state: 'ready';
    readonly reasons: readonly string[];
  };
}

interface SessionDetail extends SessionSummary {
  readonly messages: readonly SessionMessage[];
}

interface SendMessageRequest {
  readonly targetAgent: string;
  readonly message: string;
  readonly namespace?: string;
  readonly runConfig?: SessionRunConfig;
}

function defaultGenerateName(): string {
  const alpha = 'abcdefghijklmnopqrstuvwxyz0123456789';
  const buf = new Uint8Array(8);
  globalThis.crypto.getRandomValues(buf);
  let suffix = '';
  for (const b of buf) suffix += alpha[b % alpha.length];
  return `chat-${suffix}`;
}

export function sessionsRoute(deps: SessionsRouteDeps): Hono {
  const app = new Hono();

  app.get('/api/sessions', (c) => {
    const sessions = buildSessionSummaries(deps.cache.listTasks());
    return c.json({ items: sessions });
  });

  app.get('/api/session-profiles', (c) => {
    return c.json({ items: buildSessionProfiles(deps.cache.listAgents()) });
  });

  app.get('/api/sessions/:sessionId', (c) => {
    const sessionId = c.req.param('sessionId');
    if (!isValidName(sessionId)) return c.json({ error: 'invalid-session-id', sessionId }, 400);
    const detail = buildSessionDetail(sessionId, deps.cache.listTasks());
    if (detail === undefined) return c.json({ error: 'not-found', sessionId }, 404);
    return c.json(detail);
  });

  app.post('/api/sessions/:sessionId/messages', async (c) => {
    if (deps.customApi === undefined) {
      return c.json(
        {
          error:
            'write surface disabled (no CustomObjects client configured); set actions.create=true on the chart',
        },
        503,
      );
    }

    const sessionId = c.req.param('sessionId');
    if (!isValidName(sessionId)) return c.json({ error: 'invalid-session-id', sessionId }, 400);

    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      return c.json({ error: 'request body is not valid JSON' }, 400);
    }

    const parsed = validateSendMessageBody(raw);
    if (!parsed.valid)
      return c.json({ error: 'request body failed validation', fields: parsed.errors }, 400);

    const req = parsed.value;
    const namespace = req.namespace ?? deps.defaultNamespace ?? 'default';
    const targetAgent = req.targetAgent;
    const agent = deps.cache.getAgent(namespace, targetAgent);
    if (agent === undefined && hasNamespaceLoadedAgents(deps.cache, namespace)) {
      return c.json({ error: `agent "${targetAgent}" not found in namespace "${namespace}"` }, 404);
    }

    const name = (deps.generateName ?? defaultGenerateName)();
    const messages = buildSessionDetail(sessionId, deps.cache.listTasks())?.messages ?? [];
    const originalUserMessage = composeControllerMessage(sessionId, messages, req.message);

    const manifest: Record<string, unknown> = {
      apiVersion: API_GROUP_VERSION,
      kind: 'AgentTask',
      metadata: {
        name,
        namespace,
        labels: {
          [MANAGED_BY_LABEL]: 'kagent-operator',
          [CREATED_BY_LABEL]: CREATED_BY,
          [CHANNEL_LABEL]: CHANNEL,
          [SESSION_LABEL]: sessionId,
          [TURN_LABEL]: name,
        },
        annotations: {
          [MESSAGE_ANNOTATION]: req.message,
        },
      },
      spec: {
        targetAgent,
        originalUserMessage,
        payload: {
          channel: CHANNEL,
          sessionId,
          message: req.message,
        },
        ...(req.runConfig !== undefined && { runConfig: req.runConfig }),
      },
    };

    try {
      const created: unknown = await deps.customApi.createNamespacedCustomObject({
        group: KAGENT_GROUP,
        version: KAGENT_VERSION,
        namespace,
        plural: AGENTTASK_PLURAL,
        body: manifest,
      });
      const meta = readCreatedMeta(created);
      return c.json(
        {
          sessionId,
          task: {
            namespace: meta.namespace ?? namespace,
            name: meta.name ?? name,
            uid: meta.uid ?? '',
            createdAt: meta.creationTimestamp ?? new Date().toISOString(),
            phase: 'Pending',
            ui: `/#/tasks/${encodeURIComponent(meta.namespace ?? namespace)}/${encodeURIComponent(meta.name ?? name)}`,
          },
        },
        201,
      );
    } catch (err: unknown) {
      const status = extractK8sStatus(err);
      if (status === 403) {
        return c.json(
          {
            error: `RBAC denied: workbench-api ServiceAccount cannot create AgentTask in ${namespace}`,
          },
          403,
        );
      }
      if (status === 404) {
        return c.json(
          { error: `namespace "${namespace}" not found, or AgentTask CRD not installed` },
          404,
        );
      }
      if (status === 409) {
        return c.json({ error: `AgentTask ${namespace}/${name} already exists` }, 409);
      }
      const detail = err instanceof Error ? err.message : String(err);
      console.error(
        '[workbench-api] POST /api/sessions/:sessionId/messages — unhandled K8s API error',
        JSON.stringify({
          namespace,
          name,
          sessionId,
          targetAgent,
          status: status ?? null,
          message: detail,
        }),
      );
      return c.json(
        { error: 'internal error processing session message; see workbench-api logs' },
        500,
      );
    }
  });

  return app;
}

function buildSessionProfiles(agents: readonly Agent[]): readonly SessionProfile[] {
  return agents
    .map((agent) => {
      const namespace = agent.metadata.namespace ?? 'default';
      const targetAgent = agent.metadata.name ?? '';
      const profileName = agent.spec.agentType ?? agent.spec.toolProfileRef ?? targetAgent;
      const out: SessionProfile = {
        id: `agent:${namespace}/${targetAgent}`,
        profileName,
        source: 'Agent',
        targetAgent,
        namespace,
        ...(agent.spec.model !== undefined && { model: agent.spec.model }),
        ...(agent.spec.modelClass !== undefined && { modelClass: agent.spec.modelClass }),
        ...(agent.spec.toolProfileRef !== undefined && {
          toolProfileRef: agent.spec.toolProfileRef,
        }),
        sandboxProfile: agent.spec.sandboxProfile ?? 'default',
        capabilities: agent.spec.capabilities ?? [],
        tools: agent.spec.tools ?? [],
        defaults: {
          runConfig: {
            timeoutSeconds: DEFAULT_TIMEOUT_SECONDS,
            maxIterations: DEFAULT_MAX_ITERATIONS,
          },
        },
        launchability: { state: 'ready', reasons: [] },
      };
      return out;
    })
    .sort((a, b) => a.profileName.localeCompare(b.profileName) || a.id.localeCompare(b.id));
}

function buildSessionSummaries(tasks: readonly AgentTask[]): readonly SessionSummary[] {
  const byId = new Map<string, AgentTask[]>();
  for (const task of tasks) {
    const id = task.metadata.labels?.[SESSION_LABEL];
    if (task.metadata.labels?.[CHANNEL_LABEL] !== CHANNEL || id === undefined || !isValidName(id)) {
      continue;
    }
    const arr = byId.get(id) ?? [];
    arr.push(task);
    byId.set(id, arr);
  }

  const summaries = Array.from(byId.entries()).map(([id, sessionTasks]) =>
    summarizeSession(id, sortTasksAsc(sessionTasks)),
  );
  return summaries.sort((a, b) => compareIsoDesc(a.lastActivityAt, b.lastActivityAt));
}

function buildSessionDetail(
  sessionId: string,
  tasks: readonly AgentTask[],
): SessionDetail | undefined {
  const sessionTasks = sortTasksAsc(
    tasks.filter(
      (t) =>
        t.metadata.labels?.[CHANNEL_LABEL] === CHANNEL &&
        t.metadata.labels?.[SESSION_LABEL] === sessionId,
    ),
  );
  if (sessionTasks.length === 0) return undefined;
  const summary = summarizeSession(sessionId, sessionTasks);
  const messages: SessionMessage[] = [];
  for (const task of sessionTasks) {
    const link = taskLink(task);
    const userContent =
      task.metadata.annotations?.[MESSAGE_ANNOTATION] ?? task.spec.originalUserMessage ?? '';
    if (userContent.length > 0) {
      messages.push({
        id: `${link.name}:user`,
        role: 'user',
        content: userContent,
        ...(task.metadata.creationTimestamp !== undefined && {
          createdAt: iso(task.metadata.creationTimestamp),
        }),
        task: link,
      });
    }

    const assistant = assistantContent(task);
    if (assistant !== undefined) {
      messages.push({
        id: `${link.name}:assistant`,
        role: 'assistant',
        content: assistant,
        ...(task.status?.completedAt !== undefined
          ? { createdAt: task.status.completedAt }
          : task.metadata.creationTimestamp !== undefined
            ? { createdAt: iso(task.metadata.creationTimestamp) }
            : {}),
        task: link,
      });
    }
  }
  return { ...summary, messages };
}

function summarizeSession(id: string, tasksAsc: readonly AgentTask[]): SessionSummary {
  const latest = tasksAsc[tasksAsc.length - 1];
  const latestAssistant = latest !== undefined ? assistantContent(latest) : undefined;
  const latestMessage =
    latest?.metadata.annotations?.[MESSAGE_ANNOTATION] ?? latest?.spec.originalUserMessage;
  const lastActivityAt = latest !== undefined ? taskActivityAt(latest) : undefined;
  return {
    id,
    ...(latest?.metadata.namespace !== undefined && { namespace: latest.metadata.namespace }),
    ...(latest?.spec.targetAgent !== undefined && { targetAgent: latest.spec.targetAgent }),
    turnCount: tasksAsc.length,
    ...(latest?.status?.phase !== undefined && { lastPhase: latest.status.phase }),
    ...(lastActivityAt !== undefined && { lastActivityAt }),
    ...(latestAssistant !== undefined || latestMessage !== undefined
      ? { lastMessagePreview: preview(latestAssistant ?? latestMessage ?? '') }
      : {}),
  };
}

function sortTasksAsc(tasks: readonly AgentTask[]): readonly AgentTask[] {
  return [...tasks].sort((a, b) =>
    compareIsoAsc(isoMaybe(a.metadata.creationTimestamp), isoMaybe(b.metadata.creationTimestamp)),
  );
}

function assistantContent(task: AgentTask): string | undefined {
  if (task.status?.error !== undefined && task.status.error.length > 0) return task.status.error;
  const result = task.status?.result;
  if (result === undefined || result === null) return undefined;
  if (typeof result === 'string') return result;
  if (typeof result === 'object') {
    const content = (result as Record<string, unknown>).content;
    if (typeof content === 'string') return content;
  }
  if (
    typeof result === 'number' ||
    typeof result === 'boolean' ||
    typeof result === 'bigint' ||
    typeof result === 'symbol'
  ) {
    return result.toString();
  }
  try {
    return JSON.stringify(result);
  } catch {
    return '[unserializable result]';
  }
}

function taskLink(task: AgentTask): SessionTaskLink {
  const namespace = task.metadata.namespace ?? 'default';
  const name = task.metadata.name ?? '';
  return {
    namespace,
    name,
    uid: task.metadata.uid ?? '',
    ...(task.status?.phase !== undefined && { phase: task.status.phase }),
    ui: `/#/tasks/${encodeURIComponent(namespace)}/${encodeURIComponent(name)}`,
  };
}

function composeControllerMessage(
  sessionId: string,
  previousMessages: readonly SessionMessage[],
  message: string,
): string {
  const historyLines = previousMessages
    .slice(-12)
    .map((m) => `${m.role === 'user' ? 'User' : 'Controller'}: ${m.content}`)
    .join('\n');
  const history =
    historyLines.length > MAX_HISTORY_CHARS
      ? historyLines.slice(historyLines.length - MAX_HISTORY_CHARS)
      : historyLines;
  return [
    `Session: ${sessionId}`,
    'You are the kagent controller channel. Answer the operator directly and create or inspect work only through your configured substrate tools.',
    history.length > 0 ? `Recent session history:\n${history}` : 'Recent session history: <none>',
    `User message:\n${message}`,
  ].join('\n\n');
}

type SendMessageValidation =
  | { readonly valid: true; readonly value: SendMessageRequest }
  | {
      readonly valid: false;
      readonly errors: readonly {
        readonly code: string;
        readonly field: string;
        readonly detail?: string;
      }[];
    };

function validateSendMessageBody(raw: unknown): SendMessageValidation {
  const errors: Array<{ code: string; field: string; detail?: string }> = [];
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { valid: false, errors: [{ code: 'wrong-type', field: '<body>', detail: 'object' }] };
  }
  const body = raw as Record<string, unknown>;
  const targetAgent = readName(body.targetAgent, 'targetAgent', errors);
  const namespace =
    body.namespace === undefined || body.namespace === null
      ? undefined
      : readName(body.namespace, 'namespace', errors);
  const message = body.message;
  if (message === undefined || message === null) {
    errors.push({ code: 'missing', field: 'message' });
  } else if (typeof message !== 'string') {
    errors.push({ code: 'wrong-type', field: 'message', detail: 'string' });
  } else if (message.length === 0) {
    errors.push({ code: 'empty', field: 'message' });
  } else if (Buffer.byteLength(message, 'utf8') > MAX_MESSAGE_BYTES) {
    errors.push({ code: 'too-long', field: 'message', detail: String(MAX_MESSAGE_BYTES) });
  }

  let runConfig: SessionRunConfig | undefined;
  if (body.runConfig !== undefined && body.runConfig !== null) {
    if (typeof body.runConfig !== 'object' || Array.isArray(body.runConfig)) {
      errors.push({ code: 'wrong-type', field: 'runConfig', detail: 'object' });
    } else {
      const rc = body.runConfig as Record<string, unknown>;
      const out: { timeoutSeconds?: number; maxIterations?: number } = {};
      if (rc.timeoutSeconds !== undefined && rc.timeoutSeconds !== null) {
        if (
          typeof rc.timeoutSeconds !== 'number' ||
          !Number.isInteger(rc.timeoutSeconds) ||
          rc.timeoutSeconds < 1 ||
          rc.timeoutSeconds > 86_400
        ) {
          errors.push({ code: 'out-of-range', field: 'runConfig.timeoutSeconds' });
        } else {
          out.timeoutSeconds = rc.timeoutSeconds;
        }
      }
      if (rc.maxIterations !== undefined && rc.maxIterations !== null) {
        if (
          typeof rc.maxIterations !== 'number' ||
          !Number.isInteger(rc.maxIterations) ||
          rc.maxIterations < 1 ||
          rc.maxIterations > 100
        ) {
          errors.push({ code: 'out-of-range', field: 'runConfig.maxIterations' });
        } else {
          out.maxIterations = rc.maxIterations;
        }
      }
      if (Object.keys(out).length > 0) runConfig = out;
    }
  }

  if (errors.length > 0 || targetAgent === undefined) return { valid: false, errors };
  return {
    valid: true,
    value: {
      targetAgent,
      message: message as string,
      ...(namespace !== undefined && { namespace }),
      ...(runConfig !== undefined && { runConfig }),
    },
  };
}

function readName(
  value: unknown,
  field: string,
  errors: Array<{ code: string; field: string; detail?: string }>,
): string | undefined {
  if (value === undefined || value === null) {
    errors.push({ code: 'missing', field });
    return undefined;
  }
  if (typeof value !== 'string') {
    errors.push({ code: 'wrong-type', field, detail: 'string' });
    return undefined;
  }
  if (value.length === 0) {
    errors.push({ code: 'empty', field });
    return undefined;
  }
  if (!isValidName(value)) {
    errors.push({ code: 'invalid-name', field });
    return undefined;
  }
  return value;
}

function hasNamespaceLoadedAgents(cache: SnapshotCache, namespace: string): boolean {
  return cache.listAgents().some((agent) => (agent.metadata.namespace ?? 'default') === namespace);
}

function readCreatedMeta(created: unknown): {
  readonly name?: string;
  readonly namespace?: string;
  readonly uid?: string;
  readonly creationTimestamp?: string;
} {
  if (created !== null && typeof created === 'object') {
    const meta = (created as { metadata?: unknown }).metadata;
    if (meta !== null && typeof meta === 'object') {
      const m = meta as Record<string, unknown>;
      return {
        ...(typeof m.name === 'string' && { name: m.name }),
        ...(typeof m.namespace === 'string' && { namespace: m.namespace }),
        ...(typeof m.uid === 'string' && { uid: m.uid }),
        ...(typeof m.creationTimestamp === 'string' && { creationTimestamp: m.creationTimestamp }),
      };
    }
  }
  return {};
}

function extractK8sStatus(err: unknown): number | undefined {
  if (err !== null && typeof err === 'object') {
    const code = (err as { code?: unknown }).code;
    if (typeof code === 'number') return code;
    const body = (err as { body?: unknown }).body;
    if (body !== null && typeof body === 'object') {
      const bodyCode = (body as { code?: unknown }).code;
      if (typeof bodyCode === 'number') return bodyCode;
    }
  }
  return undefined;
}

function isValidName(value: string): boolean {
  return NAME_RE.test(value);
}

function preview(value: string): string {
  const oneLine = value.replace(/\s+/g, ' ').trim();
  return oneLine.length > 120 ? `${oneLine.slice(0, 117)}...` : oneLine;
}

function taskActivityAt(task: AgentTask): string | undefined {
  return task.status?.completedAt ?? isoMaybe(task.metadata.creationTimestamp);
}

function isoMaybe(value: Date | string | undefined): string | undefined {
  if (value === undefined) return undefined;
  return iso(value);
}

function iso(value: Date | string): string {
  return typeof value === 'string' ? value : value.toISOString();
}

function compareIsoAsc(a: string | undefined, b: string | undefined): number {
  const am = a === undefined ? 0 : Date.parse(a);
  const bm = b === undefined ? 0 : Date.parse(b);
  return am - bm;
}

function compareIsoDesc(a: string | undefined, b: string | undefined): number {
  return compareIsoAsc(b, a);
}
