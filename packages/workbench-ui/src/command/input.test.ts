/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

import { describe, expect, it } from 'vitest';
import { easeCameraTo, makeCamera } from './camera.js';
import { makeInputState, movePointerGesture, startPointerGesture } from './input.js';

describe('pointer input', () => {
  it.each([0.5, 2])('uses screen deltas at zoom %s and cancels camera tween', (zoom) => {
    const input = makeInputState();
    const camera = makeCamera();
    camera.zoom = zoom;
    easeCameraTo(camera, 100, 100, zoom, 1000, Date.now());
    startPointerGesture(input, 7, 0, false, false, 100, 100);
    movePointerGesture(input, camera, 7, 130, 120);
    movePointerGesture(input, camera, 7, 145, 125);
    expect([camera.offsetX, camera.offsetY, camera.zoom]).toEqual([45, 25, zoom]);
    expect(camera.tweenDurationMs).toBe(0);
    expect(input.drag).toBeNull();
  });
  it('filters click tremor, then applies the full drag distance on activation', () => {
    const input = makeInputState();
    const camera = makeCamera();
    startPointerGesture(input, 7, 0, false, false, 100, 100);
    movePointerGesture(input, camera, 7, 102, 100);
    expect(input.pointer?.activated).toBe(false);
    expect(camera.offsetX).toBe(0);
    movePointerGesture(input, camera, 7, 104, 100);
    expect(input.pointer?.activated).toBe(true);
    expect(camera.offsetX).toBe(4);
  });
  it('ignores motion from another pointer', () => {
    const input = makeInputState();
    const camera = makeCamera();
    startPointerGesture(input, 7, 1, true, true, 100, 100);
    movePointerGesture(input, camera, 8, 140, 140);
    expect([camera.offsetX, camera.offsetY]).toEqual([0, 0]);
    expect(input.pointer?.activated).toBe(false);
  });
  it('keeps Shift marquee in screen space and never pans', () => {
    const input = makeInputState();
    const camera = makeCamera();
    startPointerGesture(input, 7, 0, true, true, 100, 100);
    movePointerGesture(input, camera, 7, 140, 150);
    expect(input.drag).toEqual({ startX: 100, startY: 100, curX: 140, curY: 150, activated: true });
    expect([camera.offsetX, camera.offsetY]).toEqual([0, 0]);
  });
});
