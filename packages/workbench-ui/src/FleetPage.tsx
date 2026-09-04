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
const env = import.meta.env as { readonly VITE_FLEET_CONSOLE_URL?: string };
const FLEET_CONSOLE_URL = env.VITE_FLEET_CONSOLE_URL ?? 'https://fleet.knuteson.io/';

export function FleetPage() {
  return (
    <iframe
      title="Fleet console"
      src={FLEET_CONSOLE_URL}
      style={{ border: 0, width: '100%', height: 'calc(100vh - 48px)', background: '#0f1115' }}
    />
  );
}
