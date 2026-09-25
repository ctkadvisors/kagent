/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

import { describe, expect, it, vi } from 'vitest';

import type { RenderedAgentTask } from './render-task.js';
import {
  buildScheduleController,
  type KagentScheduleResource,
  type ScheduleStatusPatch,
} from './schedule-controller.js';

const utc = (year: number, month: number, day: number, hour: number, minute: number): Date =>
  new Date(Date.UTC(year, month - 1, day, hour, minute, 0, 0));

const mkSchedule = (
  name: string,
  schedule: string,
  overrides: Partial<KagentScheduleResource['spec']> = {},
): KagentScheduleResource => ({
  metadata: { name, namespace: 'kagent-system', uid: `uid-${name}` },
  spec: {
    schedule,
    taskTemplate: {
      targetAgent: 'researcher',
      payload: { prompt: 'go' },
    },
    ...overrides,
  },
});

describe('schedule controller', () => {
  it('creates an AgentTask when the cron matches the tick instant', async () => {
    const created: RenderedAgentTask[] = [];
    const patches: { ns: string; name: string; patch: ScheduleStatusPatch }[] = [];
    const controller = buildScheduleController({
      createAgentTask: (m) => {
        created.push(m);
      },
      patchScheduleStatus: (ns, name, patch) => {
        patches.push({ ns, name, patch });
      },
    });
    controller.upsert(mkSchedule('daily', '0 6 * * *'));

    const out = await controller.tickOnce(utc(2026, 5, 3, 6, 0));
    expect(out).toBe(1);
    expect(created).toHaveLength(1);
    expect(created[0]?.metadata.labels['kagent.knuteson.io/trigger-kind']).toBe('schedule');
    expect(created[0]?.metadata.labels['kagent.knuteson.io/trigger-name']).toBe('daily');
    expect(created[0]?.spec.targetAgent).toBe('researcher');

    expect(patches).toHaveLength(1);
    expect(patches[0]?.patch.lastTickAt).toBe('2026-05-03T06:00:00.000Z');
    // Next match for "0 6 * * *" after 06:00 is +1d 06:00.
    expect(patches[0]?.patch.nextTickAt).toBe('2026-05-04T06:00:00.000Z');
  });

  it('skips schedules with suspend=true', async () => {
    const created: RenderedAgentTask[] = [];
    const controller = buildScheduleController({
      createAgentTask: (m) => {
        created.push(m);
      },
      patchScheduleStatus: () => {
        /* noop */
      },
    });
    controller.upsert(mkSchedule('paused', '* * * * *', { suspend: true }));

    const out = await controller.tickOnce(utc(2026, 5, 3, 6, 0));
    expect(out).toBe(0);
    expect(created).toHaveLength(0);
  });

  it('does not fire when cron does not match the tick', async () => {
    const created: RenderedAgentTask[] = [];
    const controller = buildScheduleController({
      createAgentTask: (m) => {
        created.push(m);
      },
      patchScheduleStatus: () => {
        /* noop */
      },
    });
    controller.upsert(mkSchedule('daily', '0 6 * * *'));

    const out = await controller.tickOnce(utc(2026, 5, 3, 7, 0));
    expect(out).toBe(0);
    expect(created).toHaveLength(0);
  });

  it('upsert replaces an existing schedule entry', () => {
    const controller = buildScheduleController({
      createAgentTask: () => {
        /* noop */
      },
      patchScheduleStatus: () => {
        /* noop */
      },
    });
    controller.upsert(mkSchedule('thing', '0 6 * * *'));
    expect(controller.size()).toBe(1);
    controller.upsert(mkSchedule('thing', '0 7 * * *'));
    expect(controller.size()).toBe(1);
  });

  it('remove deletes a cached schedule', () => {
    const controller = buildScheduleController({
      createAgentTask: () => {
        /* noop */
      },
      patchScheduleStatus: () => {
        /* noop */
      },
    });
    controller.upsert(mkSchedule('thing', '0 6 * * *'));
    controller.remove('kagent-system', 'thing');
    expect(controller.size()).toBe(0);
  });

  it('quarantines a schedule with an unparseable cron', async () => {
    const created: RenderedAgentTask[] = [];
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const controller = buildScheduleController({
      createAgentTask: (m) => {
        created.push(m);
      },
      patchScheduleStatus: () => {
        /* noop */
      },
    });
    controller.upsert(mkSchedule('bad', 'this is not cron'));

    const out = await controller.tickOnce(utc(2026, 5, 3, 6, 0));
    expect(out).toBe(0);
    expect(created).toHaveLength(0);
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('records lastTickAt only on successful AgentTask creation', async () => {
    const patches: { ns: string; name: string; patch: ScheduleStatusPatch }[] = [];
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const controller = buildScheduleController({
      createAgentTask: () => {
        throw new Error('apiserver said no');
      },
      patchScheduleStatus: (ns, name, patch) => {
        patches.push({ ns, name, patch });
      },
    });
    controller.upsert(mkSchedule('daily', '* * * * *'));
    const out = await controller.tickOnce(utc(2026, 5, 3, 6, 0));
    expect(out).toBe(0);
    expect(patches).toHaveLength(0);
    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
  });

  describe('whenIdle', () => {
    const build = (idleSince: Date | undefined, created: RenderedAgentTask[]) =>
      buildScheduleController({
        createAgentTask: (m) => {
          created.push(m);
        },
        patchScheduleStatus: () => undefined,
        namespaceIdleSince: () => Promise.resolve(idleSince),
      });
    const at = utc(2026, 9, 25, 13, 0);

    it('fires when the namespace has been quiet for quietSeconds', async () => {
      const created: RenderedAgentTask[] = [];
      const controller = build(utc(2026, 9, 25, 12, 50), created);
      controller.upsert(mkSchedule('invent', '*/5 * * * *', { whenIdle: { quietSeconds: 300 } }));
      expect(await controller.tickOnce(at)).toBe(1);
    });

    it('does not fire while a task is active or the quiet window is short', async () => {
      for (const idleSince of [undefined, utc(2026, 9, 25, 12, 58)]) {
        const created: RenderedAgentTask[] = [];
        const controller = build(idleSince, created);
        controller.upsert(mkSchedule('invent', '*/5 * * * *', { whenIdle: { quietSeconds: 300 } }));
        expect(await controller.tickOnce(at)).toBe(0);
      }
    });

    it('honours minGapSeconds from status.lastTickAt', async () => {
      const created: RenderedAgentTask[] = [];
      const controller = build(utc(2026, 9, 25, 12, 0), created);
      controller.upsert({
        ...mkSchedule('invent', '*/5 * * * *', { whenIdle: { minGapSeconds: 900 } }),
        status: { lastTickAt: utc(2026, 9, 25, 12, 50).toISOString() },
      });
      expect(await controller.tickOnce(at)).toBe(0);
      controller.upsert({
        ...mkSchedule('invent', '*/5 * * * *', { whenIdle: { minGapSeconds: 900 } }),
        status: { lastTickAt: utc(2026, 9, 25, 12, 40).toISOString() },
      });
      expect(await controller.tickOnce(at)).toBe(1);
    });

    it('fails closed without an idle probe', async () => {
      const created: RenderedAgentTask[] = [];
      const controller = buildScheduleController({
        createAgentTask: (m) => {
          created.push(m);
        },
        patchScheduleStatus: () => undefined,
      });
      controller.upsert(mkSchedule('invent', '*/5 * * * *', { whenIdle: {} }));
      expect(await controller.tickOnce(at)).toBe(0);
    });
  });
});
