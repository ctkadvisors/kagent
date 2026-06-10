/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

import { isToolRuntimeTool } from '@kagent/dto';

export interface ToolProfileSpec {
  readonly name: string;
  readonly description?: string;
  readonly tools: readonly string[];
}

export interface ToolProfileConfig {
  readonly profiles: readonly ToolProfileSpec[];
}

export type ToolProfileResolution =
  | { readonly ok: true; readonly toolNames: readonly string[] }
  | { readonly ok: false; readonly profileName: string };

export function parseToolProfileConfig(raw: string | undefined): ToolProfileConfig {
  if (raw === undefined || raw.trim().length === 0) return { profiles: [] };

  const parsed: unknown = JSON.parse(raw);
  if (!isRecord(parsed) || !Array.isArray(parsed.profiles)) {
    throw new Error('KAGENT_TOOL_GATEWAY_TOOL_PROFILES_JSON must contain profiles[]');
  }

  return {
    profiles: parsed.profiles.map(parseProfileSpec),
  };
}

export function resolveToolProfileToolNames(
  config: ToolProfileConfig,
  profileRefs: readonly string[],
): ToolProfileResolution {
  const byName = new Map(config.profiles.map((profile) => [profile.name, profile]));
  const out: string[] = [];
  const seen = new Set<string>();

  for (const profileName of profileRefs) {
    const profile = byName.get(profileName);
    if (profile === undefined) return { ok: false, profileName };
    for (const tool of profile.tools) {
      if (seen.has(tool)) continue;
      seen.add(tool);
      out.push(tool);
    }
  }

  return { ok: true, toolNames: out };
}

function parseProfileSpec(raw: unknown): ToolProfileSpec {
  if (!isRecord(raw) || typeof raw.name !== 'string' || !Array.isArray(raw.tools)) {
    throw new Error('tool profile requires name and tools[]');
  }
  if (raw.name.length === 0) throw new Error('tool profile name must be non-empty');
  if (!raw.tools.every((tool): tool is string => typeof tool === 'string' && tool.length > 0)) {
    throw new Error(`tool profile "${raw.name}" tools[] must contain non-empty strings`);
  }
  for (const tool of raw.tools) {
    if (!isGatewayProfileToolName(tool)) {
      throw new Error(`unsupported gateway profile tool "${tool}"`);
    }
  }

  const spec: {
    name: string;
    description?: string;
    tools: readonly string[];
  } = {
    name: raw.name,
    tools: deDupe(raw.tools),
  };
  if (typeof raw.description === 'string') spec.description = raw.description;
  return spec;
}

function deDupe(values: readonly string[]): readonly string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
}

function isGatewayProfileToolName(name: string): boolean {
  return isToolRuntimeTool(name) || name.startsWith('mcp.') || name.startsWith('http.');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
