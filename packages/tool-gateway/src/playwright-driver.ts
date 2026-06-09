/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

import { chromium as defaultChromium } from 'playwright-core';

import type {
  BrowserAutomationDriver,
  BrowserClickOptions,
  BrowserExtractTextOptions,
  BrowserExtractTextResult,
  BrowserGotoOptions,
  BrowserGotoResult,
  BrowserInteractionResult,
  BrowserScreenshotOptions,
  BrowserScreenshotResult,
  BrowserSelectOptions,
  BrowserTypeTextOptions,
  BrowserWaitForOptions,
} from './browser-steel.js';

export interface PlaywrightCdpDriverOptions {
  readonly chromium?: PlaywrightChromiumLike;
  readonly defaultTimeoutMs?: number;
}

export interface PlaywrightChromiumLike {
  readonly connectOverCDP: (endpointURL: string) => Promise<PlaywrightBrowserLike>;
}

interface PlaywrightBrowserLike {
  readonly contexts: () => PlaywrightBrowserContextLike[];
  readonly newContext: () => Promise<PlaywrightBrowserContextLike>;
  readonly close: () => Promise<void>;
}

interface PlaywrightBrowserContextLike {
  readonly pages: () => PlaywrightPageLike[];
  readonly newPage: () => Promise<PlaywrightPageLike>;
}

interface PlaywrightPageLike {
  readonly goto: (
    url: string,
    options: { readonly waitUntil: 'domcontentloaded'; readonly timeout: number },
  ) => Promise<unknown>;
  readonly title: () => Promise<string>;
  readonly url: () => string;
  readonly locator: (selector: string) => PlaywrightLocatorLike;
  readonly getByText: (text: string, options: { readonly exact: false }) => PlaywrightLocatorLike;
  readonly selectOption: (
    selector: string,
    value: string,
    options: { readonly timeout: number },
  ) => Promise<unknown>;
  readonly waitForSelector: (
    selector: string,
    options: { readonly timeout: number },
  ) => Promise<unknown>;
  readonly screenshot: (options: {
    readonly type: 'png';
    readonly fullPage?: boolean;
  }) => Promise<Buffer>;
  readonly evaluate: <T>(pageFunction: string | (() => T | Promise<T>)) => Promise<T>;
}

interface PlaywrightLocatorLike {
  readonly click: (options: { readonly timeout: number }) => Promise<void>;
  readonly fill?: (value: string, options: { readonly timeout: number }) => Promise<void>;
  readonly waitFor?: (options: { readonly timeout: number }) => Promise<void>;
}

interface CachedCdpSession {
  readonly browser: PlaywrightBrowserLike;
  readonly page: PlaywrightPageLike;
}

const DEFAULT_TIMEOUT_MS = 30_000;

export function createPlaywrightCdpDriver(
  options: PlaywrightCdpDriverOptions = {},
): BrowserAutomationDriver {
  return new PlaywrightCdpDriver(
    options.chromium ?? defaultChromium,
    options.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS,
  );
}

class PlaywrightCdpDriver implements BrowserAutomationDriver {
  private readonly sessions = new Map<string, Promise<CachedCdpSession>>();

  constructor(
    private readonly chromium: PlaywrightChromiumLike,
    private readonly defaultTimeoutMs: number,
  ) {}

  async goto(cdpUrl: string, url: string, options: BrowserGotoOptions): Promise<BrowserGotoResult> {
    return this.withPage(cdpUrl, async (page) => {
      await page.goto(url, {
        waitUntil: 'domcontentloaded',
        timeout: this.resolveTimeout(options.timeoutMs),
      });

      return {
        url: page.url(),
        title: await page.title(),
      };
    });
  }

  async click(cdpUrl: string, options: BrowserClickOptions): Promise<BrowserInteractionResult> {
    return this.withPage(cdpUrl, async (page) => {
      const timeout = this.resolveTimeout(options.timeoutMs);
      if (options.selector !== undefined) {
        await page.locator(options.selector).click({ timeout });
        return { ok: true };
      }
      if (options.text !== undefined) {
        await page.getByText(options.text, { exact: false }).click({ timeout });
        return { ok: true, matched: 'text' };
      }

      throw new Error('browser_click_invalid: selector or text is required');
    });
  }

