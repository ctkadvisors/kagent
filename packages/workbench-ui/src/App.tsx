/**
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Chris Knuteson
 */

/**
 * Top-level Workbench shell + minimal hash router.
 *
 * Why a hand-rolled hash router instead of react-router: the v0.1
 * Workbench has two routes (list, detail) and zero need for nested
 * routes / layouts / loaders. A 30-line `useHashRoute` hook keeps the
 * UI a leaf with no extra runtime dep — same posture as the rest of
 * the package (react + react-dom only).
 *
 * Routes:
 *   - `#/` (or no hash)               → TaskList
 *   - `#/tasks/<namespace>/<name>`    → TaskDetail
 *   - `#/gateway`                     → GatewayPage (substrate visibility)
 *   - `#/cluster`                     → ClusterPage
 *   - `#/command`                     → CommandView (RTS command center)
 *   - `#/review`                      → ReviewPage (Phase 4 / REV-02 reviewer entry point)
 */

import { useEffect, useState } from 'react';

import { ArchitectPage } from './ArchitectPage.js';
import { ClusterPage } from './ClusterPage.js';
import { CommandView } from './CommandView.js';
import { GatewayPage } from './GatewayPage.js';
import { ReviewPage } from './ReviewPage.js';
import { TaskDetail } from './TaskDetail.js';
import { TaskList } from './TaskList.js';

interface DetailRoute {
  readonly kind: 'detail';
  readonly namespace: string;
  readonly name: string;
}

interface ListRoute {
  readonly kind: 'list';
}

interface GatewayRoute {
  readonly kind: 'gateway';
}

interface ClusterRoute {
  readonly kind: 'cluster';
}

interface CommandRoute {
  readonly kind: 'command';
}

interface ReviewRoute {
  readonly kind: 'review';
}

interface ArchitectRoute {
  readonly kind: 'architect';
}

type Route =
  | DetailRoute
  | ListRoute
  | GatewayRoute
  | ClusterRoute
  | CommandRoute
  | ReviewRoute
  | ArchitectRoute;

function parseHash(hash: string): Route {
  // Strip leading `#` and any leading `/`. Tolerate trailing slashes.
  const clean = hash.replace(/^#\/?/, '').replace(/\/$/, '');
  if (clean === '') return { kind: 'list' };
  if (clean === 'gateway') return { kind: 'gateway' };
  if (clean === 'cluster') return { kind: 'cluster' };
  if (clean === 'command') return { kind: 'command' };
  if (clean === 'review') return { kind: 'review' };
  if (clean === 'architect') return { kind: 'architect' };
  const parts = clean.split('/');
  if (parts.length === 3 && parts[0] === 'tasks') {
    const ns = parts[1];
    const name = parts[2];
    if (typeof ns === 'string' && ns.length > 0 && typeof name === 'string' && name.length > 0) {
      return {
        kind: 'detail',
        namespace: decodeURIComponent(ns),
        name: decodeURIComponent(name),
      };
    }
  }
  // Unknown hash → fall back to list. Matches the SPA "404 to home"
  // posture; the link that produced the bad hash is the bug to fix.
  return { kind: 'list' };
}

function useHashRoute(): Route {
  const [route, setRoute] = useState<Route>(() => parseHash(window.location.hash));
  useEffect(() => {
    const onHashChange = (): void => {
      setRoute(parseHash(window.location.hash));
    };
    window.addEventListener('hashchange', onHashChange);
    return () => {
      window.removeEventListener('hashchange', onHashChange);
    };
  }, []);
  return route;
}

export function App(): React.JSX.Element {
  const route = useHashRoute();
  if (route.kind === 'detail') {
    return (
      <TaskDetail
        namespace={route.namespace}
        name={route.name}
        onBack={() => {
          window.location.hash = '#/';
        }}
      />
    );
  }
  if (route.kind === 'gateway') {
    return (
      <GatewayPage
        onBack={() => {
          window.location.hash = '#/';
        }}
      />
    );
  }
  if (route.kind === 'cluster') {
    return (
      <ClusterPage
        onBack={() => {
          window.location.hash = '#/';
        }}
      />
    );
  }
  if (route.kind === 'command') {
    return (
      <CommandView
        onBack={() => {
          window.location.hash = '#/';
        }}
      />
    );
  }
  if (route.kind === 'review') {
    return (
      <ReviewPage
        onBack={() => {
          window.location.hash = '#/';
        }}
      />
    );
  }
  if (route.kind === 'architect') {
    return (
      <ArchitectPage
        onBack={() => {
          window.location.hash = '#/';
        }}
      />
    );
  }
  return <TaskList />;
}
