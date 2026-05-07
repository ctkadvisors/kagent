/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/**
 * Command view state hook — wires the existing workbench-api fetch +
 * SSE surface into a normalized snapshot consumed by the canvas renderer.
 *
 * Why a custom hook instead of reusing TaskList's logic: the command
 * view fetches `/api/agents` + `/api/gateway/capacity` + `/api/gateway/usage`
 * in addition to `/api/tasks`, and it needs a flat in-memory map keyed
 * by `ns/name` rather than the array projection TaskList renders.
 *
 * The SSE stream still drives invalidation; we just refetch all four
 * surfaces on any cache-event-with-impact and re-poll the gateway
 * surfaces on a 5s tick (gateway state isn't streamed).
 */

import { useEffect, useRef, useState } from 'react';

import {
  fetchAgents,
  fetchGatewayCapacity,
  fetchGatewayUsage,
  fetchTasks,
  subscribeCacheEvents,
} from '../api.js';
import type {
  AgentSummaryRow,
  GatewayCapacityRow,
  GatewayUsageRow,
  TaskSummary,
} from '../types.js';

export interface ActivityEvent {
  readonly id: string; // taskKey + phase + timestamp
  readonly at: number;
  readonly taskKey: string; // `ns/name`
  readonly phase: TaskSummary['phase'];
  readonly agent: string | undefined;
  readonly model: string | undefined;
  readonly note: string;
}

export interface CommandSnapshot {
  readonly agents: ReadonlyMap<string, AgentSummaryRow>;
  readonly tasks: ReadonlyMap<string, TaskSummary>;
  readonly gatewayCapacity: readonly GatewayCapacityRow[];
  readonly gatewayUsage: readonly GatewayUsageRow[];
  readonly events: readonly ActivityEvent[];
  readonly lastEventAt: number;
  readonly error: string | null;
}

const MAX_EVENTS = 50;
const GATEWAY_POLL_MS = 5_000;

export function useCommandSnapshot(): CommandSnapshot {
  const [agents, setAgents] = useState<Map<string, AgentSummaryRow>>(new Map());
  const [tasks, setTasks] = useState<Map<string, TaskSummary>>(new Map());
  const [gatewayCapacity, setGatewayCapacity] = useState<readonly GatewayCapacityRow[]>([]);
  const [gatewayUsage, setGatewayUsage] = useState<readonly GatewayUsageRow[]>([]);
  const [events, setEvents] = useState<readonly ActivityEvent[]>([]);
  const [lastEventAt, setLastEventAt] = useState<number>(Date.now());
  const [error, setError] = useState<string | null>(null);

  const prevTasksRef = useRef<Map<string, TaskSummary>>(new Map());

  const refetchTasks = (): void => {
    fetchTasks()
      .then((items) => {
        const next = new Map<string, TaskSummary>();
        const newEvents: ActivityEvent[] = [];
        const now = Date.now();
        for (const t of items) {
          const key = `${t.namespace}/${t.name}`;
          next.set(key, t);
          // Diff: emit an activity event for any phase transition we
          // haven't already logged.
          const prev = prevTasksRef.current.get(key);
          if (prev?.phase !== t.phase) {
            newEvents.push({
              id: `${key}#${String(t.phase ?? 'unknown')}#${String(now)}`,
              at: now,
              taskKey: key,
              phase: t.phase,
              agent: t.targetAgent,
              model: t.model,
              note: phaseNote(t),
            });
          }
        }
        prevTasksRef.current = next;
        setTasks(next);
        if (newEvents.length > 0) {
          setEvents((cur) => {
            const merged = [...newEvents, ...cur];
            return merged.slice(0, MAX_EVENTS);
          });
        }
      })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : String(err));
      });
  };

  const refetchAgents = (): void => {
    fetchAgents()
      .then((items) => {
        const next = new Map<string, AgentSummaryRow>();
        for (const a of items) {
          next.set(`${a.namespace}/${a.name}`, a);
        }
        setAgents(next);
      })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : String(err));
      });
  };

  const refetchGateway = (): void => {
    fetchGatewayCapacity()
      .then((res) => {
        setGatewayCapacity(res.rows);
      })
      .catch(() => {
        // Gateway page tolerates the 503 — empty rows are an OK state.
        setGatewayCapacity([]);
      });
    fetchGatewayUsage({ limit: 50 })
      .then((res) => {
        setGatewayUsage(res.rows);
      })
      .catch(() => {
        setGatewayUsage([]);
      });
  };

  useEffect(() => {
    refetchAgents();
    refetchTasks();
    refetchGateway();

    const unsubscribe = subscribeCacheEvents(
      (ev) => {
        setLastEventAt(Date.now());
        if (ev.kind === 'task') refetchTasks();
        else if (ev.kind === 'agent') refetchAgents();
      },
      () => {
        setLastEventAt(Date.now());
      },
    );

    const gwTick = setInterval(refetchGateway, GATEWAY_POLL_MS);

    return () => {
      unsubscribe();
      clearInterval(gwTick);
    };
    // Effect intentionally runs once on mount.
  }, []);

  return {
    agents,
    tasks,
    gatewayCapacity,
    gatewayUsage,
    events,
    lastEventAt,
    error,
  };
}

function phaseNote(t: TaskSummary): string {
  const target = t.targetAgent ?? '<no agent>';
  switch (t.phase) {
    case 'Pending':
      return `${target} accepted task`;
    case 'Dispatched':
      return `${target} dispatched`;
    case 'Completed':
      return `${target} completed in ${formatDuration(t)}`;
    case 'Failed':
      return `${target} failed${t.error !== undefined ? `: ${t.error.slice(0, 80)}` : ''}`;
    default:
      return `${target} state change`;
  }
}

function formatDuration(t: TaskSummary): string {
  if (t.startedAt === undefined || t.completedAt === undefined) return '?';
  const start = Date.parse(t.startedAt);
  const end = Date.parse(t.completedAt);
  if (Number.isNaN(start) || Number.isNaN(end)) return '?';
  const secs = Math.max(0, Math.round((end - start) / 1000));
  if (secs < 60) return `${String(secs)}s`;
  const mins = Math.floor(secs / 60);
  const rem = secs % 60;
  return `${String(mins)}m${String(rem).padStart(2, '0')}s`;
}
