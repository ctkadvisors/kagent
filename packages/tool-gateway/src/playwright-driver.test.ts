/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

import { describe, expect, it, vi } from 'vitest';

import { createPlaywrightCdpDriver } from './playwright-driver.js';

function makeFixture() {
  const locator = {
    click: vi.fn(() => Promise.resolve()),
    fill: vi.fn(() => Promise.resolve()),
    waitFor: vi.fn(() => Promise.resolve()),
  };
  const textLocator = {
    click: vi.fn(() => Promise.resolve()),
    waitFor: vi.fn(() => Promise.resolve()),
  };
  const page = {
    goto: vi.fn(() => Promise.resolve()),
    title: vi.fn(() => Promise.resolve('Example')),
    url: vi.fn(() => 'https://example.com/report'),
    locator: vi.fn(() => locator),
    getByText: vi.fn(() => textLocator),
    selectOption: vi.fn(() => Promise.resolve(['deep'])),
    waitForSelector: vi.fn(() => Promise.resolve()),
    screenshot: vi.fn(() => Promise.resolve(Buffer.from('png'))),
    evaluate: vi.fn(() => Promise.resolve('Visible page text')),
  };
  const context = {
    pages: vi.fn(() => [page]),
    newPage: vi.fn(() => Promise.resolve(page)),
  };
  const browser = {
    contexts: vi.fn(() => [context]),
    newContext: vi.fn(() => Promise.resolve(context)),
    close: vi.fn(() => Promise.resolve()),
  };
  const chromium = {
    connectOverCDP: vi.fn(() => Promise.resolve(browser)),
  };

  return { browser, chromium, context, locator, page, textLocator };
}

