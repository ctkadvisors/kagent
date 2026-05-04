/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

import { describe, expect, it } from 'vitest';

import { defineWorkflow } from './define-workflow.js';
import type { WorkflowContext } from './types.js';

describe('defineWorkflow', () => {
  it('returns a WorkflowDefinition with the given name + run handler', () => {
    const wf = defineWorkflow({
      name: 'researchOrchestrator',
      run(_input: unknown, _ctx: WorkflowContext) {
        return Promise.resolve('ok');
      },
    });
    expect(wf.name).toBe('researchOrchestrator');
    expect(typeof wf._run).toBe('function');
  });

  it('throws when name is empty', () => {
    expect(() =>
      defineWorkflow({
        name: '',
        run() {
          return Promise.resolve();
        },
      }),
    ).toThrow(/name.*non-empty/);
  });

  it('throws when name is not a JS-identifier (e.g. contains a hyphen)', () => {
    expect(() =>
      defineWorkflow({
        name: 'has-hyphen',
        run() {
          return Promise.resolve();
        },
      }),
    ).toThrow(/identifier/);
  });

  it('throws when run is not a function', () => {
    expect(() =>
      defineWorkflow({
        name: 'broken',
        run: 'not-a-function' as unknown as () => Promise<void>,
      }),
    ).toThrow(/run.*function/);
  });

  it('preserves the run handler verbatim', async () => {
    const wf = defineWorkflow({
      name: 'add',
      run(input: { readonly a: number; readonly b: number }) {
        return Promise.resolve(input.a + input.b);
      },
    });
    const ctx: WorkflowContext = {
      capabilityRef: undefined,
      invocationId: 'inv-1',
      spawnAgentTask: () => Promise.reject(new Error('not used')),
      awaitTask: () => Promise.reject(new Error('not used')),
      signal: () => Promise.reject(new Error('not used')),
      awaitSignal: () => Promise.reject(new Error('not used')),
      sleep: () => Promise.reject(new Error('not used')),
    };
    expect(await wf._run({ a: 2, b: 3 }, ctx)).toBe(5);
  });
});
