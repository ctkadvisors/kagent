/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/**
 * Header-trust auth middleware for the workbench API.
 *
 * Trust model: Traefik (or any other reverse-proxy / forward-auth shim)
 * sits in front of the workbench-api Service and authenticates the
 * request, then forwards the verified user identity in the
 * `X-Forwarded-User` header. The workbench-api trusts that header and
 * exposes the user identity on the Hono context as `c.get('user')`.
 *
 * Fail-closed defaults — see WS-A (security baseline):
 *   - When `WORKBENCH_AUTH_REQUIRED` is unset OR set to anything other
 *     than the literal `"false"`, requests without `X-Forwarded-User`
 *     are rejected with HTTP 401.
 *   - Setting `WORKBENCH_AUTH_REQUIRED=false` is the ONLY way to disable
 *     enforcement. The boot-path logs a loud warning when that's done.
 *
 * Probe exemption: `/healthz` and `/readyz` are ALWAYS allowed through,
 * regardless of `authRequired`, so the kubelet can probe the pod without
 * an upstream auth shim being in the request path.
 *
 * Why a header (not a session cookie / JWT verification) — DESIGN-V0.1.md
 * §10 ("Auth: header-trust"): the workbench is a per-cluster operator
 * console, not a multi-tenant SaaS surface. The same Traefik that fronts
 * the rest of the homelab handles SSO via forwardAuth; doing JWT
 * verification HERE would just duplicate the trust boundary one hop in.
 */

import type { MiddlewareHandler } from 'hono';

/** Hono context variables this middleware writes. */
export interface AuthVariables {
  /** Authenticated user id from the upstream forward-auth shim. */
  user: string;
}

const FORWARDED_USER_HEADER = 'X-Forwarded-User';

/** Paths that bypass auth entirely (kubelet probes). */
const ALWAYS_ALLOWED_PATHS = new Set(['/healthz', '/readyz']);

export interface AuthMiddlewareOptions {
  /**
   * When true, requests without `X-Forwarded-User` get HTTP 401. Default
   * is true (fail closed). Resolve from env via `resolveAuthRequired()`.
   */
  readonly required: boolean;
}

/**
 * Resolve `authRequired` from the environment per the WS-A contract:
 * fail-closed unless the literal string `"false"` is set.
 *
 * Exposed for tests + so `main.ts` can log a warning when auth is
 * disabled at boot.
 */
export function resolveAuthRequired(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env.WORKBENCH_AUTH_REQUIRED;
  // Only the EXACT literal "false" disables auth. Empty / unset / any
  // other value (including "0" / "no" / typos) keeps auth on.
  return raw !== 'false';
}

/**
 * Hono middleware that enforces `X-Forwarded-User` presence when
 * `opts.required` is true. Probes (`/healthz`, `/readyz`) are exempt.
 *
 * On success, writes the user id to `c.var.user` for downstream
 * handlers. On failure, returns a JSON 401.
 */
export function buildAuthMiddleware(opts: AuthMiddlewareOptions): MiddlewareHandler {
  return async (c, next) => {
    if (ALWAYS_ALLOWED_PATHS.has(c.req.path)) {
      await next();
      return;
    }

    const headerValue = c.req.header(FORWARDED_USER_HEADER);
    const user = typeof headerValue === 'string' ? headerValue.trim() : '';

    if (user.length > 0) {
      // Header present — record the user even when auth is "not
      // required" so downstream handlers / logs see the same shape.
      c.set('user' as never, user as never);
      await next();
      return;
    }

    if (!opts.required) {
      await next();
      return;
    }

    return c.json(
      {
        error: 'unauthenticated',
        reason: 'missing X-Forwarded-User header',
      },
      401,
    );
  };
}
