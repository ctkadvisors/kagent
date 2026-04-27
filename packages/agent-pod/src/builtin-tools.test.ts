/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/**
 * Behavioral tests for the agent-pod's built-in tool bundle.
 *
 * Coverage targets per the P2 task brief:
 *   - happy path for each of {http_get, rss_fetch, extract_text}
 *   - refusal paths: domain-not-allowed, SSRF, redirect-to-bad-host,
 *     malformed input
 *   - SSRF unit tests on the host-literal classifier
 *   - resolveBuiltinTools wiring (unknown name → throw)
 */

import type { ToolCall, ToolInvocationContext, ToolResult } from '@kagent/agent-loop';
import { InProcessToolProvider } from '@kagent/in-process-tool-provider';
import { describe, expect, it } from 'vitest';

import {
  assertHostResolvesPublicly,
  assertUrlIsSafe,
  buildBuiltinToolRegistry,
  ENV_ALLOW_DOMAINS,
  EXTRACT_TEXT_MAX_BYTES,
  extractTextFromHtml,
  isHostAllowed,
  type LookupFn,
  parseAllowedDomains,
  parseFeed,
  resolveBuiltinTools,
} from './builtin-tools.js';

/**
 * Stub DNS lookup — returns a hard-coded public IPv4 for any hostname.
 * Replaces real `dns.promises.lookup` so http_get/rss_fetch tests
 * exercise the allowlist + redirect logic without going to live DNS.
 * Tests that need to assert the DNS-rebinding rejection path build a
 * separate stub inline.
 */
const publicLookup: LookupFn = () => Promise.resolve([{ address: '93.184.216.34', family: 4 }]);

const ctx = (signal?: AbortSignal): ToolInvocationContext => ({
  runId: 'test-run',
  abortSignal: signal ?? new AbortController().signal,
});

const call = (name: string, args: Record<string, unknown> = {}): ToolCall => ({
  id: 'c1',
  name,
  args,
});

/**
 * Tiny stub `fetch` impl with a routing table — keyed on `url.toString()`.
 * Unknown URLs throw so the test fails loudly rather than silently sending
 * a real request.
 */
function stubFetch(routes: Record<string, () => Response>): typeof fetch {
  const impl: typeof fetch = (input) => {
    const url =
      input instanceof URL
        ? input.toString()
        : input instanceof Request
          ? input.url
          : String(input);
    const handler = routes[url];
    if (!handler) {
      throw new Error(`stubFetch: no route registered for ${url}`);
    }
    return Promise.resolve(handler());
  };
  return impl;
}

/** Coerce a ToolResult.content to a string for refusal-message assertions. */
function contentString(r: ToolResult): string {
  if (typeof r.content === 'string') return r.content;
  return JSON.stringify(r.content);
}

/* =====================================================================
 * parseAllowedDomains + isHostAllowed
 * ===================================================================== */

describe('parseAllowedDomains', () => {
  it('returns empty set when env var is unset', () => {
    expect(parseAllowedDomains(undefined).size).toBe(0);
  });

  it('returns empty set when env var is empty string', () => {
    expect(parseAllowedDomains('').size).toBe(0);
  });

  it('parses comma-separated, trimmed, lowercased entries', () => {
    const got = parseAllowedDomains(' Example.COM , arxiv.org ,, blog.cloudflare.com ');
    expect(Array.from(got).sort()).toEqual(['arxiv.org', 'blog.cloudflare.com', 'example.com']);
  });
});

