/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/**
 * The fleet authority's narrow, advisory-only AgentTask boundary. The caller
 * owns Kubernetes credentials and grants create/get only in kagent-system;
 * neither a model answer nor this adapter can issue lab or release authority.
 */
import { createHash } from 'node:crypto';

import type { AgentTask } from './crds/index.js';
import { API_GROUP_VERSION, isAgentTask } from './crds/index.js';

const NAMESPACE = 'kagent-system';
const AGENT = 'fleet-question-researcher';
const DIGEST_ANNOTATION = 'fleet.knuteson.io/question-digest';
const REPOSITORIES = new Set(['ctkadvisors/new_localai', 'ctkadvisors/kagent']);

export interface AdvisoryQuestion {
  readonly id: string;
  readonly repository: string;
  readonly source: { readonly kind: 'forum' | 'observation'; readonly ref: string };
  readonly question: string;
  readonly report: string;
  readonly evidence: readonly { readonly id: string; readonly summary: string }[];
}

export interface AdvisoryReceipt {
  readonly namespace: string;
  readonly name: string;
  readonly uid: string;
  readonly digest: string;
  readonly evidenceIds: readonly string[];
}

export interface AdvisoryTaskStore {
  create(task: AgentTask): Promise<AgentTask>;
  get(namespace: string, name: string): Promise<AgentTask | undefined>;
}

interface AdvisoryCustomObjectsApi {
  createNamespacedCustomObject(args: {
    group: string;
    version: string;
    namespace: string;
    plural: string;
    body: AgentTask;
  }): Promise<unknown>;
  getNamespacedCustomObject(args: {
    group: string;
    version: string;
    namespace: string;
    plural: string;
    name: string;
  }): Promise<unknown>;
}

const TASK_NAME = /^fleet-question-[a-f0-9]{24}$/u;

/** The Kubernetes port has no generic CR or cross-namespace operation. */
export function kubernetesAdvisoryTaskStore(api: AdvisoryCustomObjectsApi): AdvisoryTaskStore {
  return {
    async create(task) {
      const digest = task.metadata.annotations?.[DIGEST_ANNOTATION];
      if (
        task.metadata.namespace !== NAMESPACE ||
        !TASK_NAME.test(task.metadata.name ?? '') ||
        task.spec.targetAgent !== AGENT ||
        typeof digest !== 'string' ||
        task.spec.idempotencyKey !== digest ||
        createHash('sha256').update(JSON.stringify(task.spec.payload)).digest('hex') !== digest
      ) {
        throw new Error('invalid advisory task');
      }
      const created: unknown = await api.createNamespacedCustomObject({
        group: 'kagent.knuteson.io',
        version: 'v1alpha1',
        namespace: NAMESPACE,
        plural: 'agenttasks',
        body: task,
      });
      if (!isAgentTask(created)) throw new Error('invalid AgentTask response');
      return created;
    },
    async get(namespace, name) {
      if (namespace !== NAMESPACE || !TASK_NAME.test(name))
        throw new Error('invalid advisory namespace or name');
      let task: unknown;
      try {
        task = await api.getNamespacedCustomObject({
          group: 'kagent.knuteson.io',
          version: 'v1alpha1',
          namespace: NAMESPACE,
          plural: 'agenttasks',
          name,
        });
      } catch (error) {
        const status =
          (error as { statusCode?: unknown; code?: unknown }).statusCode ??
          (error as { code?: unknown }).code;
        if (status === 404) return undefined;
        throw error;
      }
      if (task === undefined) return undefined;
      if (!isAgentTask(task)) throw new Error('invalid AgentTask response');
      return task;
    },
  };
}

function bounded(value: unknown, field: string, max: number): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > max) {
    throw new Error(`invalid ${field}`);
  }
  return value.trim();
}

function normalize(question: AdvisoryQuestion) {
  const id = bounded(question.id, 'id', 120);
  const repository = bounded(question.repository, 'repository', 100);
  if (!REPOSITORIES.has(repository)) throw new Error('forbidden repository');
  const kind = question.source?.kind;
  if (kind !== 'forum' && kind !== 'observation') throw new Error('invalid source kind');
  const ref = bounded(question.source.ref, 'source ref', 200);
  const query = bounded(question.question, 'question', 1200);
  const report = bounded(question.report, 'report', 8192);
  if (
    !Array.isArray(question.evidence) ||
    question.evidence.length < 1 ||
    question.evidence.length > 12
  ) {
    throw new Error('invalid evidence count');
  }
  const evidence = (question.evidence as readonly { id: string; summary: string }[]).map(
    (item) => ({
      id: bounded(item.id, 'evidence id', 120),
      summary: bounded(item.summary, 'evidence summary', 2048),
    }),
  );
  if (new Set(evidence.map((item) => item.id)).size !== evidence.length) {
    throw new Error('duplicate evidence id');
  }
  return {
    contract: 'fleet-advisory-question/v1',
    id,
    repository,
    source: { kind, ref },
    question: query,
    report,
    evidence,
  };
}

/** Stable name and digest make a retry of the same question a replay. */
export function buildAdvisoryTask(question: AdvisoryQuestion): AgentTask {
  const payload = normalize(question);
  const digest = createHash('sha256').update(JSON.stringify(payload)).digest('hex');
  return {
    apiVersion: API_GROUP_VERSION,
    kind: 'AgentTask',
    metadata: {
      name: `fleet-question-${digest.slice(0, 24)}`,
      namespace: NAMESPACE,
      annotations: { [DIGEST_ANNOTATION]: digest },
      labels: { 'kagent.knuteson.io/tenant': 'homelab' },
    },
    spec: {
      targetAgent: AGENT,
      payload,
      idempotencyKey: digest,
      runConfig: { maxIterations: 16, timeoutSeconds: 900 },
    },
  };
}

