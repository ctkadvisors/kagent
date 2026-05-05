/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/**
 * Env-driven live gateway conformance runner.
 *
 * The CI path exercises `conformance.ts` with mocked fetch. This CLI is
 * for Enterprise Pilot RC evidence runs against a real gateway.
 */

import { runGatewayConformance, type MtlsSvidExpectation } from './conformance.js';

async function main(): Promise<void> {
  try {
    const mtls: MtlsSvidExpectation = {
      gatewayMtlsEnabled: readBoolEnv('KAGENT_GATEWAY_MTLS_ENABLED', false),
      svidAvailable: readBoolEnv('KAGENT_GATEWAY_SVID_AVAILABLE', false),
      bearerFallbackAllowed: readBoolEnv('KAGENT_GATEWAY_BEARER_FALLBACK', true),
    };
    const adminToken = readOptionalEnv('KAGENT_GATEWAY_ADMIN_TOKEN');
    const traceparent = readOptionalEnv('KAGENT_GATEWAY_TRACEPARENT');
    const report = await runGatewayConformance({
      gatewayUrl: readRequiredEnv('KAGENT_GATEWAY_URL'),
      model: readRequiredEnv('KAGENT_GATEWAY_MODEL'),
      apiToken: readRequiredEnv('KAGENT_GATEWAY_API_TOKEN'),
      ...(adminToken !== undefined && { adminToken }),
      ...(traceparent !== undefined && { traceparent }),
      taskUid: readOptionalEnv('KAGENT_GATEWAY_TASK_UID') ?? 'enterprise-pilot-rc-task',
      agentName: readOptionalEnv('KAGENT_GATEWAY_AGENT') ?? 'enterprise-pilot-rc-agent',
      tenant: readOptionalEnv('KAGENT_GATEWAY_TENANT') ?? 'enterprise-pilot-rc-tenant',
      mtls,
    });

    console.log(JSON.stringify(report, null, 2));
    if (report.checks.some((check) => check.status === 'fail')) {
      process.exitCode = 1;
    }
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 2;
  }
}

function readRequiredEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.trim().length === 0) {
    throw new Error(`${name} is required`);
  }
  return value;
}

function readOptionalEnv(name: string): string | undefined {
  const value = process.env[name];
  if (value === undefined || value.trim().length === 0) return undefined;
  return value;
}

function readBoolEnv(name: string, defaultValue: boolean): boolean {
  const value = process.env[name];
  if (value === undefined || value.trim().length === 0) return defaultValue;
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new Error(`${name} must be "true" or "false"`);
}

await main();