  async screenshot(
    cdpUrl: string,
    options: BrowserScreenshotOptions,
  ): Promise<BrowserScreenshotResult> {
    return this.withPage(cdpUrl, async (page) => {
      const bytes = await page.screenshot({
        type: 'png',
        ...(options.fullPage !== undefined && { fullPage: options.fullPage }),
      });
      return {
        mimeType: 'image/png',
        base64: bytes.toString('base64'),
      };
    });
  }

  async select(cdpUrl: string, options: BrowserSelectOptions): Promise<BrowserInteractionResult> {
    return this.withPage(cdpUrl, async (page) => {
      await page.selectOption(options.selector, options.value, {
        timeout: this.resolveTimeout(options.timeoutMs),
      });
      return { ok: true };
    });
  }

  async extractText(
    cdpUrl: string,
    options: BrowserExtractTextOptions,
  ): Promise<BrowserExtractTextResult> {
    return this.withPage(cdpUrl, async (page) => {
      const text = await page.evaluate<string>(
        'document.body?.innerText ?? document.documentElement?.textContent ?? ""',
      );

      return {
        text:
          options.maxChars === undefined || text.length <= options.maxChars
            ? text
            : text.slice(0, options.maxChars),
      };
    });
  }

  async typeText(
    cdpUrl: string,
    options: BrowserTypeTextOptions,
  ): Promise<BrowserInteractionResult> {
    return this.withPage(cdpUrl, async (page) => {
      const locator = page.locator(options.selector);
      if (locator.fill === undefined) {
        throw new Error('browser_type_unsupported: Playwright locator.fill is unavailable');
      }
      await locator.fill(options.text, { timeout: this.resolveTimeout(options.timeoutMs) });
      return { ok: true };
    });
  }

  async waitFor(cdpUrl: string, options: BrowserWaitForOptions): Promise<BrowserInteractionResult> {
    return this.withPage(cdpUrl, async (page) => {
      const timeout = this.resolveTimeout(options.timeoutMs);
      if (options.selector !== undefined) {
        await page.waitForSelector(options.selector, { timeout });
        return { ok: true, matched: 'selector' };
      }
      if (options.text !== undefined) {
        const locator = page.getByText(options.text, { exact: false });
        if (locator.waitFor === undefined) {
          throw new Error('browser_wait_unsupported: Playwright locator.waitFor is unavailable');
        }
        await locator.waitFor({ timeout });
        return { ok: true, matched: 'text' };
      }

      throw new Error('browser_wait_invalid: selector or text is required');
    });
  }

  async closeSession(cdpUrl: string): Promise<void> {
    const existing = this.sessions.get(cdpUrl);
    this.sessions.delete(cdpUrl);
    if (existing === undefined) return;

    try {
      const session = await existing;
      await session.browser.close();
    } catch (err) {
      if (!isClosedTargetError(err)) throw err;
    }
  }

  private async pageFor(cdpUrl: string): Promise<PlaywrightPageLike> {
    const session = await this.sessionFor(cdpUrl);
    return session.page;
  }

  private async withPage<T>(
    cdpUrl: string,
    action: (page: PlaywrightPageLike) => Promise<T>,
  ): Promise<T> {
    const page = await this.pageFor(cdpUrl);
    try {
      return await action(page);
    } catch (err) {
      if (!isClosedTargetError(err)) throw err;
      await this.closeSession(cdpUrl);
      return action(await this.pageFor(cdpUrl));
    }
  }

  private sessionFor(cdpUrl: string): Promise<CachedCdpSession> {
    const existing = this.sessions.get(cdpUrl);
    if (existing !== undefined) return existing;

    const created = this.createSession(cdpUrl).catch((err: unknown) => {
      this.sessions.delete(cdpUrl);
      throw err;
    });
    this.sessions.set(cdpUrl, created);
    return created;
  }

  private async createSession(cdpUrl: string): Promise<CachedCdpSession> {
    const browser = await this.chromium.connectOverCDP(cdpUrl);
    const context = browser.contexts()[0] ?? (await browser.newContext());
    const page = context.pages()[0] ?? (await context.newPage());
    return { browser, page };
  }

  private resolveTimeout(timeoutMs: number | undefined): number {
    return timeoutMs ?? this.defaultTimeoutMs;
  }
}

function isClosedTargetError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return (
    message.includes('Target page, context or browser has been closed') ||
    message.includes('Target closed') ||
    message.includes('Browser has been closed')
  );
}