describe('isHostAllowed', () => {
  const allowed = parseAllowedDomains('arxiv.org,blog.cloudflare.com');

  it('matches exact hostname', () => {
    expect(isHostAllowed('arxiv.org', allowed)).toBe(true);
  });

  it('matches sub-domains of allowlisted entries', () => {
    expect(isHostAllowed('xxx.arxiv.org', allowed)).toBe(true);
    expect(isHostAllowed('a.b.blog.cloudflare.com', allowed)).toBe(true);
  });

  it('refuses non-allowlisted hosts', () => {
    expect(isHostAllowed('cloudflare.com', allowed)).toBe(false); // parent != child suffix
    expect(isHostAllowed('arxiv.org.evil.com', allowed)).toBe(false);
    expect(isHostAllowed('blog-cloudflare.com', allowed)).toBe(false);
  });

  it('matches case-insensitively', () => {
    expect(isHostAllowed('ARXIV.ORG', allowed)).toBe(true);
  });
});

/* =====================================================================
 * SSRF guard (assertUrlIsSafe)
 * ===================================================================== */

describe('assertUrlIsSafe — SSRF + allowlist', () => {
  const allowed = parseAllowedDomains('example.com,1.1.1.1');

  it('accepts an allowlisted public host over https', () => {
    expect(() => assertUrlIsSafe('https://example.com/foo', allowed)).not.toThrow();
  });

  it('rejects malformed URLs with policy_denied', () => {
    expect(() => assertUrlIsSafe('not a url', allowed)).toThrow(/policy_denied: malformed URL/);
  });

  it('rejects non-http(s) schemes', () => {
    expect(() => assertUrlIsSafe('file:///etc/passwd', allowed)).toThrow(
      /policy_denied: only http\(s\) URLs/,
    );
    expect(() => assertUrlIsSafe('ftp://example.com/x', allowed)).toThrow(
      /policy_denied: only http\(s\)/,
    );
  });

  it('rejects unallowed domains', () => {
    expect(() => assertUrlIsSafe('https://evil.com/x', allowed)).toThrow(
      /policy_denied: domain "evil.com" is not in the allowlist/,
    );
  });

  it('rejects 127.0.0.0/8 loopback', () => {
    expect(() => assertUrlIsSafe('http://127.0.0.1/x', allowed)).toThrow(
      /policy_denied: host "127\.0\.0\.1" resolves to a private/,
    );
    expect(() => assertUrlIsSafe('http://127.99.99.99/', allowed)).toThrow(/private/);
  });

  it('rejects 10/8, 172.16/12, 192.168/16 RFC1918', () => {
    expect(() => assertUrlIsSafe('http://10.0.0.1/', allowed)).toThrow(/private/);
    expect(() => assertUrlIsSafe('http://172.16.5.5/', allowed)).toThrow(/private/);
    expect(() => assertUrlIsSafe('http://172.31.0.1/', allowed)).toThrow(/private/);
    expect(() => assertUrlIsSafe('http://192.168.1.1/', allowed)).toThrow(/private/);
  });

  it('rejects 169.254.0.0/16 link-local (cloud metadata service)', () => {
    expect(() => assertUrlIsSafe('http://169.254.169.254/latest/meta-data/', allowed)).toThrow(
      /private/,
    );
  });

  it('rejects 0.0.0.0/8, CGNAT, multicast, reserved', () => {
    expect(() => assertUrlIsSafe('http://0.0.0.0/', allowed)).toThrow(/private/);
    expect(() => assertUrlIsSafe('http://100.64.0.1/', allowed)).toThrow(/private/);
    expect(() => assertUrlIsSafe('http://224.0.0.1/', allowed)).toThrow(/private/);
    expect(() => assertUrlIsSafe('http://240.0.0.1/', allowed)).toThrow(/private/);
  });

  it('lets 172.15/16 and 172.32/16 through (boundary check on /12)', () => {
    // these are public; allowlist them to confirm the SSRF guard does not
    // reject (they won't pass the domain allowlist by default but we want
    // to ensure the SSRF path itself does not flag them).
    const wide = parseAllowedDomains('172.15.0.1,172.32.0.1');
    expect(() => assertUrlIsSafe('http://172.15.0.1/', wide)).not.toThrow();
    expect(() => assertUrlIsSafe('http://172.32.0.1/', wide)).not.toThrow();
  });

  it('rejects IPv6 literals categorically', () => {
    expect(() => assertUrlIsSafe('http://[::1]/', allowed)).toThrow(
      /policy_denied: IPv6 destinations/,
    );
    expect(() => assertUrlIsSafe('http://[2606:4700::1111]/', allowed)).toThrow(/IPv6/);
  });

  it('rejects public IPv4 literals not on the allowlist', () => {
    const onlyDns = parseAllowedDomains('example.com');
    expect(() => assertUrlIsSafe('http://8.8.8.8/', onlyDns)).toThrow(
      /policy_denied: host "8\.8\.8\.8" is not in the allowlist/,
    );
  });

  it('accepts a public IPv4 literal that IS on the allowlist', () => {
    expect(() => assertUrlIsSafe('http://1.1.1.1/foo', allowed)).not.toThrow();
  });
});

