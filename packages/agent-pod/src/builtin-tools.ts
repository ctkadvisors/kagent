/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/**
 * Built-in in-process tool bundle for the agent-pod runtime.
 *
 * Phase 5 / Platform-Priorities P2 — wire `Agent.spec.tools` to the
 * smallest set of tools the researcher workload needs:
 *
 *   - `http_get`       — HTTP GET with allowlist + SSRF protection
 *   - `rss_fetch`      — RSS / Atom feed fetch + tiny inline parser
 *   - `extract_text`   — strip HTML tags, collapse whitespace
 *   - `write_artifact` — persist outputs to a PVC mount + emit ArtifactRef (P3)
 *
 * This is NOT the `ToolBroker` / `ToolBinding` CRD design from
 * `docs/TOOL-BROKER.md` — that lands in P6 once the policy primitive is
 * a first-class CRD. Until then, every dangerous decision is locked
 * down at the in-pod tool layer:
 *
 *   1. Hostnames are checked against `KAGENT_BUILTIN_TOOLS_HTTP_ALLOW_DOMAINS`
 *      (comma-separated, default-deny). Empty / unset env var means ALL
 *      fetches are refused. Match is exact host OR `.<domain>` suffix.
 *   2. Even if the host is allowed, the URL is run through `assertUrlIsSafe`,
 *      which inspects the host literal and rejects loopback / link-local /
 *      RFC1918 / multicast / 0.0.0.0 destinations. This is the literal-IP
 *      backstop against an LLM picking `http://10.0.0.1.allowed.example.com`.
 *   3. After the literal check, hostnames are DNS-resolved
 *      (`assertHostResolvesPublicly`) and rejected if ANY returned address
 *      is private/loopback/link-local/IPv6. Catches the case where an
 *      allowlisted hostname resolves to a private address (intentionally,
 *      via DNS rebinding, or accidentally via split-horizon DNS).
 *   4. Redirects are followed manually (`redirect: 'manual'`) and re-checked
 *      against the same allowlist + literal-IP + DNS rules; up to 5 hops.
 *   4. Bodies are truncated to 1MB to bound trace cost. Headers exposed to
 *      the LLM are an allowlist (`content-type`, `etag`, `last-modified`).
 *   5. `write_artifact` writes ONLY under `<KAGENT_ARTIFACTS_DIR>/<task-uid>/`,
 *      refuses path traversal (`..`, leading slash, non-printable chars), and
 *      writes atomically (`<name>.tmp` then rename). No subprocess, no
 *      `eval`, no shell-out anywhere in this file.
 */

import { promises as dns } from 'node:dns';

import type { ContentBlock, ToolInvocationContext, ToolProvider } from '@kagent/agent-loop';
import { defineInProcessTool, InProcessToolProvider } from '@kagent/in-process-tool-provider';
import type { InProcessToolDefinition } from '@kagent/in-process-tool-provider';

import {
  inlineArtifactRef,
  inlineSafeForArtifact,
  resolveWriterEnvOrDisabled,
  validateArtifactName,
  writeArtifactToDisk,
  type ArtifactRegistry,
} from './artifacts.js';
import type { CasBackend } from './cas-backend.js';

/* =====================================================================
 * Constants — kept module-scoped for unit-test visibility.
 * ===================================================================== */

/** Cap on response body size returned to the LLM (bytes). */
export const HTTP_MAX_BODY_BYTES = 1 * 1024 * 1024; // 1MB

/** Cap on `extract_text` output size returned to the LLM (bytes / chars). */
export const EXTRACT_TEXT_MAX_BYTES = 50 * 1024; // 50KB

/** Hard cap on redirect hops before we refuse to follow. */
export const HTTP_MAX_REDIRECTS = 5;

/** Per-request fetch timeout — bounds a single hop's latency. */
export const HTTP_FETCH_TIMEOUT_MS = 30_000;

/** Header keys allowed to surface back to the LLM in tool results. */
export const HTTP_RESPONSE_HEADER_ALLOWLIST: readonly string[] = [
  'content-type',
  'etag',
  'last-modified',
];

/** Env var name for the per-deployment domain allowlist. */
export const ENV_ALLOW_DOMAINS = 'KAGENT_BUILTIN_TOOLS_HTTP_ALLOW_DOMAINS';

/* =====================================================================
 * Allowlist parsing
 * ===================================================================== */

/**
 * Parse the `KAGENT_BUILTIN_TOOLS_HTTP_ALLOW_DOMAINS` env var into a
 * frozen string set. Default-deny: when the env var is unset or empty,
 * the returned set is empty and every fetch refuses.
 */
export function parseAllowedDomains(raw: string | undefined): ReadonlySet<string> {
  if (typeof raw !== 'string') return new Set();
  const items = raw
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s.length > 0);
  return new Set(items);
}

/**
 * Match a URL hostname against the allowlist. A host is allowed when
 * either:
 *
 *   - its lowercased name is exactly an allowlist entry, OR
 *   - it is a sub-domain of an allowlist entry (`<x>.<entry>`)
 *
 * Sub-domain match is intentional — operators set
 * `arxiv.org,nytimes.com` and get every section of those hosts without
 * having to enumerate paths.
 */
export function isHostAllowed(host: string, allowed: ReadonlySet<string>): boolean {
  const h = host.toLowerCase();
  if (allowed.has(h)) return true;
  for (const entry of allowed) {
    if (h.endsWith(`.${entry}`)) return true;
  }
  return false;
}

/* =====================================================================
 * SSRF guard — host-literal IP rejection
 * ===================================================================== */

/**
 * IPv4 ranges we refuse, regardless of whether the URL passed the domain
 * allowlist. Operators MUST NOT be able to set
 * `KAGENT_BUILTIN_TOOLS_HTTP_ALLOW_DOMAINS=10.0.0.5` and accidentally
 * grant kube-apiserver / NATS / LiteLLM access to the LLM.
 *
 *   127.0.0.0/8     loopback
 *   10.0.0.0/8      RFC1918
 *   172.16.0.0/12   RFC1918
 *   192.168.0.0/16  RFC1918
 *   169.254.0.0/16  link-local (cloud metadata services)
 *   0.0.0.0/8       "this network" / unspecified
 *   100.64.0.0/10   shared address space (CGNAT)
 *   224.0.0.0/4     multicast
 *   240.0.0.0/4     reserved (incl. broadcast)
 */
function isPrivateIPv4(ip: string): boolean {
  const parts = ip.split('.');
  if (parts.length !== 4) return false;
  const octets = parts.map((p) => Number(p));
  if (octets.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false;
  const [a, b] = octets as [number, number, number, number];
  if (a === 127) return true;
  if (a === 10) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 169 && b === 254) return true;
  if (a === 0) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a >= 224) return true; // multicast (224/4) + reserved (240/4)
  return false;
}

/**
 * Conservative IPv6 reject — we do NOT try to do full address-class
 * arithmetic for IPv6. Any literal `[ipv6]` URL is refused. The
 * researcher workload exclusively hits public IPv4-resolvable hosts; if
 * a future workload needs IPv6 the rule moves to `ToolBroker`.
 */
function isIPv6Literal(host: string): boolean {
  // bracketed form (URL strips brackets in `URL.hostname`); pure colon
  // detection is fine since DNS hostnames cannot contain `:`.
  return host.includes(':');
}

/**
 * Whether a host string is a bare IPv4 literal. We treat anything that
 * matches the dotted-quad shape as an IP — DNS hostnames cannot collide
 * with this regex.
 */
function isIPv4Literal(host: string): boolean {
  return /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);
}

