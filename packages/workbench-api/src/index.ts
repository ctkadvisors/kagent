/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/**
 * `@kagent/workbench-api` — public entry. Re-exports the testable
 * building blocks so harness/test code (and any future custom embed)
 * can compose the cache + router + broker without booting `main.ts`.
 */

export { SnapshotCache, cacheKey } from './cache.js';
export type { CacheChangeEvent, CacheKey, CacheListener } from './cache.js';

export { SseBroker, formatCacheEvent, formatHeartbeat } from './sse.js';
export type { Subscription, SubscriberSink, WireEvent } from './sse.js';

export { buildRouter } from './router.js';
export type { RouterDeps } from './router.js';

export { startServer } from './server.js';
export type { ServerHandle, ServerOptions } from './server.js';

export { createInformerSet } from './informer.js';
export type { InformerDeps, InformerSet } from './informer.js';

export { tasksRoute } from './routes/tasks.js';
export { agentsRoute } from './routes/agents.js';
export { channelsRoute } from './routes/channels.js';
export { streamRoute } from './routes/stream.js';
export { healthzRoute } from './routes/healthz.js';
