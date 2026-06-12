/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/**
 * In-memory snapshot store. The Workbench API facade keeps the most
 * recent observed `AgentTask`, `Agent`, `Job`, and `Pod` objects in a
 * cluster-wide map keyed by `<namespace>/<name>` (CRs) or `<namespace>/<name>`
 * (Job/Pod). HTTP routes serve from the cache instead of round-tripping
 * to the API server on every request — the informers behind the cache
 * keep it fresh.
 *
 * Why a hand-rolled cache instead of using the informer's built-in
 * Indexer:
 *
 *   - We need to join across kinds (Task → Agent → Job → Pod) at
 *     request time, and the informer cache only indexes by single-kind
 *     keys. A pure read-side projection layer is easier to test.
 *   - SSE subscribers (`./sse.ts`) want `recordChanged` change-notifications;
 *     wiring those off raw informer events would scatter the projection
 *     logic across two places. Centralizing here keeps `routes/*.ts`
 *     ignorant of K8s plumbing.
 *
 * Concurrency: Node's single-threaded event loop guarantees no torn
 * reads here. If we ever move informers to worker threads, the cache
 * becomes a concurrent structure and this comment must be revisited.
 */

import type { V1Job, V1Pod } from '@kubernetes/client-node';

import type { Agent, AgentTask, Channel, ChannelBinding, ChannelSession } from '@kagent/dto';

/** Stable composite key — `<namespace>/<name>`. Used for all kinds. */
export type CacheKey = string;

export function cacheKey(namespace: string | undefined, name: string | undefined): CacheKey {
  return `${namespace ?? 'default'}/${name ?? ''}`;
}

/**
 * Listener invoked after every cache mutation. The Workbench's SSE
 * stream uses this to push a fan-out event to every connected client.
 *
 * `kind` lets a UI filter — a TaskList only cares about 'task' events.
 * `key` lets the UI cheaply patch a single row.
 */
export interface CacheChangeEvent {
  readonly kind: 'task' | 'agent' | 'job' | 'pod' | 'channel' | 'channelBinding' | 'channelSession';
  readonly op: 'upsert' | 'delete';
  readonly key: CacheKey;
}

export type CacheListener = (event: CacheChangeEvent) => void;

/**
 * Snapshot store. All mutators are O(1); list reads are O(n) over the
 * relevant map. n stays small (single-cluster homelab; v0.2 multi-tenant
 * gets pagination + ETag). No eviction policy in v0.1 — the informer
 * delete events are the source of truth for removal.
 */
export class SnapshotCache {
  private readonly tasks = new Map<CacheKey, AgentTask>();
  private readonly agents = new Map<CacheKey, Agent>();
  private readonly channels = new Map<CacheKey, Channel>();
  private readonly channelBindings = new Map<CacheKey, ChannelBinding>();
  private readonly channelSessions = new Map<CacheKey, ChannelSession>();
  private readonly jobs = new Map<CacheKey, V1Job>();
  private readonly pods = new Map<CacheKey, V1Pod>();
  private readonly listeners = new Set<CacheListener>();

  /* ----- Tasks ----- */

  upsertTask(task: AgentTask): void {
    const key = cacheKey(task.metadata.namespace, task.metadata.name);
    this.tasks.set(key, task);
    this.emit({ kind: 'task', op: 'upsert', key });
  }

  deleteTask(task: AgentTask): void {
    const key = cacheKey(task.metadata.namespace, task.metadata.name);
    if (this.tasks.delete(key)) {
      this.emit({ kind: 'task', op: 'delete', key });
    }
  }

  getTask(namespace: string, name: string): AgentTask | undefined {
    return this.tasks.get(cacheKey(namespace, name));
  }

  listTasks(): readonly AgentTask[] {
    return Array.from(this.tasks.values());
  }

  /* ----- Agents ----- */

  upsertAgent(agent: Agent): void {
    const key = cacheKey(agent.metadata.namespace, agent.metadata.name);
    this.agents.set(key, agent);
    this.emit({ kind: 'agent', op: 'upsert', key });
  }

  deleteAgent(agent: Agent): void {
    const key = cacheKey(agent.metadata.namespace, agent.metadata.name);
    if (this.agents.delete(key)) {
      this.emit({ kind: 'agent', op: 'delete', key });
    }
  }

  getAgent(namespace: string, name: string): Agent | undefined {
    return this.agents.get(cacheKey(namespace, name));
  }

  listAgents(): readonly Agent[] {
    return Array.from(this.agents.values());
  }

  /* ----- Channels ----- */

