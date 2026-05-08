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

import type { CameraBookmark } from './camera.js';

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
