/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/**
 * Camera transform for the Command view.
 *
 * The scene renderer draws in "world" coordinates — agent positions
 * computed by `layout.ts` against the canvas's full viewport size.
 * The camera applies (translate, scale) on top, so the user can pan
 * (WASD / edge-scroll) and zoom (mouse wheel) without changing the
 * underlying layout.
 *
 *   screen = world * zoom + offset
 *   world  = (screen - offset) / zoom
 *
 * Bookmarks (F5–F8) snapshot the {offsetX, offsetY, zoom} triple so
 * the operator can pin incident-response zones (Cost panel, Errors,
 * Premium tier, Custom) and snap-jump between them.
 *
 * No inertia / no tween — RTS muscle memory expects WASD to feel
 * direct, not gliding. `panFromKeys` integrates velocity per frame
 * given the currently-pressed keys.
 */

export interface Camera {
  offsetX: number;
  offsetY: number;
  zoom: number;
}

export interface CameraBookmark {
  readonly offsetX: number;
  readonly offsetY: number;
  readonly zoom: number;
}

export const MIN_ZOOM = 0.4;
export const MAX_ZOOM = 2.5;
export const PAN_SPEED_PX_PER_SEC = 900; // canvas pixels per second at zoom=1
export const EDGE_PAN_PX = 24; // edge-scroll trigger distance
export const ZOOM_STEP = 1.1; // multiplicative per wheel tick

export function makeCamera(): Camera {
  return { offsetX: 0, offsetY: 0, zoom: 1 };
}

export function clampZoom(z: number): number {
  return z < MIN_ZOOM ? MIN_ZOOM : z > MAX_ZOOM ? MAX_ZOOM : z;
}

/**
 * Convert a screen-space (canvas-CSS-pixel) point to world space, given
 * the camera's current transform.
 */
export function screenToWorld(cam: Camera, sx: number, sy: number): { x: number; y: number } {
  return {
    x: (sx - cam.offsetX) / cam.zoom,
    y: (sy - cam.offsetY) / cam.zoom,
  };
}

/**
 * Zoom the camera around a fixed screen-space anchor — the world point
 * under (anchorSx, anchorSy) stays at the same pixel after the zoom
 * change. This is what makes wheel-zoom feel right: the cursor stays
 * locked onto whatever you were pointing at.
 */
export function zoomAt(cam: Camera, anchorSx: number, anchorSy: number, factor: number): void {
  const newZoom = clampZoom(cam.zoom * factor);
  const realFactor = newZoom / cam.zoom;
  // Solve for new offset: world point under anchor must project to
  // the same screen point under the new zoom.
  //   world.x = (anchorSx - cam.offsetX) / cam.zoom
  //   anchorSx = world.x * newZoom + newOffsetX
  //   newOffsetX = anchorSx - (anchorSx - cam.offsetX) * realFactor
  cam.offsetX = anchorSx - (anchorSx - cam.offsetX) * realFactor;
  cam.offsetY = anchorSy - (anchorSy - cam.offsetY) * realFactor;
  cam.zoom = newZoom;
}

export interface PressedKeys {
  readonly w: boolean;
  readonly a: boolean;
  readonly s: boolean;
  readonly d: boolean;
  readonly up: boolean;
  readonly left: boolean;
  readonly down: boolean;
  readonly right: boolean;
}

/**
 * Integrate WASD / arrow-key pan over a frame's `dtSec`. Mutates `cam`
 * in place. Speed is constant (no inertia) — direct RTS feel.
 */
export function panFromKeys(cam: Camera, keys: PressedKeys, dtSec: number): void {
  let dx = 0;
  let dy = 0;
  if (keys.a || keys.left) dx += 1;
  if (keys.d || keys.right) dx -= 1;
  if (keys.w || keys.up) dy += 1;
  if (keys.s || keys.down) dy -= 1;
  if (dx === 0 && dy === 0) return;
  // Normalize diagonal so it doesn't go √2× faster.
  const len = Math.hypot(dx, dy);
  dx /= len;
  dy /= len;
  cam.offsetX += dx * PAN_SPEED_PX_PER_SEC * dtSec;
  cam.offsetY += dy * PAN_SPEED_PX_PER_SEC * dtSec;
}

/**
 * Integrate edge-scroll pan over a frame, given the mouse's current
 * position relative to the viewport. When the mouse is within
 * EDGE_PAN_PX of an edge, pan in that direction.
 */
export function panFromEdge(
  cam: Camera,
  mouse: { x: number; y: number; insideViewport: boolean },
  viewport: { w: number; h: number },
  dtSec: number,
): void {
  if (!mouse.insideViewport) return;
  let dx = 0;
  let dy = 0;
  if (mouse.x < EDGE_PAN_PX) dx += (EDGE_PAN_PX - mouse.x) / EDGE_PAN_PX;
  else if (mouse.x > viewport.w - EDGE_PAN_PX)
    dx -= (mouse.x - (viewport.w - EDGE_PAN_PX)) / EDGE_PAN_PX;
  if (mouse.y < EDGE_PAN_PX) dy += (EDGE_PAN_PX - mouse.y) / EDGE_PAN_PX;
  else if (mouse.y > viewport.h - EDGE_PAN_PX)
    dy -= (mouse.y - (viewport.h - EDGE_PAN_PX)) / EDGE_PAN_PX;
  if (dx === 0 && dy === 0) return;
  // Edge scroll uses 0.7× WASD speed — easy to control.
  cam.offsetX += dx * PAN_SPEED_PX_PER_SEC * 0.7 * dtSec;
  cam.offsetY += dy * PAN_SPEED_PX_PER_SEC * 0.7 * dtSec;
}

/**
 * Reset to the default view (offset=0, zoom=1) — Space-bar "recenter
 * on gateway" since the gateway is at the canvas centroid.
 */
export function resetCamera(cam: Camera): void {
  cam.offsetX = 0;
  cam.offsetY = 0;
  cam.zoom = 1;
}

export function applyBookmark(cam: Camera, b: CameraBookmark): void {
  cam.offsetX = b.offsetX;
  cam.offsetY = b.offsetY;
  cam.zoom = b.zoom;
}

export function snapshotBookmark(cam: Camera): CameraBookmark {
  return { offsetX: cam.offsetX, offsetY: cam.offsetY, zoom: cam.zoom };
}
