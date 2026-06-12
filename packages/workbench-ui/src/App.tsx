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
 *   - `#/channels`                    → ChannelsPage
 *   - `#/command`                     → CommandView (RTS command center)
 *   - `#/review`                      → ReviewPage (Phase 4 / REV-02 reviewer entry point)
 */

import { useEffect, useState } from 'react';

import { AppShell } from './AppShell.js';
import { ArchitectPage } from './ArchitectPage.js';
import { ChannelsPage } from './ChannelsPage.js';
import { ClusterPage } from './ClusterPage.js';
import { CommandView } from './CommandView.js';
import { GatewayPage } from './GatewayPage.js';
import { ReviewPage } from './ReviewPage.js';
import { SessionsPage } from './SessionsPage.js';
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

interface ChannelsRoute {
  readonly kind: 'channels';
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

interface SessionsRoute {
  readonly kind: 'sessions';
  readonly sessionId?: string;
}

type Route =
  | DetailRoute
  | ListRoute
  | GatewayRoute
  | ClusterRoute
  | ChannelsRoute
  | CommandRoute
  | ReviewRoute
  | ArchitectRoute
  | SessionsRoute;

function parseHash(hash: string): Route {
  // Strip leading `#` and any leading `/`. Tolerate trailing slashes.
  const clean = hash.replace(/^#\/?/, '').replace(/\/$/, '');
  if (clean === '') return { kind: 'list' };
  if (clean === 'gateway') return { kind: 'gateway' };
  if (clean === 'cluster') return { kind: 'cluster' };
  if (clean === 'channels') return { kind: 'channels' };
  if (clean === 'command') return { kind: 'command' };
  if (clean === 'review') return { kind: 'review' };
  if (clean === 'architect') return { kind: 'architect' };
  if (clean === 'sessions') return { kind: 'sessions' };
  const parts = clean.split('/');
  if (parts[0] === 'sessions' && parts.length === 2 && parts[1] !== undefined) {
    return { kind: 'sessions', sessionId: decodeURIComponent(parts[1]) };
  }
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

const goHome = (): void => {
  window.location.hash = '#/';
};

export function App(): React.JSX.Element {
  const route = useHashRoute();

  // The Command Center renders full-bleed (no shell): it is an immersive
  // RTS canvas with its own chrome, and a fixed left rail would shrink
  // the map. Every other route lives inside the shared shell.
  if (route.kind === 'command') {
    return <CommandView onBack={goHome} />;
  }

  let content: React.JSX.Element;
  if (route.kind === 'detail') {
    content = <TaskDetail namespace={route.namespace} name={route.name} onBack={goHome} />;
  } else if (route.kind === 'gateway') {
    content = <GatewayPage onBack={goHome} />;
  } else if (route.kind === 'cluster') {
    content = <ClusterPage onBack={goHome} />;
  } else if (route.kind === 'channels') {
    content = <ChannelsPage />;
  } else if (route.kind === 'review') {
    content = <ReviewPage onBack={goHome} />;
  } else if (route.kind === 'architect') {
    content = <ArchitectPage onBack={goHome} />;
  } else if (route.kind === 'sessions') {
    content =
      route.sessionId !== undefined ? (
        <SessionsPage initialSessionId={route.sessionId} />
      ) : (
        <SessionsPage />
      );
  } else {
    content = <TaskList />;
  }

  return <AppShell>{content}</AppShell>;
}
