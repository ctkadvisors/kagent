/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

import { describe, expect, it } from 'vitest';

import { parseToolProfileConfig, resolveToolProfileToolNames } from './tool-profiles.js';

describe('tool profile config', () => {
  it('parses gateway-owned agent tool profiles from JSON config', () => {
    expect(
      parseToolProfileConfig(
        JSON.stringify({
          profiles: [
            {
              name: 'browser-code-researcher',
              description: 'Browser plus code tools for bounded research jobs.',
              tools: [
                'browser.start_session',
                'browser.goto',
                'browser.extract_text',
                'code_interpreter.execute_code',
                'mcp.project.lookup',
                'http.project.lookup',
              ],
            },
          ],
        }),
      ),
    ).toEqual({
      profiles: [
        {
          name: 'browser-code-researcher',
          description: 'Browser plus code tools for bounded research jobs.',
          tools: [
            'browser.start_session',
            'browser.goto',
            'browser.extract_text',
            'code_interpreter.execute_code',
            'mcp.project.lookup',
            'http.project.lookup',
          ],
        },
      ],
    });
  });

  it('rejects profile tools that are not served by the gateway runtime or external providers', () => {
    expect(() =>
      parseToolProfileConfig(
        JSON.stringify({
          profiles: [{ name: 'unsafe', tools: ['shell_exec'] }],
        }),
      ),
    ).toThrow(/unsupported gateway profile tool "shell_exec"/);
  });

  it('resolves named profiles to a de-duplicated ordered gateway tool grant', () => {
    const config = parseToolProfileConfig(
      JSON.stringify({
        profiles: [
          {
            name: 'browser-code-researcher',
            tools: ['browser.goto', 'code_interpreter.execute_code'],
          },
          {
            name: 'browser-reviewer',
            tools: ['browser.goto', 'browser.screenshot'],
          },
        ],
      }),
    );

    expect(
      resolveToolProfileToolNames(config, ['browser-code-researcher', 'browser-reviewer']),
    ).toEqual({
      ok: true,
      toolNames: ['browser.goto', 'code_interpreter.execute_code', 'browser.screenshot'],
    });
  });

  it('fails closed when a requested profile is unknown', () => {
    expect(resolveToolProfileToolNames({ profiles: [] }, ['missing'])).toEqual({
      ok: false,
      profileName: 'missing',
    });
  });
});