/**
 * Validate a URL against the allowlist + SSRF rules. Throws on any
 * refusal so callers can let the catch-arm in `InProcessToolProvider`
 * convert the throw to `ToolResult{isError:true}` — the LLM sees a
 * structured error, the trace records the policy denial.
 *
 * Refusal taxonomy (kept in error messages so they surface in traces):
 *   - `policy_denied: only http(s) URLs are allowed`
 *   - `policy_denied: domain "<host>" is not in the allowlist`
 *   - `policy_denied: host "<host>" resolves to a private / loopback / link-local address`
 *   - `policy_denied: IPv6 destinations are not supported`
 */
export function assertUrlIsSafe(url: string, allowed: ReadonlySet<string>): URL {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`policy_denied: malformed URL "${truncateForError(url)}"`);
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`policy_denied: only http(s) URLs are allowed (got "${parsed.protocol}")`);
  }

  const host = parsed.hostname;
  if (host.length === 0) {
    throw new Error('policy_denied: URL has no host');
  }

  if (isIPv6Literal(host)) {
    throw new Error('policy_denied: IPv6 destinations are not supported');
  }

  if (isIPv4Literal(host)) {
    if (isPrivateIPv4(host)) {
      throw new Error(
        `policy_denied: host "${host}" resolves to a private / loopback / link-local address`,
      );
    }
    // A public IPv4 literal also has to be domain-allowlisted (we don't
    // want LLMs constructing `http://1.1.1.1`).
    if (!isHostAllowed(host, allowed)) {
      throw new Error(`policy_denied: host "${host}" is not in the allowlist`);
    }
    return parsed;
  }

  if (!isHostAllowed(host, allowed)) {
    throw new Error(`policy_denied: domain "${host}" is not in the allowlist`);
  }
  return parsed;
}

function truncateForError(s: string): string {
  return s.length > 120 ? `${s.slice(0, 117)}...` : s;
}

/* =====================================================================
 * SSRF guard — DNS-resolution check for hostnames
 *
 * `assertUrlIsSafe` only inspects the URL string. A hostname like
 * `evil.example.com` that resolves to `192.168.0.1` would slip through
 * (the literal-IP branch is never hit). This second-stage check
 * resolves the host via the OS resolver and rejects if ANY returned
 * address is private / loopback / link-local / IPv6.
 *
 * TOCTOU: between this lookup and the actual fetch, DNS could change
 * (DNS rebinding). v0.1 accepts that small window — eliminating it
 * requires connecting to a pinned IP, which Node's `fetch` doesn't
 * cleanly support. The realistic exposure surface is "an LLM-supplied
 * URL whose owner controls the DNS"; pinning would require a custom
 * `Agent`/`undici.Pool` and a Host-header rewrite. Tracked for v0.2.
 * ===================================================================== */

/** Optional DNS resolver injection point — mirrors env.fetch for tests. */
export type LookupFn = (host: string) => Promise<readonly { address: string; family: 4 | 6 }[]>;

const defaultLookup: LookupFn = async (host) => {
  const records = await dns.lookup(host, { all: true });
  return records.map((r) => ({ address: r.address, family: r.family as 4 | 6 }));
};

/**
 * Resolve `host` and assert every returned address is publicly routable
 * IPv4. Throws `policy_denied: ...` on:
 *   - any IPv6 record (matches the existing IPv6-literal stance)
 *   - any IPv4 in a private / loopback / link-local / multicast range
 *   - lookup failure (no addresses, ENOTFOUND, etc. — fail-closed)
 *
 * The function is async because OS resolution is async; safeFetch runs
 * it once per hop after the synchronous `assertUrlIsSafe` check.
 */
export async function assertHostResolvesPublicly(
  host: string,
  lookup: LookupFn = defaultLookup,
): Promise<void> {
  // Skip the resolver for IP literals — `assertUrlIsSafe` has already
  // run the private-range check synchronously for those, and we don't
  // want to hand `dns.lookup` a literal (some resolvers handle it,
  // some don't).
  if (isIPv4Literal(host) || isIPv6Literal(host)) return;

  let records: readonly { address: string; family: 4 | 6 }[];
  try {
    records = await lookup(host);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(`policy_denied: DNS lookup for "${host}" failed: ${reason}`);
  }

  if (records.length === 0) {
    throw new Error(`policy_denied: DNS lookup for "${host}" returned no addresses`);
  }

  for (const r of records) {
    if (r.family === 6) {
      throw new Error(
        `policy_denied: host "${host}" resolves to IPv6 (${r.address}); IPv6 destinations are not supported`,
      );
    }
    if (isPrivateIPv4(r.address)) {
      throw new Error(
        `policy_denied: host "${host}" resolves to a private / loopback / link-local address (${r.address})`,
      );
    }
  }
}

/* =====================================================================
 * HTTP fetch with manual redirect handling
 * ===================================================================== */

interface FetchEnv {
  readonly allowed: ReadonlySet<string>;
  readonly fetch?: typeof fetch;
  /**
   * Test-injectable DNS resolver. Production uses Node's `dns.promises.lookup`
   * via `defaultLookup`. Tests pass a stub that returns canned address
   * records, exercising the SSRF rejection paths without going to real DNS.
   */
  readonly lookup?: LookupFn;
}

interface SafeFetchResult {
  readonly status: number;
  readonly headers: Record<string, string>;
  readonly bodyBytes: Uint8Array;
  readonly truncated: boolean;
  readonly finalUrl: string;
}

/**
 * Perform an HTTP GET that re-validates every redirect target against
 * `assertUrlIsSafe`. Bodies are read with a hard cap at
 * `HTTP_MAX_BODY_BYTES`; we mark `truncated: true` when the cap fires.
 *
 * Each hop carries its own `AbortSignal.timeout(HTTP_FETCH_TIMEOUT_MS)`
 * composed with the caller's signal so a stuck origin cannot pin the
 * pod beyond the configured timeout.
 */
async function safeFetch(
  initialUrl: string,
  env: FetchEnv,
  ctx: ToolInvocationContext,
): Promise<SafeFetchResult> {
  const fetchImpl = env.fetch ?? fetch;
  const lookup = env.lookup ?? defaultLookup;
  let target = assertUrlIsSafe(initialUrl, env.allowed);
  await assertHostResolvesPublicly(target.hostname, lookup);

  for (let hop = 0; hop <= HTTP_MAX_REDIRECTS; hop++) {
    const hopTimeout = AbortSignal.timeout(HTTP_FETCH_TIMEOUT_MS);
    const signal = AbortSignal.any([ctx.abortSignal, hopTimeout]);

    const response = await fetchImpl(target, {
      method: 'GET',
      redirect: 'manual',
      signal,
      headers: {
        'user-agent': 'kagent-agent-pod/0.x (+https://github.com/ctkadvisors/kagent)',
        accept: '*/*',
      },
    });

    const status = response.status;
    if (status >= 300 && status < 400) {
      const location = response.headers.get('location');
      if (location === null) {
        throw new Error(`upstream returned ${status} with no Location header`);
      }
      const next = new URL(location, target);
      target = assertUrlIsSafe(next.toString(), env.allowed);
      await assertHostResolvesPublicly(target.hostname, lookup);
      // Drain the redirect body so the connection can be reused.
      try {
        await response.arrayBuffer();
      } catch {
        // ignore drain errors; we are about to issue a new request
      }
      continue;
    }

    const headers = filterResponseHeaders(response.headers);
    const { bytes, truncated } = await readBodyCapped(response, HTTP_MAX_BODY_BYTES);
    return {
      status,
      headers,
      bodyBytes: bytes,
      truncated,
      finalUrl: target.toString(),
    };
  }

  throw new Error(
    `policy_denied: redirect chain exceeded ${HTTP_MAX_REDIRECTS} hops (last="${target.toString()}")`,
  );
}

function filterResponseHeaders(h: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of HTTP_RESPONSE_HEADER_ALLOWLIST) {
    const v = h.get(key);
    if (v !== null) out[key] = v;
  }
  return out;
}

