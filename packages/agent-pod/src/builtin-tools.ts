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
 *      RFC1918 / multicast / 0.0.0.0 destinations. This is the SSRF backstop
 *      against an LLM picking `http://10.0.0.1.allowed.example.com` or a
 *      friendly redirect chain.
 *   3. Redirects are followed manually (`redirect: 'manual'`) and re-checked
 *      against the same allowlist + SSRF rules; up to 5 hops.
 *   4. Bodies are truncated to 1MB to bound trace cost. Headers exposed to
 *      the LLM are an allowlist (`content-type`, `etag`, `last-modified`).
 *   5. `write_artifact` writes ONLY under `<KAGENT_ARTIFACTS_DIR>/<task-uid>/`,
 *      refuses path traversal (`..`, leading slash, non-printable chars), and
 *      writes atomically (`<name>.tmp` then rename). No subprocess, no
 *      `eval`, no shell-out anywhere in this file.
 */

import type { ContentBlock, ToolInvocationContext, ToolProvider } from '@kagent/agent-loop';
import { defineInProcessTool, InProcessToolProvider } from '@kagent/in-process-tool-provider';
import type { InProcessToolDefinition } from '@kagent/in-process-tool-provider';

import {
  buildPvcUri,
  inlineSafeForArtifact,
  resolveWriterEnv,
  writeArtifactToDisk,
  type ArtifactRef,
} from './artifacts.js';

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
 * HTTP fetch with manual redirect handling
 * ===================================================================== */

interface FetchEnv {
  readonly allowed: ReadonlySet<string>;
  readonly fetch?: typeof fetch;
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
  let target = assertUrlIsSafe(initialUrl, env.allowed);

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
  const fetchEnv: FetchEnv = { allowed, ...(opts.fetch !== undefined && { fetch: opts.fetch }) };

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
      // ref. Callers that prefer the inline-content-in-status path can
      // see `inlineSafe: true` on the metadata and act accordingly.
      if (inline && inlineSafeForArtifact(content, mediaType)) {
        const synthetic: ArtifactRef = {
          uri: buildPvcUri(writerEnv.pvcName, writerEnv.taskUid, name),
          name,
          mediaType,
          sizeBytes: Buffer.byteLength(content, 'utf8'),
          producedAt: clock().toISOString(),
        };
        return jsonContent(synthetic);
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
