/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/**
 * The fleet console (services/fleet-scripts/scripts/console.py in new_localai)
 * as a tab: it is its own one-file page on the LAN at fleet.knuteson.io, so it
 * is framed here rather than rebuilt. Chris, 2026-09-04: "why isnt this a
 * subtab of kagent.knuteson.io".
 */
const DEFAULT_URL = 'https://fleet.knuteson.io/';
const env = import.meta.env as { readonly VITE_FLEET_CONSOLE_URL?: string };

/** Only an https URL may be framed; anything else (javascript:, data:, a typo) falls back. */
export function fleetConsoleUrl(candidate: string | undefined): string {
  if (candidate === undefined) return DEFAULT_URL;
  try {
    const u = new URL(candidate);
    return u.protocol === 'https:' ? u.href : DEFAULT_URL;
  } catch {
    return DEFAULT_URL;
  }
}

export function FleetPage() {
  return (
    <iframe
      title="Fleet console"
      src={fleetConsoleUrl(env.VITE_FLEET_CONSOLE_URL)}
      // The console fetches its own API (same-origin), uses confirm/prompt
      // (modals) and opens GitHub links in new tabs (popups). No top-navigation.
      sandbox="allow-scripts allow-same-origin allow-modals allow-popups allow-forms"
      referrerPolicy="no-referrer"
      style={{ border: 0, width: '100%', height: 'calc(100vh - 48px)', background: '#0f1115' }}
    />
  );
}
