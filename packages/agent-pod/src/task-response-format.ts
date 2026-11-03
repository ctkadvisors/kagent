/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

import { Ajv } from 'ajv';

/** Protected prerequisite for task-bound finalization; the runner activates it after adoption. */
export function compileTaskResponseFormat(payload: unknown):
  | {
      finalResponseFormat: Readonly<Record<string, unknown>>;
      validateFinalResponse: (value: unknown) => boolean;
    }
  | undefined {
  if (typeof payload !== 'object' || payload === null || !('responseFormat' in payload))
    return undefined;
  const format: unknown = payload.responseFormat;
  if (typeof format !== 'object' || format === null || Array.isArray(format)) {
    throw new Error('invalid_task_response_format');
  }
  const value = format as Record<string, unknown>;
  const specification = value['json_schema'];
  if (
    value['type'] !== 'json_schema' ||
    typeof specification !== 'object' ||
    specification === null
  ) {
    throw new Error('invalid_task_response_format');
  }
  const spec = specification as Record<string, unknown>;
  if (
    typeof spec['name'] !== 'string' ||
    !/^[A-Za-z0-9_-]{1,64}$/.test(spec['name']) ||
    spec['strict'] !== true ||
    typeof spec['schema'] !== 'object' ||
    spec['schema'] === null ||
    Array.isArray(spec['schema']) ||
    (spec['schema'] as Record<string, unknown>)['$async'] === true ||
    JSON.stringify(value).length > 16384
  ) {
    throw new Error('invalid_task_response_format');
  }
  return {
    finalResponseFormat: value,
    validateFinalResponse: new Ajv({ strict: true, ownProperties: true }).compile(spec['schema']),
  };
}
