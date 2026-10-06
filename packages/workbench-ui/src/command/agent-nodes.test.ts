/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { currentAgentNodes } from './agent-nodes.js';
import type { TaskSummary } from '../types.js';

const agent = { name: 'current', namespace: 'ns', modelClass: 'local', tools: ['search'] };
const task = (name: string, targetAgent: string, phase?: TaskSummary['phase']): TaskSummary => ({
  name,
  namespace: 'ns',
  uid: name,
  targetAgent,
  ...(phase !== undefined && { phase }),
});
afterEach(() => vi.unstubAllEnvs());
describe('current map agent projection', () => {
  it('omits completed/failed orphan buildings, keeps catalog agents and preserves the task map', () => {
    vi.stubEnv('NODE_ENV', 'development');
    const tasks = new Map(
      ['Completed', 'Failed'].map((phase) => [
        phase,
        task(phase, 'retired', phase as TaskSummary['phase']),
      ]),
    );
    const snapshot = { agents: new Map([['ns/current', agent]]), tasks };
    expect(currentAgentNodes(snapshot)).toEqual([{ ...agent, key: 'ns/current' }]);
    expect(snapshot.tasks).toBe(tasks);
    expect(tasks.size).toBe(2);
  });
  it('retains a current agent even when all its tasks are terminal', () => {
    expect(
      currentAgentNodes({
        agents: new Map([['ns/current', agent]]),
        tasks: new Map([['history', task('history', 'current', 'Completed')]]),
      }),
    ).toEqual([{ ...agent, key: 'ns/current' }]);
  });
  it.each(['Pending', 'Dispatched', undefined] as const)(
    'preserves the dev orphan assertion for phase %s',
    (phase) => {
      vi.stubEnv('NODE_ENV', 'development');
      expect(() =>
        currentAgentNodes({
          agents: new Map(),
          tasks: new Map([['task', task('task', 'missing', phase)]]),
        }),
      ).toThrow(/CC-01 source-binding violation/);
    },
  );
  it.each(['Pending', 'Dispatched', undefined] as const)(
    'preserves production synthetic nodes for nonterminal phase %s',
    (phase) => {
      vi.stubEnv('NODE_ENV', 'production');
      expect(
        currentAgentNodes({
          agents: new Map(),
          tasks: new Map([['task', task('task', 'missing', phase)]]),
        }),
      ).toEqual([{ key: 'ns/missing', namespace: 'ns', name: 'missing' }]);
    },
  );
});
