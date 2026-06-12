/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

import type { WhatsAppSocketFactory, WhatsAppSocketLike } from './types.js';

interface BaileysAuthStateResult {
  readonly state: unknown;
  readonly saveCreds: () => Promise<void> | void;
}

interface BaileysVersionResult {
  readonly version: readonly [number, number, number];
}

interface BaileysModule {
  readonly default: (options: Record<string, unknown>) => WhatsAppSocketLike;
  readonly useMultiFileAuthState: (authDir: string) => Promise<BaileysAuthStateResult>;
  readonly fetchLatestBaileysVersion?: () => Promise<BaileysVersionResult>;
}

export function createBaileysSocketFactory(): WhatsAppSocketFactory {
  return async ({ authDir }) => {
    const baileys = (await import('@whiskeysockets/baileys')) as unknown as BaileysModule;
    const auth = await baileys.useMultiFileAuthState(authDir);
    const version = await fetchBaileysVersion(baileys);
    const options: Record<string, unknown> = {
      auth: auth.state,
      printQRInTerminal: false,
      markOnlineOnConnect: false,
      syncFullHistory: false,
      ...(version !== undefined && { version }),
    };
    return {
      socket: baileys.default(options),
      saveCreds: auth.saveCreds,
    };
  };
}

async function fetchBaileysVersion(
  baileys: Pick<BaileysModule, 'fetchLatestBaileysVersion'>,
): Promise<readonly [number, number, number] | undefined> {
  if (baileys.fetchLatestBaileysVersion === undefined) return undefined;
  try {
    return (await baileys.fetchLatestBaileysVersion()).version;
  } catch {
    return undefined;
  }
}
