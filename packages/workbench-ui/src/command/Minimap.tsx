/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/**
 * Tactical minimap — bottom-right overlay. Renders a downscaled view
 * of the cluster's structures, the Gateway HQ, and the current camera
 * viewport rect. Click anywhere to ease the camera to that world point;
 * click-drag to scrub the camera continuously.
 *
 * Dimensions: 180×120 — small enough to leave the canvas legible,
 * large enough to be functional. World bounds are derived from the
 * layout each frame so the minimap auto-fits as agents grow / shrink.
 */

import { useEffect, useRef } from 'react';
import type { LayoutResult } from './layout.js';
import type { Camera } from './camera.js';
import { factionColor } from './voxel.js';
import styles from './Minimap.module.css';

const MM_W = 180;
const MM_H = 120;

interface MinimapProps {
  readonly layout: LayoutResult | null;
  readonly camera: Camera;
  readonly viewport: { w: number; h: number };
  readonly failedAgents: ReadonlySet<string>;
  readonly onJumpTo: (worldX: number, worldY: number) => void;
}

export function Minimap({
  layout,
  camera,
  viewport,
  failedAgents,
  onJumpTo,
}: MinimapProps): React.JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const draggingRef = useRef<boolean>(false);
  const rafRef = useRef<number | null>(null);

  // Re-paint per RAF so the viewport rect tracks live camera changes.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (canvas === null) return;
    const ctx = canvas.getContext('2d');
    if (ctx === null) return;
    const dpr = window.devicePixelRatio || 1;
    if (canvas.width !== MM_W * dpr || canvas.height !== MM_H * dpr) {
      canvas.width = MM_W * dpr;
      canvas.height = MM_H * dpr;
      canvas.style.width = `${String(MM_W)}px`;
      canvas.style.height = `${String(MM_H)}px`;
    }

    const draw = (): void => {
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      // Background — flat slate with PCB grid hint.
      ctx.fillStyle = '#070d18';
      ctx.fillRect(0, 0, MM_W, MM_H);
      ctx.strokeStyle = 'rgba(82, 200, 124, 0.06)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let x = 0; x <= MM_W; x += 30) {
        ctx.moveTo(x + 0.5, 0);
        ctx.lineTo(x + 0.5, MM_H);
      }
      for (let y = 0; y <= MM_H; y += 30) {
        ctx.moveTo(0, y + 0.5);
        ctx.lineTo(MM_W, y + 0.5);
      }
      ctx.stroke();

      if (layout === null) {
        rafRef.current = requestAnimationFrame(draw);
        return;
      }

      const bounds = computeWorldBounds(layout);
      const transform = (wx: number, wy: number): { mx: number; my: number } => {
        const tx = ((wx - bounds.x) / bounds.w) * MM_W;
        const ty = ((wy - bounds.y) / bounds.h) * MM_H;
        return { mx: tx, my: ty };
      };

      // Faction tint pads — soft polygon under each ns cluster.
      const byFaction = new Map<string, { x: number; y: number }[]>();
      for (const pos of layout.agents.values()) {
        const list = byFaction.get(pos.faction);
        if (list === undefined) byFaction.set(pos.faction, [{ x: pos.x, y: pos.y }]);
        else list.push({ x: pos.x, y: pos.y });
      }
      for (const [faction, points] of byFaction) {
        const c = factionColor(faction);
        ctx.fillStyle = withAlpha(c, 0.22);
        for (const p of points) {
          const { mx, my } = transform(p.x, p.y);
          ctx.beginPath();
          ctx.arc(mx, my, 5, 0, Math.PI * 2);
          ctx.fill();
        }
      }

      // Pips per agent — solid faction color, red border if recently
      // failed so the operator can see incident hot-zones at a glance.
      for (const pos of layout.agents.values()) {
        const { mx, my } = transform(pos.x, pos.y);
        const c = factionColor(pos.faction);
        const failed = failedAgents.has(pos.key);
        ctx.fillStyle = c;
        ctx.beginPath();
        ctx.arc(mx, my, failed ? 3.2 : 2.5, 0, Math.PI * 2);
        ctx.fill();
        if (failed) {
          ctx.strokeStyle = '#f87171';
          ctx.lineWidth = 1.5;
          ctx.stroke();
        }
      }

      // Gateway HQ — yellow diamond.
      const gw = transform(layout.gateway.x, layout.gateway.y);
      ctx.fillStyle = '#fbbf24';
      ctx.beginPath();
      ctx.moveTo(gw.mx, gw.my - 4);
      ctx.lineTo(gw.mx + 4, gw.my);
      ctx.lineTo(gw.mx, gw.my + 4);
      ctx.lineTo(gw.mx - 4, gw.my);
      ctx.closePath();
      ctx.fill();

      // Viewport rect — what the operator currently sees on the main canvas.
      const wL = -camera.offsetX / camera.zoom;
      const wT = -camera.offsetY / camera.zoom;
      const wR = (viewport.w - camera.offsetX) / camera.zoom;
      const wB = (viewport.h - camera.offsetY) / camera.zoom;
      const a = transform(wL, wT);
      const b = transform(wR, wB);
      ctx.strokeStyle = 'rgba(34, 211, 238, 0.85)';
      ctx.lineWidth = 1;
      ctx.setLineDash([3, 2]);
      ctx.strokeRect(
        Math.min(a.mx, b.mx) + 0.5,
        Math.min(a.my, b.my) + 0.5,
        Math.abs(b.mx - a.mx),
        Math.abs(b.my - a.my),
      );
      ctx.setLineDash([]);

      rafRef.current = requestAnimationFrame(draw);
    };
    rafRef.current = requestAnimationFrame(draw);
    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    };
  }, [layout, camera, viewport, failedAgents]);

  // Click / drag → invert minimap-pixel back to world space, jump camera.
  const minimapToWorld = (e: React.MouseEvent<HTMLCanvasElement>): void => {
    if (layout === null) return;
    const canvas = canvasRef.current;
    if (canvas === null) return;
    const rect = canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    const bounds = computeWorldBounds(layout);
    const wx = bounds.x + (mx / MM_W) * bounds.w;
    const wy = bounds.y + (my / MM_H) * bounds.h;
    onJumpTo(wx, wy);
  };

  return (
    <div className={styles.minimap}>
      <div className={styles.label}>MAP</div>
      <canvas
        ref={canvasRef}
        className={styles.canvas}
        onMouseDown={(e) => {
          draggingRef.current = true;
          minimapToWorld(e);
        }}
        onMouseMove={(e) => {
          if (draggingRef.current) minimapToWorld(e);
        }}
        onMouseUp={() => {
          draggingRef.current = false;
        }}
        onMouseLeave={() => {
          draggingRef.current = false;
        }}
      />
    </div>
  );
}

