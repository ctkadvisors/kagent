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
  resolveWriterEnv,
  validateArtifactName,
  writeArtifactToDisk,
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
  //   - KAGENT_ARTIFACTS_DIR    (default: /var/kagent/artifacts)
  //   - KAGENT_ARTIFACT_PVC_NAME (default: kagent-artifacts)
  //   - KAGENT_TASK_ID          (required; the operator already injects)
  const writer = opts.writeArtifact ?? writeArtifactToDisk;
  const clock = opts.now ?? ((): Date => new Date());
  const writeArtifact = defineInProcessTool({
    name: 'write_artifact',
    description:
      'Persist a UTF-8 string to the per-task PVC mount and return an ' +
      'ArtifactRef ({uri, name, mediaType, sizeBytes, checksum, producedAt}). ' +
      'The operator forwards refs into AgentTask.status.artifacts. Names ' +
      'must be relative (no leading "/" or ".." segments) and must not ' +
      'contain control characters. When `inline` is true and the content ' +
      'is small + textual, the tool returns a synthetic ref WITHOUT ' +
      'touching the filesystem so the caller can choose to embed the ' +
      'content directly in status.result.content instead.',
    inputSchema: {
      type: 'object',
      required: ['name', 'mediaType', 'content'],
      properties: {
        name: { type: 'string' },
        mediaType: { type: 'string' },
        content: { type: 'string' },
        inline: { type: 'boolean' },
      },
      additionalProperties: false,
    },
    tags: ['write', 'artifacts'],
    handler: (args) => {
      const name = requireStringArg(args, 'name');
      const mediaType = requireStringArg(args, 'mediaType');
      const content = requireStringArgAllowEmpty(args, 'content');
      const inline = args.inline === true;
      const writerEnv = resolveWriterEnv(env);
      // Inline short-circuit: when the caller asks for inline AND the
      // payload qualifies, skip the FS round-trip and return a synthetic
      // ref under the `inline://sha256:<hex>` scheme. The previous
      // implementation returned a `pvc://...` URI from this branch
      // even though no bytes were written — which lied to anyone who
      // tried to follow the URI later. The substrate contract is now:
      //   `pvc://`    ⟹ bytes ARE durably on disk (followable)
      //   `inline://` ⟹ bytes are NOT persisted (caller must inline)
      // The runner's `collectArtifactsFromTraces` drops `inline://`
      // refs from `RunResult.artifacts` so durable consumers don't see
      // them.
      //
      // The name validation runs only as a sanity check — the inline
      // ref does not embed `name` in its URI (the URI is content-
      // addressed via the sha256 hex), but we still want to refuse
      // path-traversal early so the same input is not subsequently
      // accepted by the disk writer if the LLM retries without
      // `inline:true`.
      if (inline && inlineSafeForArtifact(content, mediaType)) {
        validateArtifactName(name);
        const synthetic = inlineArtifactRef(content, mediaType, clock());
        return jsonContent({ ...synthetic, name });
      }
      const result = writer(name, content, mediaType, writerEnv, clock());
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

/**
 * Like `requireStringArg` but allows the empty string. `write_artifact`
 * legitimately accepts a 0-byte payload (e.g. a sentinel marker file)
 * so we cannot reject `''` at the arg-parsing layer.
 */
function requireStringArgAllowEmpty(args: Record<string, unknown>, key: string): string {
  const v = args[key];
  if (typeof v !== 'string') {
    throw new Error(`missing or wrong-type required string argument "${key}"`);
  }
  return v;
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
 */
export function resolveBuiltinTools(
  names: readonly string[] | undefined,
  opts: BuildOpts = {},
): ToolProvider | null {
  if (names === undefined || names.length === 0) return null;
  const registry = buildBuiltinToolRegistry(opts);
  const known = Array.from(registry.keys()).sort();
  const definitions: InProcessToolDefinition[] = [];
  const seen = new Set<string>();
  for (const name of names) {
    if (seen.has(name)) continue;
    seen.add(name);
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
      const budget: { tokensRemaining?: number; secondsRemaining?: number } = {};
      if (typeof tokenLimit === 'number' && tokenLimit > 0) {
        budget.tokensRemaining = tokenLimit;
      }
      if (typeof secondsRemaining === 'number' && Number.isFinite(secondsRemaining)) {
        budget.secondsRemaining = secondsRemaining;
      }
      const ctx: {
        taskUid: string;
        taskName: string;
        taskNamespace: string;
        agentName: string;
        parentUid?: string;
        depth: number;
        budget: { tokensRemaining?: number; secondsRemaining?: number };
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
