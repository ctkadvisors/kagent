/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/**
 * Server-Sent Events broker. Wraps `SnapshotCache.subscribe` with a
 * shape that's easy to feed into Hono's streaming response. Each
 * connected client gets one subscription; the broker fans out cache
 * mutations to every subscriber.
 *
 * SSE was chosen over WebSockets because:
 *
 *   - The Workbench is read-only — we only need server → client push.
 *   - SSE survives Ingress/L7 LBs without WebSocket-aware config.
 *   - Browser EventSource has built-in reconnect; saves us a client
 *     library.
 *
 * Backpressure: if a subscriber's queue grows beyond
 * `MAX_QUEUE_LENGTH`, we drop the oldest events. The Workbench reaches
 * for full-list refetches whenever it sees a "skipped" notice, so a
 * dropped event is at worst a stale cell for one polling cycle.
 */

import type { CacheChangeEvent, SnapshotCache } from './cache.js';

const MAX_QUEUE_LENGTH = 256;

/**
 * Wire-format event sent to clients. `data` is JSON-encoded by the
 * stream handler; consumers can `JSON.parse(event.data)` directly.
 */
export interface WireEvent {
  /** SSE `event:` header — usually 'cache' or 'heartbeat'. */
  readonly event: string;
  /** Stringified payload. */
  readonly data: string;
}

export type SubscriberSink = (event: WireEvent) => void;

export interface Subscription {
  /** Disconnect this subscriber and free its slot in the broker. */
  unsubscribe(): void;
  /** Number of pending events that were dropped due to backpressure. */
  droppedCount(): number;
}

/**
 * Format any change event as an SSE wire frame. Pure for testability.
 */
export function formatCacheEvent(event: CacheChangeEvent): WireEvent {
  return {
    event: 'cache',
    data: JSON.stringify(event),
  };
}

/**
 * Format a heartbeat as an SSE wire frame. The Workbench UI uses
 * heartbeats to detect a half-open connection (no events for >30s
 * usually means proxy timeout).
 */
export function formatHeartbeat(now: Date = new Date()): WireEvent {
  return {
    event: 'heartbeat',
    data: JSON.stringify({ ts: now.toISOString() }),
  };
}

/**
 * Broker — wires SnapshotCache change events to a set of SSE
 * subscribers. Holds no timers or sockets; the HTTP route owns those.
 */
export class SseBroker {
  private droppedTotal = 0;

  constructor(private readonly cache: SnapshotCache) {}

  /**
   * Register a new subscriber. The broker pushes `formatCacheEvent`
   * frames for every cache mutation until `unsubscribe()` is called.
   */
  subscribe(sink: SubscriberSink): Subscription {
    let dropped = 0;
    const unsub = this.cache.subscribe((event) => {
      try {
        sink(formatCacheEvent(event));
      } catch {
        // Sink errors mean the connection is gone or the writer's
        // buffer is full; count and drop.
        dropped++;
        this.droppedTotal++;
        if (dropped > MAX_QUEUE_LENGTH) {
          unsub();
        }
      }
    });
    return {
      unsubscribe: unsub,
      droppedCount: () => dropped,
    };
  }

  /** Total events dropped across all subscribers (lifetime counter). */
  totalDropped(): number {
    return this.droppedTotal;
  }
}
