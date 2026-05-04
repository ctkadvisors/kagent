/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

import { describe, expect, it } from 'vitest';

import { loadIdentityHandle, probeGatewayMtls } from './svid-client.js';

const FIXTURE_CERT = '-----BEGIN CERTIFICATE-----\nABCDEFG\n-----END CERTIFICATE-----';
const FIXTURE_KEY = '-----BEGIN PRIVATE KEY-----\nXYZ123\n-----END PRIVATE KEY-----';
const FIXTURE_BUNDLE = '-----BEGIN CERTIFICATE-----\nbundle\n-----END CERTIFICATE-----';

describe('loadIdentityHandle', () => {
  it('returns null when disabled', () => {
    expect(loadIdentityHandle({ enabled: false })).toBeNull();
  });

  it('returns handle that loads material from default paths when enabled', () => {
    const askedPaths: string[] = [];
    const handle = loadIdentityHandle({
      enabled: true,
      readFile: (p) => {
        askedPaths.push(p);
        if (p === '/var/kagent/svid/tls.crt') return FIXTURE_CERT;
        if (p === '/var/kagent/svid/tls.key') return FIXTURE_KEY;
        if (p === '/var/kagent/svid/bundle.pem') return FIXTURE_BUNDLE;
        return '';
      },
      spiffeId: 'spiffe://kagent.knuteson.io/ns/default/sa/x/agent/researcher',
    });
    expect(handle).not.toBeNull();
    expect(handle?.spiffeId).toBe('spiffe://kagent.knuteson.io/ns/default/sa/x/agent/researcher');
    const m = handle?.loadMaterial();
    expect(m?.certPem).toBe(FIXTURE_CERT);
    expect(m?.keyPem).toBe(FIXTURE_KEY);
    expect(m?.bundlePem).toBe(FIXTURE_BUNDLE);
    expect(askedPaths).toContain('/var/kagent/svid/tls.crt');
    expect(askedPaths).toContain('/var/kagent/svid/tls.key');
  });

  it('honors custom paths', () => {
    const handle = loadIdentityHandle({
      enabled: true,
      certPath: '/etc/svid/cert.pem',
      keyPath: '/etc/svid/key.pem',
      bundlePath: '/etc/svid/bundle.pem',
      readFile: (p) => {
        if (p === '/etc/svid/cert.pem') return FIXTURE_CERT;
        if (p === '/etc/svid/key.pem') return FIXTURE_KEY;
        if (p === '/etc/svid/bundle.pem') return FIXTURE_BUNDLE;
        return '';
      },
    });
    expect(handle?.loadMaterial().bundlePem).toBe(FIXTURE_BUNDLE);
  });

  it('treats missing bundle as undefined (not an error)', () => {
    const handle = loadIdentityHandle({
      enabled: true,
      readFile: (p) => {
        if (p === '/var/kagent/svid/tls.crt') return FIXTURE_CERT;
        if (p === '/var/kagent/svid/tls.key') return FIXTURE_KEY;
        if (p === '/var/kagent/svid/bundle.pem') throw new Error('ENOENT');
        return '';
      },
    });
    const m = handle?.loadMaterial();
    expect(m?.certPem).toBe(FIXTURE_CERT);
    expect(m?.bundlePem).toBeUndefined();
  });

  it('throws on missing cert (substrate fails closed)', () => {
    const handle = loadIdentityHandle({
      enabled: true,
      readFile: (p) => {
        if (p === '/var/kagent/svid/tls.key') return FIXTURE_KEY;
        return '';
      },
    });
    expect(() => handle?.loadMaterial()).toThrow(/SVID cert/);
  });

  it('throws on missing key (substrate fails closed)', () => {
    const handle = loadIdentityHandle({
      enabled: true,
      readFile: (p) => {
        if (p === '/var/kagent/svid/tls.crt') return FIXTURE_CERT;
        return '';
      },
    });
    expect(() => handle?.loadMaterial()).toThrow(/SVID key/);
  });

  it('getMtlsContext returns null when material unavailable', () => {
    const handle = loadIdentityHandle({
      enabled: true,
      readFile: () => '',
    });
    expect(handle?.getMtlsContext()).toBeNull();
  });

  it('getMtlsContext returns shape ready for undici dispatcher', () => {
    const handle = loadIdentityHandle({
      enabled: true,
      readFile: (p) => {
        if (p === '/var/kagent/svid/tls.crt') return FIXTURE_CERT;
        if (p === '/var/kagent/svid/tls.key') return FIXTURE_KEY;
        if (p === '/var/kagent/svid/bundle.pem') return FIXTURE_BUNDLE;
        return '';
      },
    });
    const ctx = handle?.getMtlsContext();
    expect(ctx).toEqual({
      ca: FIXTURE_BUNDLE,
      cert: FIXTURE_CERT,
      key: FIXTURE_KEY,
    });
  });
});

