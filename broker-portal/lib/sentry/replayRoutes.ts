/**
 * Pages where browser session replay does not record (BACKLOG-4259): the
 * OAuth routes and the AI apps pages, including the connect page under them.
 *
 * Three parts, all here so they can be tested without a browser:
 * - isReplayExcludedPath: the path rule.
 * - clientReplayIntegrations: the replay integration is not added when the
 *   page that loads first is excluded.
 * - replayRecordingFilter: replay's beforeAddRecordingEvent hook; drops the
 *   SDK's own recording events (breadcrumbs, navigation, network) while the
 *   current page is excluded.
 * Client-side navigation onto an excluded page stops replay without sending
 * what it buffered (components/sentry/ReplayOff.tsx).
 */

const EXCLUDED_PREFIXES = ['/oauth', '/dashboard/account/ai-apps'] as const;

export function isReplayExcludedPath(pathname: string): boolean {
  return EXCLUDED_PREFIXES.some((p) => pathname === p || pathname.startsWith(`${p}/`));
}

function currentPath(): string {
  return typeof window === 'undefined' ? '' : window.location.pathname;
}

export function replayRecordingFilter<E>(event: E): E | null {
  return isReplayExcludedPath(currentPath()) ? null : event;
}

export function clientReplayIntegrations<I>(
  make: (_opts: { beforeAddRecordingEvent: typeof replayRecordingFilter }) => I,
  pathname: string = currentPath()
): I[] {
  if (isReplayExcludedPath(pathname)) return [];
  return [make({ beforeAddRecordingEvent: replayRecordingFilter })];
}
