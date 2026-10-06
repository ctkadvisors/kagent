/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CommandView } from '../CommandView.js';
import * as camera from './camera.js';
import { drawScene } from './scene.js';
import type { CommandSnapshot } from './state.js';

const snapshot: CommandSnapshot = {
  agents: new Map(['a', 'b'].map((name) => [`ns/${name}`, { namespace: 'ns', name, capabilities: [] }])),
  tasks: new Map([['ns/task', { namespace: 'ns', name: 'task', uid: 'task', targetAgent: 'a', phase: 'Pending' }]]),
  gatewayCapacity: [], gatewayUsage: [], dispositions: new Map(), events: [], lastEventAt: Date.now(), error: null,
};
vi.mock('./state.js', () => ({ useCommandSnapshot: () => snapshot }));
vi.mock('../api.js', async (actual) => ({ ...await actual<typeof import('../api.js')>(), useReviewQueue: () => ({ rows: [] }) }));
vi.mock('./sound.js', () => ({ sound: new Proxy({}, { get: () => vi.fn() }) }));
vi.mock('./scene.js', async (actual) => ({ ...await actual<typeof import('./scene.js')>(), drawScene: vi.fn(() => ({
  gateway: { x: 400, y: 250, r: 20 },
  agentRects: new Map([['ns/a', { x: 100, y: 100, w: 40, h: 40 }], ['ns/b', { x: 160, y: 100, w: 40, h: 40 }]]),
  taskSprites: new Map([['ns/task', { x: 250, y: 100 }]]),
  structureRects: new Map([['bytebot', { x: 300, y: 100, w: 40, h: 40 }]]),
})) }));

let frame: FrameRequestCallback | undefined;
let cam: camera.Camera;
let capture: ReturnType<typeof vi.fn>;
let release: ReturnType<typeof vi.fn>;
const pointer = (x: number, y: number, extra: PointerEventInit = {}) => ({
  clientX: x, clientY: y, button: 0, pointerId: 7,
  buttons: extra.button === 1 ? 4 : 1, ...extra,
});
const releasedPointer = (x: number, y: number, extra: PointerEventInit = {}) => pointer(x, y, { ...extra, buttons: 0 });
function tick() { act(() => frame?.(performance.now())); }
function mount() {
  const view = render(<CommandView onBack={() => {}} />); tick();
  return { ...view, canvas: view.container.querySelector('canvas')! };
}
function click(canvas: HTMLCanvasElement, x: number, y: number, extra = {}) {
  fireEvent.pointerDown(canvas, pointer(x, y, extra)); fireEvent.pointerUp(canvas, releasedPointer(x, y, extra)); tick();
}

