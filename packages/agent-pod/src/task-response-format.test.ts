/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

import { describe, expect, it } from 'vitest';
import { compileTaskResponseFormat } from './task-response-format.js';

const responseFormat = {
  type: 'json_schema',
  json_schema: {
    name: 'report',
    strict: true,
    schema: {
      type: 'object',
      required: ['items'],
      additionalProperties: false,
      properties: { items: { type: 'array', items: { type: 'string' } } },
    },
  },
};

describe('compileTaskResponseFormat', () => {
  it.each([undefined, null, 'ordinary task', {}, { text: 'ordinary task' }])(
    'leaves tasks without a response contract unchanged: %j',
    (payload) => expect(compileTaskResponseFormat(payload)).toBeUndefined(),
  );

  it('pairs the unchanged model format with a schema validator', () => {
    const contract = compileTaskResponseFormat({ responseFormat });
    expect(contract?.finalResponseFormat).toBe(responseFormat);
    expect(contract?.validateFinalResponse({ items: ['evidence'] })).toBe(true);
    expect(contract?.validateFinalResponse({ items: [] })).toBe(true);
  });

  it.each([null, {}, { items: 'wrong type' }, { items: [3] }, { items: [], extra: true }])(
    'refuses values violating the exact schema: %j',
    (value) => {
      const contract = compileTaskResponseFormat({ responseFormat });
      expect(contract?.validateFinalResponse(value)).toBe(false);
    },
  );

  it.each([
    undefined,
    null,
    [],
    { type: 'json_object' },
    { ...responseFormat, json_schema: [] },
    { ...responseFormat, json_schema: { ...responseFormat.json_schema, name: 'bad name' } },
    { ...responseFormat, json_schema: { ...responseFormat.json_schema, strict: false } },
    { ...responseFormat, json_schema: { ...responseFormat.json_schema, schema: [] } },
    { ...responseFormat, padding: 'x'.repeat(16384) },
  ])('refuses malformed or oversized task formats: %j', (format) => {
    expect(() => compileTaskResponseFormat({ responseFormat: format })).toThrow(
      'invalid_task_response_format',
    );
  });

  it('refuses asynchronous schemas for the synchronous executor validator', () => {
    expect(() =>
      compileTaskResponseFormat({
        responseFormat: {
          ...responseFormat,
          json_schema: {
            ...responseFormat.json_schema,
            schema: { ...responseFormat.json_schema.schema, $async: true },
          },
        },
      }),
    ).toThrow('invalid_task_response_format');
  });

  it('compiles schemas strictly before any model turn', () => {
    expect(() =>
      compileTaskResponseFormat({
        responseFormat: {
          ...responseFormat,
          json_schema: { ...responseFormat.json_schema, schema: { type: 'made-up-type' } },
        },
      }),
    ).toThrow();
  });
});
