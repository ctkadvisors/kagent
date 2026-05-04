/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

import { describe, expect, it } from 'vitest';

import { globMatch, globMatchAny, globPatternIsSubset, patternListIsSubset } from './glob-match.js';

describe('globMatch', () => {
  it('admits exact literal match', () => {
    expect(globMatch('exact', 'exact')).toBe(true);
  });

  it('rejects literal mismatch', () => {
    expect(globMatch('exact', 'exactly')).toBe(false);
    expect(globMatch('exact', 'exac')).toBe(false);
    expect(globMatch('exact', 'EXACT')).toBe(false); // case-sensitive
  });

  it('admits trailing star against any suffix', () => {
    expect(globMatch('summarizer-*', 'summarizer-abc')).toBe(true);
    expect(globMatch('summarizer-*', 'summarizer-')).toBe(true);
  });

  it('rejects trailing star when the literal prefix is absent', () => {
    expect(globMatch('summarizer-*', 'summarizer')).toBe(false);
    expect(globMatch('summarizer-*', 'other-foo')).toBe(false);
  });

  it('handles multiple star segments', () => {
    expect(globMatch('a*b*c', 'azzzbzzzc')).toBe(true);
    expect(globMatch('a*b*c', 'abc')).toBe(true);
    expect(globMatch('a*b*c', 'azzzbzzz')).toBe(false); // no trailing c
    expect(globMatch('a*b*c', 'axc')).toBe(false); // missing b literal
  });

  it('admits leading star + literal', () => {
    expect(globMatch('*foo', 'barfoo')).toBe(true);
    expect(globMatch('*foo', 'foo')).toBe(true);
    expect(globMatch('*foo', 'foofoo')).toBe(true);
    expect(globMatch('*foo', 'fooz')).toBe(false);
  });

  it('admits the universal wildcard', () => {
    expect(globMatch('*', '')).toBe(true);
    expect(globMatch('*', 'anything-at-all')).toBe(true);
    expect(globMatch('*', 'cas://sha256:abc')).toBe(true);
  });

  it('handles realistic capability targets', () => {
    expect(globMatch('cas://*', 'cas://sha256:abcdef/digest.md')).toBe(true);
    expect(globMatch('workspace:seekarc-*', 'workspace:seekarc-pr-1234')).toBe(true);
    expect(globMatch('workspace:seekarc-*', 'workspace:other-pr-1')).toBe(false);
    expect(globMatch('workers-ai/@cf/meta/llama-*', 'workers-ai/@cf/meta/llama-4-scout')).toBe(
      true,
    );
  });

  it('admits empty pattern only against empty target', () => {
    expect(globMatch('', '')).toBe(true);
    expect(globMatch('', 'x')).toBe(false);
  });

  it('handles consecutive stars (collapse semantics)', () => {
    expect(globMatch('a**b', 'aczzzb')).toBe(true);
    expect(globMatch('**', 'anything')).toBe(true);
  });
});

describe('globMatchAny', () => {
  it('returns true if any pattern matches', () => {
    expect(globMatchAny(['foo', 'bar', 'baz-*'], 'baz-qux')).toBe(true);
  });

  it('returns false if no pattern matches', () => {
    expect(globMatchAny(['foo', 'bar'], 'baz')).toBe(false);
  });

  it('returns false for empty / undefined list (fail-closed)', () => {
    expect(globMatchAny([], 'anything')).toBe(false);
    expect(globMatchAny(undefined, 'anything')).toBe(false);
  });
});

describe('globPatternIsSubset', () => {
  it('admits identical patterns', () => {
    expect(globPatternIsSubset('foo', 'foo')).toBe(true);
    expect(globPatternIsSubset('foo-*', 'foo-*')).toBe(true);
  });

  it('admits any pattern under universal parent', () => {
    expect(globPatternIsSubset('foo', '*')).toBe(true);
    expect(globPatternIsSubset('foo-*', '*')).toBe(true);
    expect(globPatternIsSubset('a*b*c', '*')).toBe(true);
  });

  it('admits literal child under wildcard parent', () => {
    expect(globPatternIsSubset('summarizer-1', 'summarizer-*')).toBe(true);
    expect(globPatternIsSubset('cas://abc', 'cas://*')).toBe(true);
  });

  it('admits child glob that extends parent glob', () => {
    expect(globPatternIsSubset('summarizer-narrow-*', 'summarizer-*')).toBe(true);
  });

  it('rejects child broader than parent', () => {
    expect(globPatternIsSubset('*', 'foo-*')).toBe(false);
    expect(globPatternIsSubset('foo-*', 'foo-bar')).toBe(false);
  });

  it('rejects unrelated patterns', () => {
    expect(globPatternIsSubset('summarizer-x', 'validator-*')).toBe(false);
    expect(globPatternIsSubset('foo', 'bar')).toBe(false);
  });
});

describe('patternListIsSubset', () => {
  it('empty child satisfies any parent', () => {
    expect(patternListIsSubset(undefined, undefined)).toBe(true);
    expect(patternListIsSubset([], undefined)).toBe(true);
    expect(patternListIsSubset([], ['foo'])).toBe(true);
  });

  it('non-empty child requires non-empty parent', () => {
    expect(patternListIsSubset(['foo'], undefined)).toBe(false);
    expect(patternListIsSubset(['foo'], [])).toBe(false);
  });

  it('admits when every child is admissible by some parent', () => {
    expect(patternListIsSubset(['summarizer-1', 'summarizer-2'], ['summarizer-*'])).toBe(true);
    expect(patternListIsSubset(['cas://abc', 'cas://def'], ['cas://*'])).toBe(true);
  });

  it('rejects when even one child escapes parent', () => {
    expect(patternListIsSubset(['summarizer-1', 'evil-agent'], ['summarizer-*'])).toBe(false);
  });

  it('admits when child reuses a literal that is in parent', () => {
    expect(patternListIsSubset(['validator'], ['summarizer-*', 'validator'])).toBe(true);
  });
});