async function readBodyCapped(
  res: Response,
  cap: number,
): Promise<{ bytes: Uint8Array; truncated: boolean }> {
  // Stream the body so we can early-exit at the cap rather than
  // buffering an unbounded payload from a hostile / runaway origin.
  if (res.body === null) {
    return { bytes: new Uint8Array(0), truncated: false };
  }
  const reader = res.body.getReader() as ReadableStreamDefaultReader<Uint8Array>;
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value === undefined) continue;
      const chunk: Uint8Array = value;
      total += chunk.byteLength;
      if (total > cap) {
        const overshoot = total - cap;
        const keep = chunk.byteLength - overshoot;
        if (keep > 0) chunks.push(chunk.subarray(0, keep));
        truncated = true;
        try {
          await reader.cancel();
        } catch {
          // ignore — we just want to stop pulling
        }
        break;
      }
      chunks.push(chunk);
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // ignore — already released after cancel()
    }
  }
  const merged = new Uint8Array(Math.min(total, cap));
  let offset = 0;
  for (const c of chunks) {
    merged.set(c, offset);
    offset += c.byteLength;
  }
  return { bytes: merged, truncated };
}

function decodeBody(bytes: Uint8Array, headers: Record<string, string>): string {
  const ct = headers['content-type'] ?? '';
  const charsetMatch = /charset=([^;]+)/i.exec(ct);
  const charset = charsetMatch?.[1]?.trim().toLowerCase() ?? 'utf-8';
  try {
    return new TextDecoder(charset, { fatal: false }).decode(bytes);
  } catch {
    return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  }
}

/* =====================================================================
 * Tool: extract_text
 * ===================================================================== */

/**
 * Strip HTML tags (including script and style content), decode a small
 * set of named + numeric entities, collapse whitespace, and cap the
 * output. Pure function, no I/O.
 */
export function extractTextFromHtml(html: string): string {
  if (typeof html !== 'string') {
    throw new Error('extract_text: html must be a string');
  }
  // Drop <script>...</script> and <style>...</style> wholesale (not
  // just the tags) so the LLM never sees inline JS / CSS bodies.
  let s = html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ');
  s = s.replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ');
  s = s.replace(/<!--[\s\S]*?-->/g, ' ');
  // Strip remaining tags.
  s = s.replace(/<[^>]+>/g, ' ');
  // Decode the handful of entities that meaningfully change reading.
  s = s
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_m, code: string) => {
      const n = Number(code);
      return Number.isFinite(n) && n >= 32 && n <= 0x10ffff ? String.fromCodePoint(n) : ' ';
    });
  // Collapse whitespace.
  s = s.replace(/\s+/g, ' ').trim();
  if (s.length > EXTRACT_TEXT_MAX_BYTES) {
    s = s.slice(0, EXTRACT_TEXT_MAX_BYTES);
  }
  return s;
}

/* =====================================================================
 * Tool: rss_fetch
 * ===================================================================== */

export interface RssItem {
  readonly title: string;
  readonly link: string;
  readonly pubDate: string;
  readonly summary: string;
}

/**
 * Tiny inline RSS / Atom parser. Intentionally regex / string-ops
 * based — adding a heavy XML / feed dep on the agent-pod hot path
 * costs more than it saves, and we don't need the full XML grammar
 * to extract `{title, link, pubDate, summary}` from well-formed feeds.
 *
 * Throws on input that has neither `<rss` / `<feed` nor any
 * `<item>` / `<entry>` elements — the LLM gets a clear error rather
 * than an empty array on a 200-but-not-feed response (e.g. captcha
 * page, login redirect that landed back at the same host).
 */
export function parseFeed(body: string): RssItem[] {
  if (typeof body !== 'string' || body.length === 0) {
    throw new Error('rss_fetch: response body is empty');
  }
  const looksLikeRss = /<rss\b/i.test(body) || /<channel\b/i.test(body);
  const looksLikeAtom = /<feed\b/i.test(body);
  if (!looksLikeRss && !looksLikeAtom) {
    throw new Error('rss_fetch: response is not a valid RSS or Atom feed');
  }

  const items: RssItem[] = [];
  const itemRe = /<item\b[^>]*>([\s\S]*?)<\/item>/gi;
  const entryRe = /<entry\b[^>]*>([\s\S]*?)<\/entry>/gi;
  for (const match of body.matchAll(itemRe)) {
    items.push(parseFeedItem(match[1] ?? '', 'rss'));
  }
  for (const match of body.matchAll(entryRe)) {
    items.push(parseFeedItem(match[1] ?? '', 'atom'));
  }

  if (items.length === 0) {
    throw new Error('rss_fetch: feed contained no items');
  }
  return items;
}

function parseFeedItem(inner: string, kind: 'rss' | 'atom'): RssItem {
  const title = pickText(inner, 'title') ?? '';
  const pubDate =
    pickText(inner, 'pubDate') ??
    pickText(inner, 'published') ??
    pickText(inner, 'updated') ??
    pickText(inner, 'dc:date') ??
    '';
  const summary =
    pickText(inner, 'description') ??
    pickText(inner, 'summary') ??
    pickText(inner, 'content') ??
    '';
  let link = '';
  if (kind === 'atom') {
    // Prefer <link href="..."/> (Atom). Fall back to text-content.
    const hrefMatch = /<link\b[^>]*href=["']([^"']+)["']/i.exec(inner);
    link = hrefMatch?.[1] ?? pickText(inner, 'link') ?? '';
  } else {
    link = pickText(inner, 'link') ?? '';
  }
  return {
    title: cleanFeedField(title),
    link: cleanFeedField(link),
    pubDate: cleanFeedField(pubDate),
    summary: cleanFeedField(summary),
  };
}

function pickText(xml: string, tag: string): string | undefined {
  // Tag may have attributes; capture inner content. Non-greedy match
  // stops at the first matching close tag. We do NOT try to handle
  // nested same-name tags — RSS / Atom don't nest item-level fields.
  const re = new RegExp(`<${escapeRegExp(tag)}\\b[^>]*>([\\s\\S]*?)<\\/${escapeRegExp(tag)}>`, 'i');
  const m = re.exec(xml);
  if (m === null) return undefined;
  return m[1];
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function cleanFeedField(raw: string): string {
  // Strip CDATA wrappers, then strip any HTML tags inside the value,
  // then decode the small entity set we care about.
  let s = raw.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1');
  s = s.replace(/<[^>]+>/g, ' ');
  s = s
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&apos;/gi, "'");
  return s.replace(/\s+/g, ' ').trim();
}

/* =====================================================================
 * Tool definitions + registry
 * ===================================================================== */

interface BuildOpts {
  /** Override the env source — primarily for tests. Defaults to `process.env`. */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** Override the fetch impl — primarily for tests. Defaults to global `fetch`. */
  readonly fetch?: typeof fetch;
  /**
   * Override the DNS resolver — primarily for tests so the SSRF
   * post-resolve check can be exercised without going to real DNS.
   * Defaults to Node's `dns.promises.lookup`.
   */
  readonly lookup?: LookupFn;
  /**
   * Override the artifact writer — primarily for tests so we can assert
   * on the produced ArtifactRef without booting a real PVC mount.
   * Defaults to `writeArtifactToDisk`.
   */
  readonly writeArtifact?: typeof writeArtifactToDisk;
  /**
   * Override the clock used by `write_artifact`'s `producedAt` field.
   * Defaults to `() => new Date()`.
   */
  readonly now?: () => Date;
  /**
   * Names served by other providers in the same run (e.g. WS-K
   * substrate `spawn_child_task`/`wait_*`, blackboard tools, events
   * tools). When `Agent.spec.tools` lists one of these, the resolver
   * accepts it as known and silently skips it — letting the runner's
   * separate provider serve it. Defaults to an empty set, which
   * preserves the strict "unknown built-in tool" guard for typos.
   */
  readonly externallyProvidedNames?: ReadonlySet<string>;
  /**
   * In-pod registry — accepts ArtifactRefs as `write_artifact` produces
   * them. The runner threads ONE registry through the entire run; the
   * status patcher reads `registry.snapshot()` on every status update
   * (terminal AND any intermediate path) so even a cancelled/timeout
   * task surfaces the artifacts that did land. Optional: when undefined,
   * registry-flush is skipped and the trace-collator path remains
   * authoritative (back-compat for tests that don't construct a
   * registry).
   */
  readonly artifactRegistry?: ArtifactRegistry;
}

