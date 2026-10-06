/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/**
 * Mutable input state — keys held, mouse position, drag selection,
 * control groups. Lives in a ref so the RAF loop can read it without
 * triggering React re-renders.
 *
 * The CommandView wires raw window/canvas events into this state and
 * the renderer consumes it each frame.
 */

import { cancelTween, type Camera, type CameraBookmark } from './camera.js';

export interface InputState {
  /** Held keys for WASD/arrow camera pan. */
  keys: {
    w: boolean;
    a: boolean;
    s: boolean;
    d: boolean;
    up: boolean;
    left: boolean;
    down: boolean;
    right: boolean;
  };
  /**
   * Mouse position in canvas-CSS-pixel space. `inside` is set by
   * pointerenter/leave so edge-scroll doesn't fire when the cursor
   * has left the canvas.
   */
  mouse: {
    x: number;
    y: number;
    inside: boolean;
  };
  /**
   * Drag-select marquee state. Recorded in screen-space pixels (we
   * convert to world space at hit-test time so the box scales with
   * camera zoom). `null` when no drag is active.
   */
  drag: { startX: number; startY: number; curX: number; curY: number; activated: boolean } | null;
  /** Active captured pointer gesture; transient state never drives per-frame React renders. */
  pointer: {
    id: number;
    mode: 'pan' | 'marquee' | 'click';
    button: number;
    shift: boolean;
    startX: number;
    startY: number;
    lastX: number;
    lastY: number;
    activated: boolean;
  } | null;
  /** Control groups bound via Ctrl+1..9 — each holds the agent keys at bind time. */
  controlGroups: Map<number, ReadonlySet<string>>;
  /** F-key camera bookmarks. */
  bookmarks: Map<number, CameraBookmark>;
}

export function makeInputState(): InputState {
  return {
    keys: {
      w: false,
      a: false,
      s: false,
      d: false,
      up: false,
      left: false,
      down: false,
      right: false,
    },
    mouse: { x: 0, y: 0, inside: false },
    drag: null,
    pointer: null,
    controlGroups: new Map(),
    bookmarks: new Map(),
  };
}

/**
 * Activation threshold for drag-select — small mouse movements
 * shouldn't accidentally start a marquee. 4 px is enough to filter
 * out "I clicked but my hand twitched" without feeling sluggish.
 */
export const DRAG_ACTIVATE_PX = 4;

/** Choose once at press time so moving over a building cannot turn a pan into a click. */
export function startPointerGesture(
  input: InputState,
  id: number,
  button: number,
  shift: boolean,
  hit: boolean,
  x: number,
  y: number,
): NonNullable<InputState['pointer']> {
  const mode = button === 1 ? 'pan' : shift ? 'marquee' : hit ? 'click' : 'pan';
  input.pointer = {
    id,
    mode,
    button,
    shift,
    startX: x,
    startY: y,
    lastX: x,
    lastY: y,
    activated: false,
  };
  input.drag =
    mode === 'marquee' ? { startX: x, startY: y, curX: x, curY: y, activated: false } : null;
  return input.pointer;
}

/** Camera offsets are CSS screen pixels, so drag deltas never divide by zoom. */
export function movePointerGesture(
  input: InputState,
  cam: Camera,
  id: number,
  x: number,
  y: number,
): void {
  const pointer = input.pointer;
  if (pointer === null || pointer.id !== id) return;
  const wasActivated = pointer.activated;
  if (Math.hypot(x - pointer.startX, y - pointer.startY) >= DRAG_ACTIVATE_PX)
    pointer.activated = true;
  if (pointer.mode === 'pan' && pointer.activated) {
    cancelTween(cam);
    cam.offsetX += x - (wasActivated ? pointer.lastX : pointer.startX);
    cam.offsetY += y - (wasActivated ? pointer.lastY : pointer.startY);
  }
  pointer.lastX = x;
  pointer.lastY = y;
  if (input.drag !== null) {
    input.drag.curX = x;
    input.drag.curY = y;
    input.drag.activated = pointer.activated;
  }
}