interface WorldBounds {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Bounding box of all structures + the gateway, padded ~12% so pips
 * don't sit flush against the minimap frame.
 */
function computeWorldBounds(layout: LayoutResult): WorldBounds {
  let minX = layout.gateway.x;
  let minY = layout.gateway.y;
  let maxX = layout.gateway.x;
  let maxY = layout.gateway.y;
  for (const pos of layout.agents.values()) {
    if (pos.x < minX) minX = pos.x;
    if (pos.y < minY) minY = pos.y;
    if (pos.x > maxX) maxX = pos.x;
    if (pos.y > maxY) maxY = pos.y;
  }
  const w = Math.max(400, maxX - minX);
  const h = Math.max(280, maxY - minY);
  const padX = w * 0.12;
  const padY = h * 0.12;
  return {
    x: minX - padX,
    y: minY - padY,
    w: w + padX * 2,
    h: h + padY * 2,
  };
}

function withAlpha(hex: string, alpha: number): string {
  const m = hex.match(/^#([0-9a-f]{6})$/i);
  if (m === null) return hex;
  const v = parseInt(m[1] ?? '0', 16);
  const r = (v >> 16) & 0xff;
  const g = (v >> 8) & 0xff;
  const b = v & 0xff;
  return `rgba(${String(r)}, ${String(g)}, ${String(b)}, ${alpha.toFixed(3)})`;
}