/**
 * Build the registry of in-process tool definitions, parameterized over
 * env (for the allowlist) and `fetch` (for tests). Returns a `Map` keyed
 * by tool name so the runner can look names up against `Agent.spec.tools`
 * with O(1) lookup AND get a clean `unknown tool` error for misses.
 */
export function buildBuiltinToolRegistry(
  opts: BuildOpts = {},
): ReadonlyMap<string, InProcessToolDefinition> {
  const env = opts.env ?? process.env;
  const allowed = parseAllowedDomains(env[ENV_ALLOW_DOMAINS]);
  const fetchEnv: FetchEnv = {
    allowed,
    ...(opts.fetch !== undefined && { fetch: opts.fetch }),
    ...(opts.lookup !== undefined && { lookup: opts.lookup }),
  };

  const httpGet = defineInProcessTool({
    name: 'http_get',
    description:
      'HTTP GET a URL on the operator-configured allowlist. Returns ' +
      '{status, headers, body, truncated, finalUrl}. Refuses non-allowlisted ' +
      'domains, private/loopback IPs, and non-http(s) schemes.',
    inputSchema: {
      type: 'object',
      required: ['url'],
      properties: {
        url: { type: 'string', format: 'uri' },
      },
      additionalProperties: false,
    },
    tags: ['read-only', 'network'],
    handler: async (args, ctx) => {
      const url = requireStringArg(args, 'url');
      const result = await safeFetch(url, fetchEnv, ctx);
      const body = decodeBody(result.bodyBytes, result.headers);
      return jsonContent({
        status: result.status,
        headers: result.headers,
        body,
        truncated: result.truncated,
        finalUrl: result.finalUrl,
      });
    },
  });

  const rssFetch = defineInProcessTool({
    name: 'rss_fetch',
    description:
      'Fetch an RSS or Atom feed from the operator-configured allowlist and ' +
      'return parsed items as [{title, link, pubDate, summary}]. Same SSRF / ' +
      'allowlist rules as http_get. Throws on non-feed responses.',
    inputSchema: {
      type: 'object',
      required: ['url'],
      properties: {
        url: { type: 'string', format: 'uri' },
      },
      additionalProperties: false,
    },
    tags: ['read-only', 'network'],
    handler: async (args, ctx) => {
      const url = requireStringArg(args, 'url');
      const result = await safeFetch(url, fetchEnv, ctx);
      if (result.status >= 400) {
        throw new Error(`rss_fetch: upstream returned status ${result.status}`);
      }
      const body = decodeBody(result.bodyBytes, result.headers);
      const items = parseFeed(body);
      return jsonContent(items);
    },
  });

  const extractText = defineInProcessTool({
    name: 'extract_text',
    description:
      'Strip HTML tags + entities, collapse whitespace, return plain text ' +
      `(capped at ${EXTRACT_TEXT_MAX_BYTES} bytes). Pure; no I/O.`,
    inputSchema: {
      type: 'object',
      required: ['html'],
      properties: {
        html: { type: 'string' },
      },
      additionalProperties: false,
    },
    tags: ['read-only', 'pure'],
    handler: (args) => {
      const html = requireStringArg(args, 'html');
      return extractTextFromHtml(html);
    },
  });

  // P3 — write_artifact. Persists outputs to a PVC mount and emits an
  // ArtifactRef the runner forwards into RunResult.artifacts (which the
  // operator's status patch threads into AgentTask.status.artifacts).
  //
  // env knobs (resolved per call so a test can override either):
  //   - KAGENT_ARTIFACTS_DIR        (operator-injected; required to enable)
  //   - KAGENT_ARTIFACT_PVC_NAME    (operator-injected; required to enable)
  //   - KAGENT_ARTIFACT_MAX_BYTES   (default 25 MiB)
  //   - KAGENT_TASK_ID              (required; the operator already injects)
  //
  // When EITHER of the artifact env vars is unset, the tool refuses with
  // `tool_error: write_artifact: artifact storage is disabled (...)` so
  // the LLM gets a clean failure rather than a write to an unmounted
  // path. Mirrors the Helm chart's default-OFF posture.
  const writer = opts.writeArtifact ?? writeArtifactToDisk;
  const clock = opts.now ?? ((): Date => new Date());
  const registry = opts.artifactRegistry;
  const writeArtifact = defineInProcessTool({
    name: 'write_artifact',
    description:
      'Persist a UTF-8 string OR base64-encoded bytes to the per-task ' +
      'PVC mount and return an ArtifactRef ({uri, name, mediaType, ' +
      'sizeBytes, checksum, contentHash, producedAt}). The operator ' +
      'forwards refs into AgentTask.status.artifacts. Names must be ' +
      'relative (no leading "/" or ".." segments) and must not contain ' +
      'control characters. Pass `content` as a UTF-8 string for text ' +
      'payloads or as `{base64: "..."}` for binary payloads. When ' +
      '`inline` is true and the content is small + textual, the tool ' +
      'returns a synthetic ref WITHOUT touching the filesystem so the ' +
      'caller can embed the content directly in status.result.content. ' +
      'Refuses writes that exceed the operator-configured ' +
      'KAGENT_ARTIFACT_MAX_BYTES cap (default 25 MiB).',
    inputSchema: {
      type: 'object',
      required: ['name', 'content'],
      properties: {
        name: { type: 'string' },
        mediaType: { type: 'string' },
        // `content` is one-of: a UTF-8 string, OR an object with a
        // base64 field. The runtime handler enforces the discriminant —
        // JSON Schema's `oneOf` would complicate the inputSchema for
        // older LLM tool-calling shims.
        content: {},
        inline: { type: 'boolean' },
      },
      additionalProperties: false,
    },
    tags: ['write', 'artifacts'],
    handler: (args) => {
      const name = requireStringArg(args, 'name');
      // mediaType is OPTIONAL (per the user-facing spec); fall back to
      // application/octet-stream so the writer's strict mediaType check
      // never trips on a caller that omitted it. Text-mode inline-safe
      // detection is gated on `text/...` so omitting mediaType means
      // bytes go to disk — exactly the right default for binary blobs.
      const rawMediaType = args.mediaType;
      const mediaType =
        typeof rawMediaType === 'string' && rawMediaType.length > 0
          ? rawMediaType
          : 'application/octet-stream';
      const decoded = decodeWriteArtifactContent(args.content);
      const inline = args.inline === true;

      // Resolve env strictly: when the operator did not stamp the PVC
      // env vars, refuse with a `disabled` error rather than writing to
      // an unmounted path (which would silently land bytes on the
      // ephemeral container FS). The reason carries the env var name +
      // a Helm-values pointer so operators can self-service the fix.
      const resolved = resolveWriterEnvOrDisabled(env);
      if ('disabled' in resolved) {
        // Inline path is still admissible — it doesn't touch the FS,
        // and the substrate contract for `inline://` is "bytes live in
        // status.result.content" (not durable on PVC). So we permit
        // the inline short-circuit even when the PVC isn't wired.
        if (inline && decoded.kind === 'text' && inlineSafeForArtifact(decoded.text, mediaType)) {
          validateArtifactName(name);
          const synthetic = inlineArtifactRef(decoded.text, mediaType, clock());
          if (registry !== undefined) {
            registry.add({ ...synthetic, name });
          }
          return jsonContent({ ...synthetic, name });
        }
        throw new Error(
          `tool_error: write_artifact: artifact storage is disabled (${resolved.reason})`,
        );
      }

      // Inline short-circuit: when the caller asks for inline AND the
      // payload qualifies, skip the FS round-trip and return a synthetic
      // ref under the `inline://sha256:<hex>` scheme. Substrate contract:
      //   `pvc://`    ⟹ bytes ARE durably on disk (followable)
      //   `inline://` ⟹ bytes are NOT persisted (caller must inline)
      // Inline is text-only — base64-encoded binary payloads always
      // round-trip through the disk writer.
      if (inline && decoded.kind === 'text' && inlineSafeForArtifact(decoded.text, mediaType)) {
        validateArtifactName(name);
        const synthetic = inlineArtifactRef(decoded.text, mediaType, clock());
        if (registry !== undefined) {
          registry.add({ ...synthetic, name });
        }
        return jsonContent({ ...synthetic, name });
      }

      // Disk path — text content goes through verbatim, bytes are
      // forwarded as-is to the writer's Buffer/Uint8Array overload.
      const writerInput: string | Buffer = decoded.kind === 'text' ? decoded.text : decoded.bytes;
      const result = writer(name, writerInput, mediaType, resolved, clock());
      // Push into the registry BEFORE returning so a downstream
      // truncation of the tool output (trace pipeline) does not lose
      // the ref — the registry is the authoritative source for the
      // status patcher. last-write-wins on duplicate URIs.
      if (registry !== undefined) {
        registry.add(result.ref);
      }
      return jsonContent(result.ref);
    },
  });

  return new Map<string, InProcessToolDefinition>([
    [httpGet.name, httpGet],
    [rssFetch.name, rssFetch],
    [extractText.name, extractText],
    [writeArtifact.name, writeArtifact],
  ]);
}