describe('Command canvas pointer gestures', () => {
  beforeEach(() => {
    localStorage.setItem('kagent.command.tour.completed', 'true');
    // jsdom lacks PointerEvent/capture and canvas rendering; retain real camera/input and React event wiring.
    class TestPointerEvent extends MouseEvent {
      readonly pointerId: number;
      constructor(type: string, init: PointerEventInit = {}) { super(type, init); this.pointerId = init.pointerId ?? 0; }
    }
    vi.stubGlobal('PointerEvent', TestPointerEvent);
    capture = vi.fn(); release = vi.fn();
    vi.stubGlobal('requestAnimationFrame', vi.fn((fn: FrameRequestCallback) => { frame = fn; return 1; }));
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ setTransform: vi.fn(), clearRect: vi.fn(), fillRect: vi.fn(), strokeRect: vi.fn() } as unknown as CanvasRenderingContext2D);
    Object.defineProperties(HTMLCanvasElement.prototype, {
      setPointerCapture: { configurable: true, value: capture }, releasePointerCapture: { configurable: true, value: release },
      hasPointerCapture: { configurable: true, value: () => true },
    });
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ x: 0, y: 0, left: 0, top: 0, right: 800, bottom: 500, width: 800, height: 500, toJSON: () => ({}) });
    const makeCamera = camera.makeCamera;
    vi.spyOn(camera, 'makeCamera').mockImplementation(() => { const next = makeCamera(); cam ??= next; return next; });
    vi.spyOn(window, 'open').mockReturnValue(null); vi.mocked(drawScene).mockClear();
  });
  afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); localStorage.clear(); cam = undefined as unknown as camera.Camera; frame = undefined; });

  it.each([0.5, 2])('empty primary drag pans by screen pixels at zoom %s and preserves selection', (zoom) => {
    const { canvas } = mount(); click(canvas, 120, 120); cam.zoom = zoom;
    fireEvent.pointerDown(canvas, pointer(500, 300)); fireEvent.pointerMove(canvas, pointer(560, 335)); tick();
    expect([cam.offsetX, cam.offsetY]).toEqual([60, 35]); expect(canvas.style.cursor).toBe('grabbing');
    fireEvent.pointerUp(canvas, releasedPointer(560, 335)); tick();
    expect(vi.mocked(drawScene).mock.lastCall?.[1].selection.keys).toEqual(new Set(['ns/a']));
    expect(window.open).not.toHaveBeenCalled(); expect(capture).toHaveBeenCalledWith(7); expect(release).toHaveBeenCalledWith(7);
    expect(canvas.style.cursor).not.toBe('grabbing');
  });
  it('middle drag pans from a structure without opening it or dispatching', () => {
    const { canvas, queryByRole } = mount();
    fireEvent.pointerDown(canvas, pointer(320, 120, { button: 1 })); fireEvent.pointerMove(canvas, pointer(340, 150, { button: 1 })); fireEvent.pointerUp(canvas, releasedPointer(340, 150, { button: 1 }));
    expect([cam.offsetX, cam.offsetY]).toEqual([20, 30]); expect(window.open).not.toHaveBeenCalled(); expect(queryByRole('dialog', { name: /dispatch/i })).toBeNull();
  });
  it('primary click selects agents/tasks and Shift-click toggles agents', () => {
    const { canvas } = mount(); click(canvas, 120, 120); click(canvas, 180, 120, { shiftKey: true });
    expect(vi.mocked(drawScene).mock.lastCall?.[1].selection.keys).toEqual(new Set(['ns/a', 'ns/b']));
    click(canvas, 120, 120, { shiftKey: true }); expect(vi.mocked(drawScene).mock.lastCall?.[1].selection.keys).toEqual(new Set(['ns/b']));
    click(canvas, 250, 100); expect(vi.mocked(drawScene).mock.lastCall?.[1].selection.focus).toEqual({ kind: 'task', key: 'ns/task' });
  });
  it('primary click opens the linked structure, while dragging from it suppresses links', () => {
    const { canvas } = mount();
    click(canvas, 320, 120);
    expect(window.open).toHaveBeenCalledWith('https://bytebot.knuteson.io', '_blank', 'noopener,noreferrer');
    vi.mocked(window.open).mockClear();
    fireEvent.pointerDown(canvas, pointer(320, 120));
    fireEvent.pointerMove(canvas, pointer(350, 150));
    fireEvent.pointerUp(canvas, releasedPointer(350, 150));
    expect(window.open).not.toHaveBeenCalled();
    expect([cam.offsetX, cam.offsetY]).toEqual([0, 0]);
  });
  it('Shift-drag marquee selects agents without moving the camera', () => {
    const { canvas } = mount(); fireEvent.pointerDown(canvas, pointer(80, 80, { shiftKey: true })); fireEvent.pointerMove(canvas, pointer(220, 160, { shiftKey: true })); tick();
    expect(vi.mocked(drawScene).mock.lastCall?.[1].marquee).not.toBeNull();
    fireEvent.pointerUp(canvas, releasedPointer(220, 160, { shiftKey: true })); tick();
    expect(vi.mocked(drawScene).mock.lastCall?.[1].selection.keys).toEqual(new Set(['ns/a', 'ns/b'])); expect([cam.offsetX, cam.offsetY]).toEqual([0, 0]);
  });
  it.each(['pointerCancel', 'lostPointerCapture', 'blur', 'outsideRelease'])('%s ends panning and ignores further motion', (ending) => {
    const { canvas } = mount(); fireEvent.pointerDown(canvas, pointer(500, 300)); fireEvent.pointerMove(canvas, pointer(550, 330));
    expect([cam.offsetX, cam.offsetY]).toEqual([50, 30]);
    expect(canvas.style.cursor).toBe('grabbing');
    if (ending === 'blur') fireEvent.blur(window);
    else if (ending === 'outsideRelease') { fireEvent.pointerLeave(canvas); fireEvent.pointerUp(canvas, releasedPointer(900, 600)); }
    else fireEvent[ending as 'pointerCancel' | 'lostPointerCapture'](canvas, pointer(550, 330));
    const offset = [cam.offsetX, cam.offsetY]; fireEvent.pointerMove(canvas, pointer(600, 350));
    expect([cam.offsetX, cam.offsetY]).toEqual(offset); expect(canvas.style.cursor).not.toBe('grabbing');
    if (ending !== 'lostPointerCapture') expect(release).toHaveBeenCalledWith(7);
  });
  it('ignores cancellation from a different pointer while the active pan continues', () => {
    const { canvas } = mount();
    fireEvent.pointerDown(canvas, pointer(500, 300));
    fireEvent.pointerMove(canvas, pointer(550, 330));
    fireEvent.pointerCancel(canvas, pointer(550, 330, { pointerId: 8 }));
    fireEvent.lostPointerCapture(canvas, pointer(550, 330, { pointerId: 8 }));
    fireEvent.pointerMove(canvas, pointer(570, 350));
    expect([cam.offsetX, cam.offsetY]).toEqual([70, 50]);
  });
  it.each([
    { initiatingButton: 0, heldButtons: 5, remainingButtons: 4, finalButton: 1, x: 500, y: 300 },
    { initiatingButton: 1, heldButtons: 5, remainingButtons: 1, finalButton: 0, x: 320, y: 120 },
  ])('ends button $initiatingButton pan when released while another button remains held', ({ initiatingButton, heldButtons, remainingButtons, finalButton, x, y }) => {
    const { canvas, queryByRole } = mount();
    click(canvas, 120, 120);
    fireEvent.pointerDown(canvas, pointer(x, y, { button: initiatingButton }));
    fireEvent.pointerMove(canvas, pointer(x + 30, y + 20, { button: -1, buttons: heldButtons }));
    expect([cam.offsetX, cam.offsetY]).toEqual([30, 20]);
    // An intermediate mouse-button release is pointermove, not pointerup.
    fireEvent.pointerMove(canvas, pointer(x + 50, y + 40, { button: initiatingButton, buttons: remainingButtons }));
    expect([cam.offsetX, cam.offsetY]).toEqual([30, 20]);
    expect(release).toHaveBeenCalledWith(7);
    expect(canvas.style.cursor).not.toBe('grabbing');
    fireEvent.pointerMove(canvas, pointer(x + 70, y + 60, { button: -1, buttons: remainingButtons }));
    fireEvent.pointerUp(canvas, releasedPointer(x + 70, y + 60, { button: finalButton }));
    tick();
    expect([cam.offsetX, cam.offsetY]).toEqual([30, 20]);
    expect(vi.mocked(drawScene).mock.lastCall?.[1].selection.keys).toEqual(new Set(['ns/a']));
    expect(window.open).not.toHaveBeenCalled();
    expect(queryByRole('dialog', { name: /dispatch/i })).toBeNull();
  });
  it('does not edge-scroll during a captured pan near the viewport border', () => {
    const { canvas } = mount(); fireEvent.pointerDown(canvas, pointer(500, 300)); fireEvent.pointerMove(canvas, pointer(790, 300));
    const offset = [cam.offsetX, cam.offsetY]; tick(); expect([cam.offsetX, cam.offsetY]).toEqual(offset); expect(cam.offsetX).toBe(290);
  });
});
