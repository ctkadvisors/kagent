/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

import { describe, expect, it, vi } from 'vitest';

import type { RenderedAgentTask } from './render-task.js';
import {
  buildScheduleController,
  NoWorkThisTick,
  RUN_REQUESTED_ANNOTATION,
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

  it('records the next tick, not a run, when there is no work to bind', async () => {
    const patches: ScheduleStatusPatch[] = [];
    const controller = buildScheduleController({
      createAgentTask: () => {
        throw new NoWorkThisTick('no open request');
      },
      patchScheduleStatus: (_ns, _name, patch) => {
        patches.push(patch);
      },
    });
    controller.upsert(mkSchedule('requests', '* * * * *'));

    expect(await controller.tickOnce(utc(2026, 11, 20, 15, 0))).toBe(0);
    expect(patches).toEqual([{ nextTickAt: '2026-11-20T15:01:00.000Z' }]);
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

  it('recomputes an obsolete next tick after the cron changes without claiming a run', async () => {
    const created: RenderedAgentTask[] = [];
    const patches: ScheduleStatusPatch[] = [];
    const controller = buildScheduleController({
      createAgentTask: (m) => {
        created.push(m);
      },
      patchScheduleStatus: (_ns, _name, patch) => {
        patches.push(patch);
      },
    });
    controller.upsert({
      ...mkSchedule('audit', '0 */2 * * *'),
      status: { lastTickAt: '2026-10-01T21:00:00.000Z', nextTickAt: '2026-10-01T21:30:00.000Z' },
    });

    expect(await controller.tickOnce(utc(2026, 10, 1, 21, 7))).toBe(0);
    expect(created).toHaveLength(0);
    expect(patches).toEqual([{ nextTickAt: '2026-10-01T22:00:00.000Z' }]);
  });

  describe('a missed tick', () => {
    const missed = (overrides: Partial<KagentScheduleResource['spec']> = {}) => ({
      ...mkSchedule('dream', '10 3 * * *', overrides),
      status: { lastTickAt: '2026-11-25T03:10:00.000Z', nextTickAt: '2026-11-26T03:10:00.000Z' },
    });
    const build = (created: RenderedAgentTask[], patches: ScheduleStatusPatch[], fail = false) =>
      buildScheduleController({
        createAgentTask: (m) => {
          if (fail) throw new Error('apiserver said no');
          created.push(m);
        },
        patchScheduleStatus: (_ns, _name, patch) => {
          patches.push(patch);
        },
        assessIdle: () =>
          Promise.resolve({ idleSince: utc(2026, 11, 26, 0, 0), activeSchedules: new Set() }),
      });

    it('runs once at the next tick and records the run, however late', async () => {
      const created: RenderedAgentTask[] = [];
      const patches: ScheduleStatusPatch[] = [];
      const controller = build(created, patches);
      controller.upsert(missed());

      // 07:33Z: the daily 03:10 tick fell inside a pause that has just lifted.
      expect(await controller.tickOnce(utc(2026, 11, 26, 7, 33))).toBe(1);
      expect(patches).toEqual([
        { lastTickAt: '2026-11-26T07:33:00.000Z', nextTickAt: '2026-11-27T03:10:00.000Z' },
      ]);

      // The informer hands the patched status back; the next minute is quiet.
      controller.upsert({ ...missed(), status: patches[0] ?? {} });
      expect(await controller.tickOnce(utc(2026, 11, 26, 7, 34))).toBe(0);
      expect(created).toHaveLength(1);
    });

    it('does not run while the schedule is suspended', async () => {
      const created: RenderedAgentTask[] = [];
      const controller = build(created, []);
      controller.upsert(missed({ suspend: true }));
      expect(await controller.tickOnce(utc(2026, 11, 26, 7, 33))).toBe(0);
    });

    it('is retried every minute while task creation fails, and stays recorded as overdue', async () => {
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      const patches: ScheduleStatusPatch[] = [];
      const controller = build([], patches, true);
      controller.upsert(missed());
      expect(await controller.tickOnce(utc(2026, 11, 26, 7, 33))).toBe(0);
      expect(await controller.tickOnce(utc(2026, 11, 26, 7, 34))).toBe(0);
      expect(errSpy).toHaveBeenCalledTimes(2);
      expect(patches).toHaveLength(0);
      errSpy.mockRestore();
    });

    it('leaves an idle-gated schedule to its next cron minute', async () => {
      const created: RenderedAgentTask[] = [];
      const controller = build(created, []);
      controller.upsert({
        ...mkSchedule('invent', '*/5 * * * *', { whenIdle: { quietSeconds: 300 } }),
        status: { lastTickAt: '2026-11-26T07:00:00.000Z', nextTickAt: '2026-11-26T07:05:00.000Z' },
      });
      expect(await controller.tickOnce(utc(2026, 11, 26, 7, 33))).toBe(0);
      expect(await controller.tickOnce(utc(2026, 11, 26, 7, 35))).toBe(1);
    });

    it('is not claimed for a next tick that has not passed or was never recorded', async () => {
      const created: RenderedAgentTask[] = [];
      const controller = build(created, []);
      controller.upsert(mkSchedule('fresh', '10 3 * * *'));
      controller.upsert({
        ...mkSchedule('later', '10 3 * * *'),
        status: { nextTickAt: '2026-11-27T03:10:00.000Z' },
      });
      expect(await controller.tickOnce(utc(2026, 11, 26, 7, 33))).toBe(0);
    });
  });

  describe('a run request', () => {
    const requested = (
      at: string,
      overrides: Partial<KagentScheduleResource['spec']> = {},
      status: KagentScheduleResource['status'] = {
        lastTickAt: '2026-11-26T07:30:00.000Z',
        nextTickAt: '2026-11-26T07:45:00.000Z',
      },
    ): KagentScheduleResource => {
      const base = mkSchedule('boss', '*/15 * * * *', overrides);
      return {
        ...base,
        metadata: { ...base.metadata, annotations: { [RUN_REQUESTED_ANNOTATION]: at } },
        status,
      };
    };
    const build = (created: RenderedAgentTask[], patches: ScheduleStatusPatch[]) =>
      buildScheduleController({
        createAgentTask: (m) => {
          created.push(m);
        },
        patchScheduleStatus: (_ns, _name, patch) => {
          patches.push(patch);
        },
        // Busy namespace: the idle gate is closed for every schedule.
        assessIdle: () => Promise.resolve({ idleSince: undefined, activeSchedules: new Set() }),
      });

    it('runs the schedule once off its cron and past a closed idle gate', async () => {
      const created: RenderedAgentTask[] = [];
      const patches: ScheduleStatusPatch[] = [];
      const controller = build(created, patches);
      const spec = { whenIdle: { quietSeconds: 120 } };
      controller.upsert(requested('2026-11-26T07:36:20.000Z', spec));

      // The request lands mid-minute: the 07:36 tick is before it, 07:37 honours it.
      expect(await controller.tickOnce(utc(2026, 11, 26, 7, 36))).toBe(0);
      expect(await controller.tickOnce(utc(2026, 11, 26, 7, 37))).toBe(1);
      expect(patches).toEqual([
        { lastTickAt: '2026-11-26T07:37:00.000Z', nextTickAt: '2026-11-26T07:45:00.000Z' },
      ]);

      // The annotation stays on the object; the recorded run is what spends it.
      controller.upsert(requested('2026-11-26T07:36:20.000Z', spec, patches[0]));
      expect(await controller.tickOnce(utc(2026, 11, 26, 7, 38))).toBe(0);
      expect(created).toHaveLength(1);
    });

    it('is ignored on a suspended schedule and when the value is not an instant', async () => {
      const created: RenderedAgentTask[] = [];
      const controller = build(created, []);
      controller.upsert(requested('2026-11-26T07:36:20.000Z', { suspend: true }));
      expect(await controller.tickOnce(utc(2026, 11, 26, 7, 37))).toBe(0);
      controller.upsert(requested('now please'));
      expect(await controller.tickOnce(utc(2026, 11, 26, 7, 37))).toBe(0);
    });

    it('runs a schedule that has never ticked', async () => {
      const created: RenderedAgentTask[] = [];
      const controller = build(created, []);
      controller.upsert(requested('2026-11-26T07:36:20.000Z', {}, {}));
      expect(await controller.tickOnce(utc(2026, 11, 26, 7, 37))).toBe(1);
    });
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
        assessIdle: () => Promise.resolve({ idleSince, activeSchedules: new Set<string>() }),
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

    it('a schedule waits for its own live task; another schedule still fires; it fires on the next tick after', async () => {
      const created: RenderedAgentTask[] = [];
      let active = new Set<string>(['invent']);
      const controller = buildScheduleController({
        createAgentTask: (m) => {
          created.push(m);
        },
        patchScheduleStatus: () => undefined,
        assessIdle: () =>
          Promise.resolve({ idleSince: utc(2026, 9, 25, 12, 0), activeSchedules: active }),
      });
      controller.upsert(mkSchedule('invent', '*/5 * * * *', { whenIdle: { quietSeconds: 300 } }));
      controller.upsert(mkSchedule('dispose', '*/5 * * * *', { whenIdle: { quietSeconds: 300 } }));
      expect(await controller.tickOnce(at)).toBe(1);
      expect(created.map((m) => m.metadata.labels['kagent.knuteson.io/trigger-name'])).toEqual([
        'dispose',
      ]);
      active = new Set<string>();
      expect(await controller.tickOnce(utc(2026, 9, 25, 13, 5))).toBe(2);
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