function requireStringArg(args: Record<string, unknown>, key: string): string {
  const v = args[key];
  if (typeof v !== 'string' || v.length === 0) {
    throw new Error(`missing or empty required string argument "${key}"`);
  }
  return v;
}

/* =====================================================================
 * write_artifact — content discriminator helper.
 *
 * `args.content` is one-of:
 *   - a UTF-8 string (text payloads, including the empty string)
 *   - an object `{ base64: "<padded-or-unpadded>" }` (binary payloads)
 *
 * Anything else throws. Strict base64 decode (no whitespace, RFC 4648
 * alphabet only — `Buffer.from(s, 'base64')` is permissive enough for
 * minor padding variations the LLM might emit).
 * ===================================================================== */

type DecodedContent =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'bytes'; readonly bytes: Buffer };

const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/;

function decodeWriteArtifactContent(raw: unknown): DecodedContent {
  if (typeof raw === 'string') {
    return { kind: 'text', text: raw };
  }
  if (typeof raw === 'object' && raw !== null && 'base64' in raw) {
    const b64 = (raw as { base64?: unknown }).base64;
    if (typeof b64 !== 'string') {
      throw new Error('missing or wrong-type required string argument "content.base64"');
    }
    // Strip surrounding whitespace once (some LLMs add a trailing newline);
    // anything else fails the strict regex below.
    const trimmed = b64.trim();
    if (!BASE64_RE.test(trimmed)) {
      throw new Error('tool_error: write_artifact: "content.base64" is not valid base64');
    }
    const bytes = Buffer.from(trimmed, 'base64');
    // Round-trip sanity check: re-encoding must reproduce the input
    // (modulo padding) — guards against silently truncated input where
    // `Buffer.from(...,'base64')` drops bytes after a malformed character.
    const reencoded = bytes.toString('base64');
    const normalizedInput = trimmed.replace(/=+$/, '');
    const normalizedReencoded = reencoded.replace(/=+$/, '');
    if (normalizedInput !== normalizedReencoded) {
      throw new Error('tool_error: write_artifact: "content.base64" decode round-trip mismatch');
    }
    return { kind: 'bytes', bytes };
  }
  throw new Error(
    'missing or wrong-type required argument "content" (must be a string or { base64: string })',
  );
}

function jsonContent(value: unknown): ContentBlock[] {
  return [{ type: 'text', text: JSON.stringify(value) }];
}

/* =====================================================================
 * Public helper — what the runner consumes
 * ===================================================================== */

/**
 * Resolve a `ReadonlyArray<string>` of tool names against the built-in
 * registry, returning a single `ToolProvider` exposing exactly those
 * tools. Throws on the FIRST unknown name with a clear message — fail
 * fast at boot rather than silently dropping the tool, per the
 * Platform-Priorities P2 spec.
 *
 * `names` of zero length returns `null` so the runner can pass nothing
 * to `AgentExecutor` and the loop runs in chat-only mode.
 *
 * `opts.externallyProvidedNames` lists tool names that are served by
 * OTHER providers in the same run (e.g. the WS-K substrate provider's
 * `spawn_child_task` / `wait_*` tools, blackboard tools, events tools).
 * Names in this set are accepted as known and silently skipped — they
 * don't get added to this provider's tool list, but they don't trip
 * the "unknown built-in" guard either. The runner is responsible for
 * appending the matching providers; missing those is a wiring bug,
 * not an Agent.spec.tools validation bug.
 */
export function resolveBuiltinTools(
  names: readonly string[] | undefined,
  opts: BuildOpts = {},
): ToolProvider | null {
  if (names === undefined || names.length === 0) return null;
  const registry = buildBuiltinToolRegistry(opts);
  const externallyProvided = opts.externallyProvidedNames ?? new Set<string>();
  const known = [...Array.from(registry.keys()), ...Array.from(externallyProvided)].sort();
  const definitions: InProcessToolDefinition[] = [];
  const seen = new Set<string>();
  for (const name of names) {
    if (seen.has(name)) continue;
    seen.add(name);
    if (externallyProvided.has(name)) continue;
    const def = registry.get(name);
    if (!def) {
      throw new Error(
        `unknown built-in tool "${name}" (known built-ins: ${known.join(', ')}). ` +
          `Edit Agent.spec.tools to drop the name, or extend ` +
          `packages/agent-pod/src/builtin-tools.ts to add it.`,
      );
    }
    definitions.push(def);
  }
  if (definitions.length === 0) return null;
  return new InProcessToolProvider({ id: 'builtin', tools: definitions });
}

/** Re-export for tests + the runner — keeps the surface importable from one place. */
export { InProcessToolProvider };

/* =====================================================================
 * v0.1.9 — get_my_context substrate introspection tool
 *
 * Lets an in-pod agent loop ask "who am I, where am I in the spawn
 * tree, what's left in my budget?" without round-tripping the operator
 * or making an LLM call. The tool is pure: reads only the parsed
 * PodConfig + a runner-supplied budget callback. No K8s API traffic,
 * no network. Mirrors the substrate-tool pattern of
 * `defineSpawnChildTask` (separate factory function vs. per-tool entry
 * in `buildBuiltinToolRegistry`) because the data sources are
 * per-task-instance, not global.
 *
 * Returned shape (JSON-encoded as the tool result):
 *   {
 *     taskUid:        string,
 *     taskName:       string,
 *     taskNamespace:  string,
 *     agentName:      string,
 *     parentUid?:     string,                 // present iff this task has a parent
 *     depth:          number,                 // 0 for root tasks
 *     budget: {
 *       tokensRemaining?:  number,            // from runConfig.tokenLimit
 *       secondsRemaining?: number,            // from optional callback
 *     },
 *   }
 *
 * The runner registers the tool inside the substrate-tools provider
 * alongside `spawn_child_task` / `wait_*` (see `main.ts`). When the
 * Agent spec declares `get_my_context` in its tool list, the executor
 * routes calls here.
 * ===================================================================== */

