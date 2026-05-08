/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/**
 * Ephemeral FX layer — particles, shockwaves, smoke pillars, screen
 * flashes. Threats become *visible canvas events* instead of log lines.
 *
 * Each effect has a TTL; after `expiresAt` it's culled. The renderer
 * draws every active effect each frame in world space (so they pan/
 * zoom with the camera).
 *
 * Effect kinds:
 *
 *   - shockwave: expanding ring at (x, y) — AIMD breach / failure cluster.
 *   - smoke:     rising column of dark puffs — pod CrashLoopBackoff,
 *                Failed task aftermath.
 *   - flash:     screen-edge glow — cost cap approaching, big alert.
 *   - cheer:     burst of upward sparks — Completed task at agent.
 */

export type Fx =
  | {
      readonly kind: 'shockwave';
      readonly x: number;
      readonly y: number;
      readonly color: string;
      readonly startedAt: number;
      readonly durationMs: number;
      readonly maxRadius: number;
    }
  | {
      readonly kind: 'smoke';
      readonly x: number;
      readonly y: number;
      readonly startedAt: number;
      readonly durationMs: number;
    }
  | {
      readonly kind: 'flash';
      readonly color: string;
      readonly startedAt: number;
      readonly durationMs: number;
      readonly intensity: number;
    }
  | {
      readonly kind: 'cheer';
      readonly x: number;
      readonly y: number;
      readonly startedAt: number;
      readonly durationMs: number;
    };

export class FxLayer {
  private effects: Fx[] = [];

  emit(fx: Fx): void {
    this.effects.push(fx);
    // Keep buffer bounded — under sustained churn, drop oldest.
    if (this.effects.length > 64) {
      this.effects.splice(0, this.effects.length - 64);
    }
  }

  prune(nowMs: number): void {
    this.effects = this.effects.filter((f) => nowMs - f.startedAt < f.durationMs);
  }

  list(): readonly Fx[] {
    return this.effects;
  }
}

/**
 * Render every active effect to a 2D context. Caller must already
 * have applied the camera transform — effects are in world space
 * EXCEPT for `flash`, which targets screen edges and ignores camera.
 */
export function drawFx(
  ctx: CanvasRenderingContext2D,
  fx: readonly Fx[],
  nowMs: number,
  viewport: { w: number; h: number },
  cameraZoom: number,
): void {
  for (const f of fx) {
    const age = nowMs - f.startedAt;
    if (age < 0 || age >= f.durationMs) continue;
    const t = age / f.durationMs; // 0..1

    if (f.kind === 'shockwave') {
      const radius = f.maxRadius * easeOutCubic(t);
      const alpha = 1 - t;
      ctx.strokeStyle = withAlpha(f.color, alpha * 0.85);
      ctx.lineWidth = 3 / cameraZoom;
      ctx.beginPath();
      ctx.arc(f.x, f.y, radius, 0, Math.PI * 2);
      ctx.stroke();
      // Inner echo ring, half radius, for a layered "ka-pow" feel.
      ctx.strokeStyle = withAlpha(f.color, alpha * 0.5);
      ctx.lineWidth = 1.5 / cameraZoom;
      ctx.beginPath();
      ctx.arc(f.x, f.y, radius * 0.6, 0, Math.PI * 2);
      ctx.stroke();
    } else if (f.kind === 'smoke') {
      // 4 puffs at staggered ages, rising and fading.
      for (let i = 0; i < 4; i++) {
        const puffStart = (i * f.durationMs) / 6;
        const puffAge = age - puffStart;
        if (puffAge < 0) continue;
        const puffT = Math.min(1, puffAge / (f.durationMs * 0.7));
        const yOffset = -puffT * 60;
        const xJitter = Math.sin((i + 1) * 1.7 + puffT * 4) * 6;
        const r = 6 + puffT * 12;
        const alpha = (1 - puffT) * 0.55;
        ctx.fillStyle = withAlpha('#3a3530', alpha);
        ctx.beginPath();
        ctx.arc(f.x + xJitter, f.y + yOffset, r, 0, Math.PI * 2);
        ctx.fill();
      }
      // Fire-glow at the base while the smoke is going.
      if (t < 0.6) {
        const glowAlpha = (0.6 - t) * 0.9;
        ctx.fillStyle = withAlpha('#fb923c', glowAlpha);
        ctx.beginPath();
        ctx.arc(f.x, f.y, 8 + Math.sin(nowMs / 80) * 2, 0, Math.PI * 2);
        ctx.fill();
      }
    } else if (f.kind === 'cheer') {
      // 6 upward sparks
      for (let i = 0; i < 6; i++) {
        const phase = (i * 0.16) % 1;
        const sparkT = (t + phase) % 1;
        const y = f.y - sparkT * 40;
        const x = f.x + (i - 2.5) * 4;
        const alpha = (1 - sparkT) * 0.8;
        ctx.fillStyle = withAlpha('#34d399', alpha);
        ctx.beginPath();
        ctx.arc(x, y, 2, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    // `flash` is rendered separately by drawFxScreen — it ignores camera.
  }
}

/**
 * Render screen-space effects (full-viewport edge glows). Caller must
 * reset transform before invoking — these target the raw canvas.
 */
export function drawFxScreen(
  ctx: CanvasRenderingContext2D,
  fx: readonly Fx[],
  nowMs: number,
  viewport: { w: number; h: number },
): void {
  for (const f of fx) {
    if (f.kind !== 'flash') continue;
    const age = nowMs - f.startedAt;
    if (age < 0 || age >= f.durationMs) continue;
    const t = age / f.durationMs;
    const alpha = (1 - t) * f.intensity;
    const grad = ctx.createRadialGradient(
      viewport.w / 2,
      viewport.h / 2,
      Math.min(viewport.w, viewport.h) * 0.3,
      viewport.w / 2,
      viewport.h / 2,
      Math.max(viewport.w, viewport.h) * 0.7,
    );
    grad.addColorStop(0, withAlpha(f.color, 0));
    grad.addColorStop(1, withAlpha(f.color, alpha));
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, viewport.w, viewport.h);
  }
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

function easeOutCubic(t: number): number {
  return 1 - Math.pow(1 - t, 3);
}