describe('probeGatewayMtls', () => {
  function makeHandle(): NonNullable<ReturnType<typeof loadIdentityHandle>> {
    const h = loadIdentityHandle({
      enabled: true,
      readFile: (p) => {
        if (p === '/var/kagent/svid/tls.crt') return FIXTURE_CERT;
        if (p === '/var/kagent/svid/tls.key') return FIXTURE_KEY;
        if (p === '/var/kagent/svid/bundle.pem') return FIXTURE_BUNDLE;
        return '';
      },
    });
    if (h === null) throw new Error('handle should be non-null');
    return h;
  }

  const okResponse = (
    status: number,
  ): { ok: boolean; status: number; headers: { get: () => null } } => ({
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (): null => null },
  });

  it('returns mtlsSupported=true on successful 200 response', async () => {
    const result = await probeGatewayMtls({
      handle: makeHandle(),
      baseUrl: 'https://gateway.example.com/v1',
      fetchImpl: () => Promise.resolve(okResponse(200)),
    });
    expect(result.mtlsSupported).toBe(true);
    expect(result.reason).toBe('handshake-ok');
    expect(result.detail).toContain('200');
  });

  it('returns mtlsSupported=false on 426 Upgrade Required (bearer-only gateway)', async () => {
    const result = await probeGatewayMtls({
      handle: makeHandle(),
      baseUrl: 'https://bearer-only.example.com',
      fetchImpl: () => Promise.resolve(okResponse(426)),
    });
    expect(result.mtlsSupported).toBe(false);
    expect(result.reason).toBe('tls-error');
  });

  it('returns mtlsSupported=true on 401/403 (TLS handshake completed; bearer auth issue)', async () => {
    const result = await probeGatewayMtls({
      handle: makeHandle(),
      baseUrl: 'https://gateway.example.com',
      fetchImpl: () => Promise.resolve(okResponse(401)),
    });
    // Per design: handshake completed -> mTLS is on the wire.
    expect(result.mtlsSupported).toBe(true);
  });

  it('returns mtlsSupported=false on network rejection (TLS handshake refused)', async () => {
    const result = await probeGatewayMtls({
      handle: makeHandle(),
      baseUrl: 'https://gateway.example.com',
      fetchImpl: () => Promise.reject(new Error('ECONNREFUSED')),
    });
    expect(result.mtlsSupported).toBe(false);
    expect(result.reason).toBe('fetch-rejected');
    expect(result.detail).toContain('ECONNREFUSED');
  });

  it('returns mtlsSupported=false when SVID material missing (no-cert-material)', async () => {
    const handle = loadIdentityHandle({
      enabled: true,
      readFile: () => '',
    });
    if (handle === null) throw new Error('expected handle');
    const result = await probeGatewayMtls({
      handle,
      baseUrl: 'https://gateway.example.com',
      fetchImpl: () => Promise.resolve(okResponse(200)),
    });
    expect(result.mtlsSupported).toBe(false);
    expect(result.reason).toBe('no-cert-material');
  });

  it('strips trailing slash on baseUrl when assembling probe URL', async () => {
    let calledUrl = '';
    await probeGatewayMtls({
      handle: makeHandle(),
      baseUrl: 'https://gateway.example.com/v1/',
      fetchImpl: (url) => {
        calledUrl = url;
        return Promise.resolve(okResponse(200));
      },
    });
    expect(calledUrl).toBe('https://gateway.example.com/v1/health');
  });

  it('threads X-Kagent-Identity-Probe header', async () => {
    let calledHeaders: Record<string, string> = {};
    await probeGatewayMtls({
      handle: makeHandle(),
      baseUrl: 'https://gateway.example.com',
      fetchImpl: (_url, init) => {
        calledHeaders = init.headers;
        return Promise.resolve(okResponse(200));
      },
    });
    expect(calledHeaders['X-Kagent-Identity-Probe']).toBe('optional');
  });
});