export interface GetMyContextDeps {
  /** Parsed pod env. Source of truth for taskUid / agentName / depth / parent. */
  readonly podConfig: import('./env.js').PodConfig;
  /**
   * Optional wall-clock budget callback. Returns the remaining seconds
   * until the parent's Job activeDeadlineSeconds fires (or undefined
   * when the task has no deadline). Identical contract to the
   * `remainingBudgetSeconds` opt on `defineSpawnChildTask`. main.ts
   * wires the same instance into both tools so they share an answer.
   */
  readonly remainingBudgetSeconds?: () => number | undefined;
  /**
   * v0.3.0-capabilities — Wave 2 Caps sub-team.
   *
   * Optional decoded `CapabilityBundle` (from
   * `@kagent/cap-consumer.loadCapabilityFromEnv`). When present,
   * `get_my_context` surfaces the relevant claims so the agent loop
   * can introspect "what authority do I have?" without re-parsing
   * the JWT itself.
   *
   * The full claims object is exposed (NOT the JWT) — the agent loop
   * never needs the raw token, and exposing it would be a footgun.
   */
  readonly capabilityBundle?: import('@kagent/capability-types').CapabilityBundle;
  /**
   * v0.1.9 piece 2 — live token-utilization snapshot. Returns
   * `{ used, modelWindow }` at tool-call time so the LLM observes the
   * cumulative input + output tokens against the model's context-window
   * cap (per docs/CONTEXT-AWARENESS.md §4.4).
   *
   * Snapshot semantics (the values mutate live on `RunBudget` between
   * iterations — a thunk lets the handler read them at the moment the
   * tool fires, not at construction time):
   *   - `used`: cumulativeInputTokens + cumulativeOutputTokens; always
   *     a number. Returns 0 before any LLM call has fired.
   *   - `modelWindow`: the model's declared window in tokens
   *     (KAGENT_AGENT_MODEL_CONTEXT_WINDOW resolved). `null` when the
   *     env is unset (back-compat).
   *
   * When the dep is omitted, the handler defaults to
   * `() => ({ used: 0, modelWindow: null })` so the tool's output
   * shape stays consistent with the §4.4 contract regardless of
   * wiring state. (The contract is "always present", not "present iff
   * dep is wired".)
   */
  readonly tokenUtilizationSnapshot?: () => {
    readonly used: number;
    readonly modelWindow: number | null;
  };
}

/**
 * Build the `get_my_context` tool definition. Returns an
 * `InProcessToolDefinition` the caller stitches into a
 * `ToolProvider` (or registers via the substrate-tools provider in
 * main.ts). Pure, synchronous handler; no I/O.
 */
export function defineGetMyContext(deps: GetMyContextDeps): InProcessToolDefinition {
  const { podConfig } = deps;
  return defineInProcessTool({
    name: 'get_my_context',
    description:
      "Return this task's identity (uid, name, namespace, agent), its " +
      'depth in the spawn tree (root = 0), its optional parent task UID, ' +
      'and the remaining budget (tokens, seconds) — without making an ' +
      'LLM call. Use this BEFORE spawning children to decide whether ' +
      'enough wall-clock or token budget remains to be useful.',
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
    tags: ['substrate', 'introspection', 'read-only'],
    handler: () => {
      const tokenLimit = podConfig.taskSpec.runConfig?.tokenLimit;
      const secondsRemaining = deps.remainingBudgetSeconds?.();
      const parentUid = podConfig.taskSpec.parentTask;
      // v0.1.9 piece 2 — live token-utilization snapshot per
      // docs/CONTEXT-AWARENESS.md §4.4. Read at tool-call time (NOT at
      // construction): the cumulative tokens are mutating live on
      // RunBudget between iterations, so a thunk-style dep is the only
      // way the LLM gets a fresh number when it asks. Defaults to
      // `{ used: 0, modelWindow: null }` so the field is always present
      // (back-compat: existing callers that haven't wired the snapshot
      // yet still get a well-formed payload).
      //
      // NH1 (audit-rev2 C2 §3) — `budget.tokensRemaining` is also
      // computed from this snapshot's `used` field. Both `tokenLimit`
      // (per-task user cap from `runConfig.tokenLimit`) and
      // `snapshot.used` (cumulative input + output tokens off RunBudget)
      // are the same currency; subtracting yields the actionable
      // "remaining capacity" the agent's prompt logic uses to decide
      // "should I hand off now?" Pre-fix, the handler reported the
      // ceiling itself (`tokensRemaining = tokenLimit`), so any prompt
      // logic like "if tokensRemaining < 5000, hand off" never
      // triggered.
      const snapshot = deps.tokenUtilizationSnapshot?.() ?? { used: 0, modelWindow: null };
      const budget: { tokensRemaining?: number; secondsRemaining?: number } = {};
      if (typeof tokenLimit === 'number' && tokenLimit > 0) {
        budget.tokensRemaining = Math.max(0, tokenLimit - snapshot.used);
      }
      if (typeof secondsRemaining === 'number' && Number.isFinite(secondsRemaining)) {
        budget.secondsRemaining = secondsRemaining;
      }
      const tokenUtilization: {
        used: number;
        modelWindow: number | null;
        percentage: number | null;
      } = {
        used: snapshot.used,
        modelWindow: snapshot.modelWindow,
        percentage:
          snapshot.modelWindow !== null && snapshot.modelWindow > 0
            ? // 4-decimal rounding per §4.4 example (12450/131072 → 0.0950).
              Math.round((snapshot.used / snapshot.modelWindow) * 10_000) / 10_000
            : null,
      };
      const ctx: {
        taskUid: string;
        taskName: string;
        taskNamespace: string;
        agentName: string;
        parentUid?: string;
        depth: number;
        budget: { tokensRemaining?: number; secondsRemaining?: number };
        tokenUtilization: {
          used: number;
          modelWindow: number | null;
          percentage: number | null;
        };
        capability?: {
          jti: string;
          expiresAt: number;
          tools?: readonly string[];
          spawn?: readonly string[];
          read?: readonly string[];
          write?: readonly string[];
          egress?: readonly string[];
          tenant?: string;
        };
      } = {
        taskUid: podConfig.taskId,
        taskName: podConfig.taskName,
        taskNamespace: podConfig.taskNamespace,
        agentName: podConfig.agentName,
        depth: podConfig.taskDepth,
        budget,
        tokenUtilization,
      };
      if (typeof parentUid === 'string' && parentUid.length > 0) {
        ctx.parentUid = parentUid;
      }
      // v0.3.0-capabilities — surface the relevant cap claims.
      const bundle = deps.capabilityBundle;
      if (bundle !== undefined) {
        const cap: NonNullable<typeof ctx.capability> = {
          jti: bundle.jti,
          expiresAt: bundle.exp,
          ...(bundle.claims.tools !== undefined && { tools: bundle.claims.tools }),
          ...(bundle.claims.spawn !== undefined && { spawn: bundle.claims.spawn }),
          ...(bundle.claims.read !== undefined && { read: bundle.claims.read }),
          ...(bundle.claims.write !== undefined && { write: bundle.claims.write }),
          ...(bundle.claims.egress !== undefined && { egress: bundle.claims.egress }),
          ...(bundle.claims.tenant !== undefined && { tenant: bundle.claims.tenant }),
        };
        ctx.capability = cap;
      }
      return jsonContent(ctx);
    },
  });
}