  upsertChannel(channel: Channel): void {
    const key = cacheKey(channel.metadata.namespace, channel.metadata.name);
    this.channels.set(key, channel);
    this.emit({ kind: 'channel', op: 'upsert', key });
  }

  deleteChannel(channel: Channel): void {
    const key = cacheKey(channel.metadata.namespace, channel.metadata.name);
    if (this.channels.delete(key)) {
      this.emit({ kind: 'channel', op: 'delete', key });
    }
  }

  getChannel(namespace: string, name: string): Channel | undefined {
    return this.channels.get(cacheKey(namespace, name));
  }

  listChannels(): readonly Channel[] {
    return Array.from(this.channels.values());
  }

  /* ----- ChannelBindings ----- */

  upsertChannelBinding(binding: ChannelBinding): void {
    const key = cacheKey(binding.metadata.namespace, binding.metadata.name);
    this.channelBindings.set(key, binding);
    this.emit({ kind: 'channelBinding', op: 'upsert', key });
  }

  deleteChannelBinding(binding: ChannelBinding): void {
    const key = cacheKey(binding.metadata.namespace, binding.metadata.name);
    if (this.channelBindings.delete(key)) {
      this.emit({ kind: 'channelBinding', op: 'delete', key });
    }
  }

  listChannelBindings(): readonly ChannelBinding[] {
    return Array.from(this.channelBindings.values());
  }

  /* ----- ChannelSessions ----- */

  upsertChannelSession(session: ChannelSession): void {
    const key = cacheKey(session.metadata.namespace, session.metadata.name);
    this.channelSessions.set(key, session);
    this.emit({ kind: 'channelSession', op: 'upsert', key });
  }

  deleteChannelSession(session: ChannelSession): void {
    const key = cacheKey(session.metadata.namespace, session.metadata.name);
    if (this.channelSessions.delete(key)) {
      this.emit({ kind: 'channelSession', op: 'delete', key });
    }
  }

  listChannelSessions(): readonly ChannelSession[] {
    return Array.from(this.channelSessions.values());
  }

  /* ----- Jobs ----- */

  upsertJob(job: V1Job): void {
    const key = cacheKey(job.metadata?.namespace, job.metadata?.name);
    this.jobs.set(key, job);
    this.emit({ kind: 'job', op: 'upsert', key });
  }

  deleteJob(job: V1Job): void {
    const key = cacheKey(job.metadata?.namespace, job.metadata?.name);
    if (this.jobs.delete(key)) {
      this.emit({ kind: 'job', op: 'delete', key });
    }
  }

  /**
   * Look up the Job tied to an AgentTask via the standard
   * `kagent.knuteson.io/task=<name>` label. Cheap O(n) scan — the
   * cluster-wide Job count stays bounded by the AgentTask count, so
   * indexing isn't worth the complexity in v0.1.
   */
  findJobForTask(namespace: string, taskName: string): V1Job | undefined {
    for (const job of this.jobs.values()) {
      if (job.metadata?.namespace !== namespace) continue;
      if (job.metadata?.labels?.['kagent.knuteson.io/task'] === taskName) {
        return job;
      }
    }
    return undefined;
  }

  /* ----- Pods ----- */

  upsertPod(pod: V1Pod): void {
    const key = cacheKey(pod.metadata?.namespace, pod.metadata?.name);
    this.pods.set(key, pod);
    this.emit({ kind: 'pod', op: 'upsert', key });
  }

  deletePod(pod: V1Pod): void {
    const key = cacheKey(pod.metadata?.namespace, pod.metadata?.name);
    if (this.pods.delete(key)) {
      this.emit({ kind: 'pod', op: 'delete', key });
    }
  }

  findPodForTask(namespace: string, taskName: string): V1Pod | undefined {
    for (const pod of this.pods.values()) {
      if (pod.metadata?.namespace !== namespace) continue;
      if (pod.metadata?.labels?.['kagent.knuteson.io/task'] === taskName) {
        return pod;
      }
    }
    return undefined;
  }

  /** All operator-managed pods cached by the informer. */
  listPods(): readonly V1Pod[] {
    return Array.from(this.pods.values());
  }

  /** All operator-managed Jobs cached by the informer. */
  listJobs(): readonly V1Job[] {
    return Array.from(this.jobs.values());
  }

  /* ----- Listeners ----- */

  /** Subscribe to mutation events; returns an unsubscribe handle. */
  subscribe(listener: CacheListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Test-only — count of currently registered listeners. */
  listenerCount(): number {
    return this.listeners.size;
  }

  private emit(event: CacheChangeEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // Listener errors are swallowed — a single misbehaving SSE
        // subscriber must not poison the fan-out.
      }
    }
  }
}
