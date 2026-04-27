/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/**
 * NATS-backed `Dispatcher` impl — publishes the A2A envelope onto
 * JetStream subjects per the taxonomy in docs/DESIGN-V0.1.md §4.3.
 *
 * v0.1 publish-only: the agent-pod reads its task assignment from
 * env vars, not NATS (kept the bootstrap simple). NATS publish here
 * is the durable record + future-delegation hook — when an agent
 * calls `delegate_to_capability(...)`, that publish lands on the
 * same stream, and a sibling agent picks it up.
 *
 * Connection is lazy (constructor doesn't open the NATS socket) so
 * unit tests can construct a NatsDispatcher with a stubbed
 * connection factory.
 */

import type { Dispatcher, DispatchedTask } from './dispatcher.js';

/**
 * Narrow subset of nats.js's `NatsConnection` we actually use. Lets
 * tests inject a small stub without dragging in the whole NATS
 * type surface.
 */
export interface NatsConnectionLike {
  publish(subject: string, data: Uint8Array): void;
  flush(): Promise<void>;
  close(): Promise<void>;
}

/** Factory for the connection — opened on first publish. */
export type NatsConnectFn = () => Promise<NatsConnectionLike>;

export interface NatsDispatcherOptions {
  /**
   * Connection factory. Production wires this to `connect({ servers })`
   * from `nats`; tests pass a stub. Always async because nats.js's
   * `connect` is async.
   */
  readonly connect: NatsConnectFn;
  /**
   * Subject prefix — defaults to `agent`. The full subject is
   * `${prefix}.${agentId}.task.${taskId}`.
   */
  readonly subjectPrefix?: string;
}

const DEFAULT_PREFIX = 'agent';
const encoder = new TextEncoder();

/**
 * Computes the publish subject for a task assignment per the
 * DESIGN-V0.1.md §4.3 taxonomy: `agent.<agentId>.task.<taskId>`.
 */
export function publishSubject(task: DispatchedTask, prefix: string = DEFAULT_PREFIX): string {
  return `${prefix}.${task.agentId}.task.${task.taskId}`;
}

export class NatsDispatcher implements Dispatcher {
  private readonly connectFn: NatsConnectFn;
  private readonly subjectPrefix: string;
  private connection: NatsConnectionLike | undefined;

  constructor(options: NatsDispatcherOptions) {
    this.connectFn = options.connect;
    this.subjectPrefix = options.subjectPrefix ?? DEFAULT_PREFIX;
  }

  async publish(task: DispatchedTask): Promise<void> {
    const conn = await this.ensureConnection();
    const subject = publishSubject(task, this.subjectPrefix);
    const payload = encoder.encode(JSON.stringify(task));
    conn.publish(subject, payload);
    // flush() resolves once the message is in-flight — important for
    // operator status writeback ordering: we don't want to mark
    // AgentTask.status=Dispatched before the bus has actually accepted
    // the publish.
    await conn.flush();
  }

  /** Close the underlying NATS connection (if any). Idempotent. */
  async close(): Promise<void> {
    if (this.connection !== undefined) {
      await this.connection.close();
      this.connection = undefined;
    }
  }

  private async ensureConnection(): Promise<NatsConnectionLike> {
    if (this.connection === undefined) {
      this.connection = await this.connectFn();
    }
    return this.connection;
  }
}