/* =====================================================================
 * v0.2.2-cas — read_artifact substrate tool
 *
 * Lets the in-pod agent loop fetch the bytes behind an `ArtifactRef.uri`
 * (typically passed in via `AgentTask.spec.inputs[]`). The tool is
 * capability-gated: the runner registers it ONLY when the Agent's spec
 * declares an artifact input or output (see `agentHasArtifactInputOrOutput`
 * in `env.ts`). Without that schema-level declaration the tool is absent
 * entirely from the registry — the LLM cannot call a tool it never sees.
 *
 * Wire pattern mirrors `defineSpawnChildTask` / `defineGetMyContext`:
 * a separate factory function (vs. an entry in `buildBuiltinToolRegistry`)
 * because the data source is per-task-instance — the CasBackend is
 * resolved at runner boot from `KAGENT_CAS_*` env, then injected here.
 *
 * Returned content shape:
 *   - `text/*` / `application/json` / `application/xml` payloads decode
 *     to a single `{ type: 'text', text: <utf-8> }` ContentBlock.
 *   - Anything else returns a single `{ type: 'text', text: <base64> }`
 *     ContentBlock with the body marked `base64Encoded: true` in the
 *     surrounding JSON envelope so the LLM unambiguously knows it's not
 *     human-readable.
 *
 * The tool accepts EITHER `uri` (canonical CAS URI; preferred) or
 * `hash` (bare sha256 hex; the runner recovers the URI under the agent's
 * known artifact namespace). Tests cover both code paths.
 * ===================================================================== */

const READ_ARTIFACT_MAX_BYTES = 8 * 1024 * 1024; // 8 MiB hard cap on returned bytes
const READ_ARTIFACT_TEXT_MEDIA_PREFIXES = ['text/', 'application/json', 'application/xml'];

/**
 * Heuristic — does this media type round-trip cleanly through a JSON
 * string? Anything else is base64-encoded for the LLM. Conservative:
 * we'd rather a downstream model see well-marked base64 than land on
 * mojibake from a charset mismatch.
 */
function isTextLikeMediaType(mediaType: string | undefined): boolean {
  if (typeof mediaType !== 'string') return false;
  const lc = mediaType.toLowerCase();
  for (const prefix of READ_ARTIFACT_TEXT_MEDIA_PREFIXES) {
    if (lc === prefix || lc.startsWith(prefix)) return true;
  }
  return false;
}

export interface ReadArtifactDeps {
  /**
   * The CAS backend instance the runner constructed at boot from
   * `KAGENT_CAS_*` env. Tests inject a fake backend that round-trips
   * a fixed Uint8Array.
   */
  readonly backend: CasBackend;
}

/**
 * Build the `read_artifact` tool definition. Capability gate (Agent
 * declares an artifact I/O) is the caller's responsibility — see
 * `agentHasArtifactInputOrOutput` in `env.ts`.
 */
export function defineReadArtifact(deps: ReadArtifactDeps): InProcessToolDefinition {
  const { backend } = deps;
  return defineInProcessTool({
    name: 'read_artifact',
    description:
      'Fetch the bytes behind an artifact URI (cas:// or pvc://). Verifies ' +
      'the sha256 hash post-fetch and refuses on mismatch (corruption / ' +
      'tampering / mid-write). Text-like media types round-trip as UTF-8 ' +
      'strings; binary payloads return base64-encoded bytes with ' +
      'base64Encoded: true. Capped at 8 MiB. Use this to read inputs ' +
      'declared on the AgentTask via spec.inputs[] of kind: artifact.',
    inputSchema: {
      type: 'object',
      properties: {
        uri: { type: 'string' },
        mediaType: { type: 'string' },
      },
      additionalProperties: false,
    },
    tags: ['substrate', 'artifacts', 'read-only'],
    handler: async (args) => {
      const uri = args.uri;
      if (typeof uri !== 'string' || uri.length === 0) {
        throw new Error('read_artifact: "uri" must be a non-empty string');
      }
      const bytes = await backend.read(uri);
      if (bytes.byteLength > READ_ARTIFACT_MAX_BYTES) {
        throw new Error(
          `read_artifact: payload exceeds ${String(READ_ARTIFACT_MAX_BYTES)} bytes ` +
            `(got ${String(bytes.byteLength)}); fetch via spec.inputs[] mountPath instead`,
        );
      }
      const mediaType = typeof args.mediaType === 'string' ? args.mediaType : undefined;
      if (isTextLikeMediaType(mediaType)) {
        const text = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
        return jsonContent({
          uri,
          mediaType: mediaType ?? 'text/plain',
          base64Encoded: false,
          sizeBytes: bytes.byteLength,
          content: text,
        });
      }
      const base64 = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString(
        'base64',
      );
      return jsonContent({
        uri,
        mediaType: mediaType ?? 'application/octet-stream',
        base64Encoded: true,
        sizeBytes: bytes.byteLength,
        content: base64,
      });
    },
  });
}

/* =====================================================================
 * Wave 3 — Blackboard
 *
 * Per-task-tree scratch KV on NATS JetStream. The operator provisions
 * one bucket per root AgentTask (`kagent-kv-<root-uid>`) at admission
 * and stamps `KAGENT_BLACKBOARD_BUCKET=<name>` on every spawned Job's
 * env. Children inherit the bucket via the env, so sibling agents
 * coordinate without having to discover each other.
 *
 * Four tools, all cap-gated by `CapabilityClaims.blackboard.{read,write}`:
 *
 *   - `read_blackboard({key})         → {value, revision} | null`
 *   - `write_blackboard({key, value}) → {revision}`            (last-writer-wins)
 *   - `list_blackboard({prefix?})     → {keys[]}`              (capped)
 *   - `append_blackboard({key, value})→ {revision, length}`    (CAS-loop)
 *
 * Wire pattern mirrors `defineSpawnChildTask` / `defineGetMyContext`:
 * a separate factory function (vs. an entry in
 * `buildBuiltinToolRegistry`) because the data sources are
 * per-task-instance — the BlackboardClient + cap claim are resolved at
 * runner boot from env + cap-bundle.
 *
 * Refusal taxonomy (mirrors `assertUrlIsSafe` in this file):
 *   - `policy_denied: <reason>` — cap claim doesn't admit the action.
 *     Surface to the LLM via the standard tool-error path.
 *   - `tool_error: blackboard not configured` — bucket env unset.
 *     Caller should drop the tool from Agent.spec.tools rather than
 *     calling it.
 *   - Other `Error` propagation — transport / size / revision-conflict
 *     bubble up via the in-process tool provider's catch-arm.
 *
 * Append CAS loop:
 *   1. Read current entry (revision R, value V).
 *   2. If absent: try create([new_value]). On RevisionMismatchError,
 *      restart the loop.
 *   3. If present: V must be an array (or convertible-to-array via
 *      single-element wrap when V is a scalar — fail-closed: refuse
 *      non-array existing values to keep the contract crisp).
 *   4. Splice value onto V; cas(R+1's slot via R) to publish.
 *   5. On RevisionMismatchError: restart loop. Hard cap on retries
 *      (5 by default) — beyond that, throw `tool_error: contended` so
 *      the agent loop sees a clear failure rather than spinning.
 * ===================================================================== */

import type { BlackboardClient } from '@kagent/blackboard';
import {
  RevisionMismatchError,
  checkAppendAllowed,
  checkListAllowed,
  checkReadAllowed,
  checkWriteAllowed,
  denyReasonToMessage,
  type BlackboardClaim,
} from '@kagent/blackboard';

/** Hard cap on append-CAS retries before we throw `tool_error: contended`. */
export const APPEND_BLACKBOARD_MAX_RETRIES = 5;

/** Hard cap on the per-call key length. NATS' subject-naming rules
 *  cap individual subject tokens at ~255 bytes; we are stricter so
 *  human-readable trace logs stay legible. */
export const BLACKBOARD_MAX_KEY_BYTES = 256;

/** Default `list_blackboard` cap when caller doesn't override. */
export const BLACKBOARD_LIST_DEFAULT_MAX = 1000;

/**
 * Inputs to the blackboard tool factory. The runner builds one of
 * these per task at boot when:
 *   - `KAGENT_BLACKBOARD_BUCKET` is set in env (operator stamped it)
 *   - The Agent declares any of the 4 blackboard tool names in
 *     `Agent.spec.tools`
 *
 * Cap claim: optional. When absent or shape-empty, every tool refuses
 * with `policy_denied: no blackboard capability claim — tool unavailable`,
 * matching the substrate's fail-closed posture for all cap-gated tools.
 */