function sameTask(actual: AgentTask, expected: AgentTask): boolean {
  return (
    actual.metadata.namespace === expected.metadata.namespace &&
    actual.metadata.name === expected.metadata.name &&
    actual.metadata.annotations?.[DIGEST_ANNOTATION] ===
      expected.metadata.annotations?.[DIGEST_ANNOTATION] &&
    JSON.stringify(actual.spec) === JSON.stringify(expected.spec)
  );
}

/** Create, or recover the exact matching task after an uncertain response. */
export async function dispatchAdvisoryQuestion(
  store: AdvisoryTaskStore,
  question: AdvisoryQuestion,
): Promise<AdvisoryReceipt> {
  const expected = buildAdvisoryTask(question);
  let created: AgentTask;
  try {
    created = await store.create(expected);
  } catch (error) {
    const existing = await store.get(NAMESPACE, expected.metadata.name!);
    if (existing === undefined) throw error;
    created = existing;
  }
  if (!sameTask(created, expected) || !created.metadata.uid) {
    throw new Error('advisory task conflict');
  }
  const payload = expected.spec.payload as ReturnType<typeof normalize>;
  return {
    namespace: NAMESPACE,
    name: expected.metadata.name!,
    uid: created.metadata.uid,
    digest: expected.spec.idempotencyKey!,
    evidenceIds: payload.evidence.map((item) => item.id),
  };
}

export type AdvisoryResult =
  | { readonly state: 'pending' | 'stale' | 'invalid' }
  | { readonly state: 'failed'; readonly error: string }
  | {
      readonly state: 'completed';
      readonly hypotheses: readonly {
        readonly predicate: string;
        readonly scope: string;
        readonly prediction: string;
        readonly evidenceIds: readonly string[];
        readonly sampleCount: 0;
        readonly status: 'unverified';
      }[];
      readonly plan: readonly string[];
    };

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key)) && keys.every((key) => key in value);
}

function parseResult(content: unknown, receipt: AdvisoryReceipt): AdvisoryResult {
  if (typeof content !== 'string' || content.length > 16384) return { state: 'invalid' };
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return { state: 'invalid' };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed))
    return { state: 'invalid' };
  const output = parsed as Record<string, unknown>;
  if (
    !exactKeys(output, ['hypotheses', 'plan']) ||
    !Array.isArray(output.hypotheses) ||
    !Array.isArray(output.plan) ||
    output.hypotheses.length > 5 ||
    output.plan.length > 5
  )
    return { state: 'invalid' };
  const hypotheses: Extract<AdvisoryResult, { state: 'completed' }>['hypotheses'][number][] = [];
  for (const item of output.hypotheses) {
    if (typeof item !== 'object' || item === null || Array.isArray(item))
      return { state: 'invalid' };
    const claim = item as Record<string, unknown>;
    if (
      !exactKeys(claim, ['predicate', 'scope', 'prediction', 'evidenceIds']) ||
      !Array.isArray(claim.evidenceIds) ||
      claim.evidenceIds.length > 12
    )
      return { state: 'invalid' };
    if (
      !claim.evidenceIds.every((id) => typeof id === 'string' && receipt.evidenceIds.includes(id))
    )
      return { state: 'invalid' };
    try {
      hypotheses.push({
        predicate: bounded(claim.predicate, 'predicate', 1000),
        scope: bounded(claim.scope, 'scope', 500),
        prediction: bounded(claim.prediction, 'prediction', 1000),
        evidenceIds: claim.evidenceIds,
        sampleCount: 0,
        status: 'unverified',
      });
    } catch {
      return { state: 'invalid' };
    }
  }
  let plan: string[];
  try {
    plan = output.plan.map((step) => bounded(step, 'plan step', 1000));
  } catch {
    return { state: 'invalid' };
  }
  return { state: 'completed', hypotheses, plan };
}

/** Result text is model output. It is always advisory, even on Completed. */
export function readAdvisoryResult(
  task: AgentTask | undefined,
  receipt: AdvisoryReceipt,
): AdvisoryResult {
  if (
    task === undefined ||
    task.metadata.namespace !== receipt.namespace ||
    task.metadata.name !== receipt.name ||
    task.metadata.uid !== receipt.uid ||
    task.metadata.annotations?.[DIGEST_ANNOTATION] !== receipt.digest ||
    task.spec.idempotencyKey !== receipt.digest ||
    task.spec.targetAgent !== AGENT
  )
    return { state: 'stale' };
  try {
    const payload = normalize(task.spec.payload as AdvisoryQuestion);
    const digest = createHash('sha256').update(JSON.stringify(payload)).digest('hex');
    if (
      digest !== receipt.digest ||
      JSON.stringify(payload.evidence.map((item) => item.id)) !==
        JSON.stringify(receipt.evidenceIds)
    ) {
      return { state: 'stale' };
    }
  } catch {
    return { state: 'stale' };
  }
  if (task.status?.phase === 'Failed')
    return {
      state: 'failed',
      error: String(task.status.error ?? 'AgentTask failed').slice(0, 1000),
    };
  if (task.status?.phase !== 'Completed') return { state: 'pending' };
  const result = task.status.result as { content?: unknown } | undefined;
  return parseResult(result?.content, receipt);
}