/* =====================================================================
 * SSRF guard (assertHostResolvesPublicly) — DNS-resolution check
 * ===================================================================== */

describe('assertHostResolvesPublicly — DNS-aware SSRF check', () => {
  it('passes when the host resolves to a public IPv4', async () => {
    const lookup: LookupFn = () => Promise.resolve([{ address: '93.184.216.34', family: 4 }]);
    await expect(assertHostResolvesPublicly('example.com', lookup)).resolves.toBeUndefined();
  });

  it('rejects when the host resolves to RFC1918 (DNS rebinding)', async () => {
    const lookup: LookupFn = () => Promise.resolve([{ address: '10.0.0.5', family: 4 }]);
    await expect(assertHostResolvesPublicly('rebind.evil.com', lookup)).rejects.toThrow(
      /policy_denied: host "rebind.evil.com" resolves to a private \/ loopback \/ link-local address \(10\.0\.0\.5\)/,
    );
  });

  it('rejects when ANY returned record is private (defense in depth)', async () => {
    const lookup: LookupFn = () =>
      Promise.resolve([
        { address: '93.184.216.34', family: 4 },
        { address: '127.0.0.1', family: 4 },
      ]);
    await expect(assertHostResolvesPublicly('mixed.example.com', lookup)).rejects.toThrow(
      /127\.0\.0\.1/,
    );
  });

  it('rejects link-local (cloud metadata) resolutions', async () => {
    const lookup: LookupFn = () => Promise.resolve([{ address: '169.254.169.254', family: 4 }]);
    await expect(assertHostResolvesPublicly('metadata.google.internal', lookup)).rejects.toThrow(
      /private \/ loopback \/ link-local/,
    );
  });

  it('rejects IPv6 records (mirrors the literal-IPv6 stance)', async () => {
    const lookup: LookupFn = () => Promise.resolve([{ address: '2606:4700::1111', family: 6 }]);
    await expect(assertHostResolvesPublicly('v6.example.com', lookup)).rejects.toThrow(
      /resolves to IPv6/,
    );
  });

  it('fail-closed when the resolver returns no records', async () => {
    const lookup: LookupFn = () => Promise.resolve([]);
    await expect(assertHostResolvesPublicly('void.example.com', lookup)).rejects.toThrow(
      /returned no addresses/,
    );
  });

  it('fail-closed when the resolver throws (ENOTFOUND, etc.)', async () => {
    const lookup: LookupFn = () => Promise.reject(new Error('ENOTFOUND nope.example.com'));
    await expect(assertHostResolvesPublicly('nope.example.com', lookup)).rejects.toThrow(
      /DNS lookup .* failed: ENOTFOUND/,
    );
  });

  it('skips the resolver for IPv4 literals (assertUrlIsSafe handled them already)', async () => {
    let called = false;
    const lookup: LookupFn = () => {
      called = true;
      return Promise.resolve([]);
    };
    await expect(assertHostResolvesPublicly('1.1.1.1', lookup)).resolves.toBeUndefined();
    expect(called).toBe(false);
  });
});