export interface BlackboardToolDeps {
  readonly client: BlackboardClient;
  /**
   * `CapabilityClaims.blackboard` — the optional ACL nested object.
   * Tool wrappers consult the predicates in `@kagent/blackboard/acl`.
   * Undefined = no claim → all four tools refuse (fail-closed).
   */
  readonly claim?: BlackboardClaim | undefined;
  /**
   * Override the retry cap on append's CAS loop. Tests pin to 1 to
   * exercise the contended path deterministically.
   */
  readonly maxAppendRetries?: number;
}

/**
 * Build the four blackboard tools. Returns an array suitable for
 * registering inside the substrate-tools provider in main.ts.
 */
export function defineBlackboardTools(
  deps: BlackboardToolDeps,
): readonly InProcessToolDefinition[] {
  const { client } = deps;
  const claim = deps.claim;
  const maxRetries =
    typeof deps.maxAppendRetries === 'number' && deps.maxAppendRetries >= 0
      ? deps.maxAppendRetries
      : APPEND_BLACKBOARD_MAX_RETRIES;

  const validateKey = (key: string): void => {
    if (typeof key !== 'string' || key.length === 0) {
      throw new Error('blackboard: "key" must be a non-empty string');
    }
    // UTF-8 byte length — overlong keys explode subject names + KV
    // index size for marginal value.
    const byteLen = new TextEncoder().encode(key).byteLength;
    if (byteLen > BLACKBOARD_MAX_KEY_BYTES) {
      throw new Error(
        `blackboard: key length ${String(byteLen)} bytes exceeds max ${String(BLACKBOARD_MAX_KEY_BYTES)}`,
      );
    }
  };

  const readDef = defineInProcessTool({
    name: 'read_blackboard',
    description:
      'Read the latest value at a key on the task-tree blackboard. ' +
      'Returns {value, revision} or null when the key is absent or ' +
      'soft-deleted. Cap-gated by blackboard.read; refuses with ' +
      'policy_denied when the key is not in the read claim.',
    inputSchema: {
      type: 'object',
      required: ['key'],
      properties: {
        key: { type: 'string' },
      },
      additionalProperties: false,
    },
    tags: ['substrate', 'blackboard', 'read-only'],
    handler: async (args) => {
      const key = requireStringArg(args, 'key');
      validateKey(key);
      const deny = checkReadAllowed(claim, key);
      if (deny !== null) {
        throw new Error(`policy_denied: ${denyReasonToMessage(deny)} (key="${key}")`);
      }
      const entry = await client.read(key);
      return jsonContent(entry);
    },
  });

  const writeDef = defineInProcessTool({
    name: 'write_blackboard',
    description:
      'Last-writer-wins write to a key on the task-tree blackboard. ' +
      'Value must be JSON-serializable. Returns {revision}. Cap-gated ' +
      'by blackboard.write; refuses with policy_denied when the key ' +
      'is not in the write claim.',
    inputSchema: {
      type: 'object',
      required: ['key', 'value'],
      properties: {
        key: { type: 'string' },
        value: {},
      },
      additionalProperties: false,
    },
    tags: ['substrate', 'blackboard', 'write'],
    handler: async (args) => {
      const key = requireStringArg(args, 'key');
      validateKey(key);
      // `value` may legitimately be any JSON-serializable shape
      // (including `null` and `false`); we only refuse strict
      // `undefined` (impossible to receive from a JSON-decoded
      // tool-call args object, but defensive).
      if (!('value' in args)) {
        throw new Error('blackboard: "value" argument is required');
      }
      const deny = checkWriteAllowed(claim, key);
      if (deny !== null) {
        throw new Error(`policy_denied: ${denyReasonToMessage(deny)} (key="${key}")`);
      }
      const revision = await client.put(key, args.value);
      return jsonContent({ revision });
    },
  });

  const listDef = defineInProcessTool({
    name: 'list_blackboard',
    description:
      'List keys on the task-tree blackboard, optionally filtered by ' +
      'literal prefix. Returns {keys: string[]}. Capped at 1000 ' +
      'entries. Cap-gated by blackboard.read (listing is a read).',
    inputSchema: {
      type: 'object',
      properties: {
        prefix: { type: 'string' },
      },
      additionalProperties: false,
    },
    tags: ['substrate', 'blackboard', 'read-only'],
    handler: async (args) => {
      const deny = checkListAllowed(claim);
      if (deny !== null) {
        throw new Error(`policy_denied: ${denyReasonToMessage(deny)}`);
      }
      const prefix = typeof args.prefix === 'string' ? args.prefix : undefined;
      const keys = await client.list(prefix, BLACKBOARD_LIST_DEFAULT_MAX);
      return jsonContent({ keys });
    },
  });

  const appendDef = defineInProcessTool({
    name: 'append_blackboard',
    description:
      'CRDT-style append a single value onto a list-typed key on the ' +
      'task-tree blackboard. Concurrent appends converge via NATS KV ' +
      'compare-and-swap; the loop retries on revision conflict (max ' +
      `${String(maxRetries)}). Returns {revision, length}. Cap-gated by ` +
      'BOTH blackboard.read AND blackboard.write (CAS-loop reads + writes).',
    inputSchema: {
      type: 'object',
      required: ['key', 'value'],
      properties: {
        key: { type: 'string' },
        value: {},
      },
      additionalProperties: false,
    },
    tags: ['substrate', 'blackboard', 'write'],
    handler: async (args) => {
      const key = requireStringArg(args, 'key');
      validateKey(key);
      if (!('value' in args)) {
        throw new Error('blackboard: "value" argument is required');
      }
      const deny = checkAppendAllowed(claim, key);
      if (deny !== null) {
        throw new Error(`policy_denied: ${denyReasonToMessage(deny)} (key="${key}")`);
      }
      const newItem: unknown = args.value;
      let attempt = 0;
      // Bounded retry: read-splice-CAS-PUT loop. Caller sees a clear
      // `tool_error: contended` after `maxRetries` failed CAS attempts
      // rather than the loop spinning forever.
      while (attempt <= maxRetries) {
        attempt++;
        const entry = await client.read(key);
        if (entry === null) {
          // Seed with [newItem] via create (refuses on race with
          // another writer; we catch + restart).
          try {
            const revision = await client.create(key, [newItem]);
            return jsonContent({ revision, length: 1 });
          } catch (err) {
            if (err instanceof RevisionMismatchError) {
              continue; // someone else seeded — re-read + splice
            }
            throw err;
          }
        }
        // Existing value MUST be an array. We refuse to silently coerce
        // (e.g. wrap a scalar) — append is a typed operation, the
        // caller should `write_blackboard` first to install the array.
        if (!Array.isArray(entry.value)) {
          throw new Error(
            `tool_error: append_blackboard: existing value at "${key}" is not an array (got ${typeof entry.value})`,
          );
        }
        // entry.value is `unknown` from BlackboardEntry; the
        // `Array.isArray` narrow above guarantees an array but the
        // type system widens to `any[]`. Re-cast through the explicit
        // `unknown[]` so the spread doesn't propagate `any`.
        const existingArray = entry.value as readonly unknown[];
        const next: unknown[] = [...existingArray, newItem];
        try {
          const revision = await client.cas(key, next, entry.revision);
          return jsonContent({ revision, length: next.length });
        } catch (err) {
          if (err instanceof RevisionMismatchError) {
            continue; // re-read + splice on the next iteration
          }
          throw err;
        }
      }
      throw new Error(
        `tool_error: append_blackboard: gave up after ${String(maxRetries)} CAS retries on "${key}"`,
      );
    },
  });

  return [readDef, writeDef, listDef, appendDef];
}