describe('createPlaywrightCdpDriver', () => {
  it('drives a cached Steel CDP session with Playwright browser actions', async () => {
    const fixture = makeFixture();
    const driver = createPlaywrightCdpDriver({
      chromium: fixture.chromium,
      defaultTimeoutMs: 7000,
    });

    await expect(
      driver.goto('ws://steel/session-1', 'https://example.com/report', {
        timeoutMs: undefined,
      }),
    ).resolves.toEqual({
      url: 'https://example.com/report',
      title: 'Example',
    });
    await expect(
      driver.click('ws://steel/session-1', {
        selector: 'button[name=search]',
        timeoutMs: 500,
      }),
    ).resolves.toEqual({ ok: true });
    await expect(
      driver.click('ws://steel/session-1', {
        text: 'Run',
        timeoutMs: undefined,
      }),
    ).resolves.toEqual({ ok: true, matched: 'text' });
    await expect(
      driver.typeText('ws://steel/session-1', {
        selector: 'input[name=q]',
        text: 'agent sandbox',
        timeoutMs: undefined,
      }),
    ).resolves.toEqual({ ok: true });
    await expect(
      driver.select('ws://steel/session-1', {
        selector: 'select[name=mode]',
        value: 'deep',
        timeoutMs: 1000,
      }),
    ).resolves.toEqual({ ok: true });
    await expect(
      driver.waitFor('ws://steel/session-1', {
        selector: '#results',
        timeoutMs: 1500,
      }),
    ).resolves.toEqual({ ok: true, matched: 'selector' });
    await expect(
      driver.waitFor('ws://steel/session-1', {
        text: 'Results',
        timeoutMs: undefined,
      }),
    ).resolves.toEqual({ ok: true, matched: 'text' });
    await expect(
      driver.screenshot('ws://steel/session-1', {
        fullPage: true,
      }),
    ).resolves.toEqual({
      mimeType: 'image/png',
      base64: Buffer.from('png').toString('base64'),
    });
    await expect(
      driver.extractText('ws://steel/session-1', {
        maxChars: 7,
      }),
    ).resolves.toEqual({ text: 'Visible' });

    expect(fixture.chromium.connectOverCDP).toHaveBeenCalledTimes(1);
    expect(fixture.chromium.connectOverCDP).toHaveBeenCalledWith('ws://steel/session-1');
    expect(fixture.page.goto).toHaveBeenCalledWith('https://example.com/report', {
      waitUntil: 'domcontentloaded',
      timeout: 7000,
    });
    expect(fixture.page.locator).toHaveBeenCalledWith('button[name=search]');
    expect(fixture.locator.click).toHaveBeenCalledWith({ timeout: 500 });
    expect(fixture.page.getByText).toHaveBeenCalledWith('Run', { exact: false });
    expect(fixture.textLocator.click).toHaveBeenCalledWith({ timeout: 7000 });
    expect(fixture.locator.fill).toHaveBeenCalledWith('agent sandbox', { timeout: 7000 });
    expect(fixture.page.selectOption).toHaveBeenCalledWith('select[name=mode]', 'deep', {
      timeout: 1000,
    });
    expect(fixture.page.waitForSelector).toHaveBeenCalledWith('#results', { timeout: 1500 });
    expect(fixture.textLocator.waitFor).toHaveBeenCalledWith({ timeout: 7000 });
    expect(fixture.page.screenshot).toHaveBeenCalledWith({ type: 'png', fullPage: true });

    await driver.closeSession?.('ws://steel/session-1');
    expect(fixture.browser.close).toHaveBeenCalledTimes(1);
  });

  it('reconnects once when a cached CDP page has been closed by Steel', async () => {
    const closedPage = {
      goto: vi.fn(() =>
        Promise.reject(new Error('page.goto: Target page, context or browser has been closed')),
      ),
      title: vi.fn(() => Promise.resolve('Closed')),
      url: vi.fn(() => 'about:blank'),
      locator: vi.fn(),
      getByText: vi.fn(),
      selectOption: vi.fn(),
      waitForSelector: vi.fn(),
      screenshot: vi.fn(),
      evaluate: vi.fn(),
    };
    const recoveredPage = {
      goto: vi.fn(() => Promise.resolve()),
      title: vi.fn(() => Promise.resolve('Recovered')),
      url: vi.fn(() => 'https://example.com/recovered'),
      locator: vi.fn(),
      getByText: vi.fn(),
      selectOption: vi.fn(),
      waitForSelector: vi.fn(),
      screenshot: vi.fn(),
      evaluate: vi.fn(),
    };
    const closedContext = {
      pages: vi.fn(() => [closedPage]),
      newPage: vi.fn(() => Promise.resolve(closedPage)),
    };
    const recoveredContext = {
      pages: vi.fn(() => [recoveredPage]),
      newPage: vi.fn(() => Promise.resolve(recoveredPage)),
    };
    const closedBrowser = {
      contexts: vi.fn(() => [closedContext]),
      newContext: vi.fn(() => Promise.resolve(closedContext)),
      close: vi.fn(() => Promise.resolve()),
    };
    const recoveredBrowser = {
      contexts: vi.fn(() => [recoveredContext]),
      newContext: vi.fn(() => Promise.resolve(recoveredContext)),
      close: vi.fn(() => Promise.resolve()),
    };
    const chromium = {
      connectOverCDP: vi
        .fn()
        .mockResolvedValueOnce(closedBrowser)
        .mockResolvedValueOnce(recoveredBrowser),
    };
    const driver = createPlaywrightCdpDriver({
      chromium,
      defaultTimeoutMs: 7000,
    });

    await expect(
      driver.goto('ws://steel/shared-root', 'https://example.com/recovered', {
        timeoutMs: undefined,
      }),
    ).resolves.toEqual({
      url: 'https://example.com/recovered',
      title: 'Recovered',
    });

    expect(chromium.connectOverCDP).toHaveBeenCalledTimes(2);
    expect(closedBrowser.close).toHaveBeenCalledTimes(1);
    expect(recoveredPage.goto).toHaveBeenCalledWith('https://example.com/recovered', {
      waitUntil: 'domcontentloaded',
      timeout: 7000,
    });
  });
});