/* =====================================================================
 * http_get tool — DNS-rebinding integration test
 * ===================================================================== */

describe('http_get tool — DNS rebinding', () => {
  it('refuses an allowlisted hostname that resolves to a private IP', async () => {
    const env = { [ENV_ALLOW_DOMAINS]: 'rebind.example.com' };
    // Hostname IS on the allowlist (operator misconfig OR adversarial DNS)
    // but resolves to RFC1918. Without the post-resolve check, this would
    // hit kube-apiserver / NATS / etc.
    const rebindLookup: LookupFn = () => Promise.resolve([{ address: '10.0.0.5', family: 4 }]);
    const reg = buildBuiltinToolRegistry({
      env,
      fetch: stubFetch({}), // never called — DNS check fails first
      lookup: rebindLookup,
    });
    const def = reg.get('http_get')!;
    const p = new InProcessToolProvider({ tools: [def] });
    const r = await p.executeTool(call('http_get', { url: 'https://rebind.example.com/x' }), ctx());
    expect(r.isError).toBe(true);
    expect(contentString(r)).toMatch(
      /policy_denied: host "rebind.example.com" resolves to a private/,
    );
  });
});

/* =====================================================================
 * extract_text
 * ===================================================================== */

describe('extract_text', () => {
  it('strips tags and collapses whitespace', () => {
    const out = extractTextFromHtml(`<html><body><h1>Hello</h1>\n\n<p>  world  </p></body></html>`);
    expect(out).toBe('Hello world');
  });

  it('drops <script> and <style> contents wholesale', () => {
    const out = extractTextFromHtml(
      `<p>before</p><script>alert('rce')</script><style>body{}</style><p>after</p>`,
    );
    expect(out).toBe('before after');
    expect(out).not.toMatch(/alert/);
    expect(out).not.toMatch(/body\{/);
  });

  it('decodes basic named + numeric entities', () => {
    const out = extractTextFromHtml(`<p>5 &amp; 6 &lt; 7 &gt; 4 &quot;ok&quot; &#65;</p>`);
    expect(out).toBe('5 & 6 < 7 > 4 "ok" A');
  });

  it('caps output at EXTRACT_TEXT_MAX_BYTES', () => {
    const huge = '<p>' + 'a'.repeat(EXTRACT_TEXT_MAX_BYTES * 2) + '</p>';
    const out = extractTextFromHtml(huge);
    expect(out.length).toBe(EXTRACT_TEXT_MAX_BYTES);
  });

  it('throws on non-string input', () => {
    expect(() => extractTextFromHtml(42 as unknown as string)).toThrow(
      /extract_text: html must be a string/,
    );
  });

  it('via tool registry — refuses missing arg', async () => {
    const reg = buildBuiltinToolRegistry({ env: {} });
    const def = reg.get('extract_text')!;
    const p = new InProcessToolProvider({ tools: [def] });
    const r = await p.executeTool(call('extract_text', {}), ctx());
    expect(r.isError).toBe(true);
    expect(contentString(r)).toMatch(/missing or empty required string argument "html"/);
  });
});

/* =====================================================================
 * parseFeed (RSS / Atom)
 * ===================================================================== */

describe('parseFeed', () => {
  it('parses a minimal RSS 2.0 feed', () => {
    const xml = `<?xml version="1.0"?>
      <rss version="2.0"><channel>
        <title>Feed</title>
        <item>
          <title>One</title>
          <link>https://example.com/1</link>
          <pubDate>Mon, 27 Apr 2026 10:00:00 GMT</pubDate>
          <description><![CDATA[<p>Hello <b>one</b></p>]]></description>
        </item>
        <item>
          <title>Two</title>
          <link>https://example.com/2</link>
          <pubDate>Tue, 28 Apr 2026 10:00:00 GMT</pubDate>
          <description>Plain summary</description>
        </item>
      </channel></rss>`;
    const items = parseFeed(xml);
    expect(items).toHaveLength(2);
    expect(items[0]).toEqual({
      title: 'One',
      link: 'https://example.com/1',
      pubDate: 'Mon, 27 Apr 2026 10:00:00 GMT',
      summary: 'Hello one',
    });
    expect(items[1]?.title).toBe('Two');
  });

  it('parses an Atom feed and prefers <link href> over text', () => {
    const xml = `<?xml version="1.0" encoding="utf-8"?>
      <feed xmlns="http://www.w3.org/2005/Atom">
        <title>Atom feed</title>
        <entry>
          <title>Alpha</title>
          <link href="https://example.com/alpha"/>
          <updated>2026-04-27T10:00:00Z</updated>
          <summary>Alpha summary</summary>
        </entry>
      </feed>`;
    const items = parseFeed(xml);
    expect(items).toHaveLength(1);
    expect(items[0]).toEqual({
      title: 'Alpha',
      link: 'https://example.com/alpha',
      pubDate: '2026-04-27T10:00:00Z',
      summary: 'Alpha summary',
    });
  });

  it('throws on non-feed bodies', () => {
    expect(() => parseFeed('<html><body>not a feed</body></html>')).toThrow(
      /not a valid RSS or Atom feed/,
    );
  });

  it('throws on empty input', () => {
    expect(() => parseFeed('')).toThrow(/response body is empty/);
  });

  it('throws on a feed envelope with no items', () => {
    expect(() => parseFeed('<rss><channel><title>x</title></channel></rss>')).toThrow(
      /feed contained no items/,
    );
  });
});

/* =====================================================================
 * http_get tool — happy + refusal paths via stub fetch
 * ===================================================================== */

describe('http_get tool', () => {
  const env = { [ENV_ALLOW_DOMAINS]: 'example.com,nytimes.com' };

  function makeProviderWith(routes: Record<string, () => Response>): InProcessToolProvider {
    const reg = buildBuiltinToolRegistry({
      env,
      fetch: stubFetch(routes),
      lookup: publicLookup,
    });
    const httpGet = reg.get('http_get')!;
    return new InProcessToolProvider({ tools: [httpGet] });
  }

  it('happy path — fetches an allowed host, returns headers + body', async () => {
    const p = makeProviderWith({
      'https://example.com/page': () =>
        new Response('hello world', {
          status: 200,
          headers: { 'content-type': 'text/plain', etag: '"v1"' },
        }),
    });
    const r = await p.executeTool(call('http_get', { url: 'https://example.com/page' }), ctx());
    expect(r.isError).toBe(false);
    const blocks = r.content as { type: string; text: string }[];
    const parsed = JSON.parse(blocks[0]!.text) as {
      status: number;
      headers: Record<string, string>;
      body: string;
      truncated: boolean;
    };
    expect(parsed.status).toBe(200);
    expect(parsed.headers['content-type']).toBe('text/plain');
    expect(parsed.headers['etag']).toBe('"v1"');
    expect(parsed.body).toBe('hello world');
    expect(parsed.truncated).toBe(false);
  });

  it('refuses non-allowlisted domain (becomes ToolResult{isError:true})', async () => {
    const p = makeProviderWith({});
    const r = await p.executeTool(call('http_get', { url: 'https://evil.com/x' }), ctx());
    expect(r.isError).toBe(true);
    expect(contentString(r)).toMatch(/policy_denied: domain "evil.com" is not in the allowlist/);
  });

  it('refuses SSRF target even when explicitly listed', async () => {
    // operator misconfigures the allowlist with 10.0.0.5; SSRF backstop
    // refuses regardless.
    const reg = buildBuiltinToolRegistry({
      env: { [ENV_ALLOW_DOMAINS]: '10.0.0.5,example.com' },
      fetch: stubFetch({}),
    });
    const def = reg.get('http_get')!;
    const p = new InProcessToolProvider({ tools: [def] });
    const r = await p.executeTool(call('http_get', { url: 'http://10.0.0.5/' }), ctx());
    expect(r.isError).toBe(true);
    expect(contentString(r)).toMatch(/private \/ loopback \/ link-local/);
  });

  it('refuses redirect to a bad (non-allowlisted) host', async () => {
    const p = makeProviderWith({
      'https://example.com/start': () =>
        new Response('', {
          status: 302,
          headers: { location: 'https://evil.com/landing' },
        }),
    });
    const r = await p.executeTool(call('http_get', { url: 'https://example.com/start' }), ctx());
    expect(r.isError).toBe(true);
    expect(contentString(r)).toMatch(/policy_denied: domain "evil.com"/);
  });

  it('refuses redirect to a private-IP target even on a same-host hop', async () => {
    const p = makeProviderWith({
      'https://example.com/start': () =>
        new Response('', {
          status: 302,
          headers: { location: 'http://169.254.169.254/latest/meta-data/' },
        }),
    });
    const r = await p.executeTool(call('http_get', { url: 'https://example.com/start' }), ctx());
    expect(r.isError).toBe(true);
    expect(contentString(r)).toMatch(/private \/ loopback \/ link-local/);
  });

  it('follows an allowed redirect to another allowed host', async () => {
    const p = makeProviderWith({
      'https://example.com/start': () =>
        new Response('', {
          status: 302,
          headers: { location: 'https://nytimes.com/landing' },
        }),
      'https://nytimes.com/landing': () =>
        new Response('redirected ok', {
          status: 200,
          headers: { 'content-type': 'text/plain' },
        }),
    });
    const r = await p.executeTool(call('http_get', { url: 'https://example.com/start' }), ctx());
    expect(r.isError).toBe(false);
    const parsed = JSON.parse((r.content as { text: string }[])[0]!.text) as {
      body: string;
      finalUrl: string;
    };
    expect(parsed.body).toBe('redirected ok');
    expect(parsed.finalUrl).toBe('https://nytimes.com/landing');
  });

  it('truncates response body at HTTP_MAX_BODY_BYTES', async () => {
    // synthesize a body larger than the cap; assert truncated=true and
    // returned body is exactly the cap.
    const huge = 'x'.repeat(2 * 1024 * 1024); // 2MB
    const p = makeProviderWith({
      'https://example.com/big': () =>
        new Response(huge, { status: 200, headers: { 'content-type': 'text/plain' } }),
    });
    const r = await p.executeTool(call('http_get', { url: 'https://example.com/big' }), ctx());
    const parsed = JSON.parse((r.content as { text: string }[])[0]!.text) as {
      body: string;
      truncated: boolean;
    };
    expect(parsed.truncated).toBe(true);
    expect(parsed.body.length).toBe(1024 * 1024);
  });

  it('refuses missing url arg', async () => {
    const p = makeProviderWith({});
    const r = await p.executeTool(call('http_get', {}), ctx());
    expect(r.isError).toBe(true);
    expect(contentString(r)).toMatch(/missing or empty required string argument "url"/);
  });
});

/* =====================================================================
 * rss_fetch tool — happy + refusal paths
 * ===================================================================== */

describe('rss_fetch tool', () => {
  const env = { [ENV_ALLOW_DOMAINS]: 'feeds.example.com' };

  it('happy path — fetches a feed and returns parsed items', async () => {
    const xml = `<rss version="2.0"><channel>
      <title>F</title>
      <item><title>T</title><link>https://feeds.example.com/1</link><pubDate>now</pubDate><description>d</description></item>
    </channel></rss>`;
    const reg = buildBuiltinToolRegistry({
      env,
      fetch: stubFetch({
        'https://feeds.example.com/feed.xml': () =>
          new Response(xml, { status: 200, headers: { 'content-type': 'application/rss+xml' } }),
      }),
      lookup: publicLookup,
    });
    const def = reg.get('rss_fetch')!;
    const p = new InProcessToolProvider({ tools: [def] });
    const r = await p.executeTool(
      call('rss_fetch', { url: 'https://feeds.example.com/feed.xml' }),
      ctx(),
    );
    expect(r.isError).toBe(false);
    const items = JSON.parse((r.content as { text: string }[])[0]!.text) as { title: string }[];
    expect(items).toHaveLength(1);
    expect(items[0]?.title).toBe('T');
  });

  it('refuses on a non-feed body', async () => {
    const reg = buildBuiltinToolRegistry({
      env,
      fetch: stubFetch({
        'https://feeds.example.com/captcha': () =>
          new Response('<html>captcha</html>', {
            status: 200,
            headers: { 'content-type': 'text/html' },
          }),
      }),
      lookup: publicLookup,
    });
    const def = reg.get('rss_fetch')!;
    const p = new InProcessToolProvider({ tools: [def] });
    const r = await p.executeTool(
      call('rss_fetch', { url: 'https://feeds.example.com/captcha' }),
      ctx(),
    );
    expect(r.isError).toBe(true);
    expect(contentString(r)).toMatch(/not a valid RSS or Atom feed/);
  });

  it('refuses non-allowlisted domain', async () => {
    const reg = buildBuiltinToolRegistry({ env, fetch: stubFetch({}) });
    const def = reg.get('rss_fetch')!;
    const p = new InProcessToolProvider({ tools: [def] });
    const r = await p.executeTool(call('rss_fetch', { url: 'https://evil.com/feed' }), ctx());
    expect(r.isError).toBe(true);
    expect(contentString(r)).toMatch(/policy_denied: domain "evil.com"/);
  });

  it('surfaces upstream 4xx as a tool error', async () => {
    const reg = buildBuiltinToolRegistry({
      env,
      fetch: stubFetch({
        'https://feeds.example.com/missing': () => new Response('not found', { status: 404 }),
      }),
      lookup: publicLookup,
    });
    const def = reg.get('rss_fetch')!;
    const p = new InProcessToolProvider({ tools: [def] });
    const r = await p.executeTool(
      call('rss_fetch', { url: 'https://feeds.example.com/missing' }),
      ctx(),
    );
    expect(r.isError).toBe(true);
    expect(contentString(r)).toMatch(/upstream returned status 404/);
  });
});

/* =====================================================================
 * resolveBuiltinTools — runner-side wiring
 * ===================================================================== */

describe('resolveBuiltinTools', () => {
  it('returns null for undefined names', () => {
    expect(resolveBuiltinTools(undefined)).toBeNull();
  });

  it('returns null for empty list', () => {
    expect(resolveBuiltinTools([])).toBeNull();
  });

  it('returns a provider exposing exactly the requested tools', () => {
    const provider = resolveBuiltinTools(['http_get', 'extract_text']);
    expect(provider).not.toBeNull();
    // resolveBuiltinTools always returns an InProcessToolProvider whose
    // describeTools() is synchronous; the wider `ToolProvider` union allows
    // an async return so we narrow with an Array.isArray guard.
    const desc = provider!.describeTools();
    expect(Array.isArray(desc)).toBe(true);
    const names = (desc as { name: string }[]).map((d) => d.name);
    expect(names.sort()).toEqual(['extract_text', 'http_get']);
  });

  it('deduplicates repeated names', () => {
    const provider = resolveBuiltinTools(['http_get', 'http_get', 'extract_text']);
    const desc = provider!.describeTools();
    const names = (desc as { name: string }[]).map((d) => d.name);
    expect(names.sort()).toEqual(['extract_text', 'http_get']);
  });

  it('throws on the FIRST unknown name with a clear message', () => {
    expect(() => resolveBuiltinTools(['http_get', 'shell_exec'])).toThrow(
      /unknown built-in tool "shell_exec"/,
    );
    expect(() => resolveBuiltinTools(['nope'])).toThrow(/known built-ins:/);
  });
});
