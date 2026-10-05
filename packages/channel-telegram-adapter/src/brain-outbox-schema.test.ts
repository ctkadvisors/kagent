/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

import { readFileSync } from 'node:fs';
import { loadYaml } from '@kubernetes/client-node';
import { describe, expect, it } from 'vitest';

interface Schema {
  readonly type?: string;
  readonly required?: readonly string[];
  readonly properties?: Record<string, Schema>;
  readonly items?: Schema;
}
interface Crd {
  readonly spec: {
    readonly versions: readonly { readonly schema: { readonly openAPIV3Schema: Schema } }[];
  };
}

describe('persisted brain outbox CRD', () => {
  it.each([
    'manifests/crds/channelsessions.yaml',
    'charts/kagent-operator/crds/channelsessions.yaml',
  ])('retains the sealed episode and independent intake watermark in %s', (path) => {
    const crd = loadYaml<Crd>(
      readFileSync(new URL('../../operator/' + path, import.meta.url), 'utf8'),
    );
    const status = crd.spec.versions[0]?.schema.openAPIV3Schema.properties?.['status'];
    const outbox = status?.properties?.['brainOutbox'];
    expect(outbox?.type).toBe('array');
    expect(outbox?.items?.required).toEqual(
      expect.arrayContaining(['taskRef', 'episode', 'attempts']),
    );
    expect(outbox?.items?.properties?.['episode']?.required).toEqual(
      expect.arrayContaining(['uuid', 'name', 'body', 'referenceTime']),
    );
    expect(status?.properties?.['lastRememberedTaskRef']?.required).toEqual(
      expect.arrayContaining(['namespace', 'name']),
    );
  });
});
