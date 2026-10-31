/**
 * Reports index layout preference (BACKLOG-4091).
 *
 * Pure helpers shared by the server page and the client toggle. Precedence:
 * `?view=` first, then the `reports-index-view` cookie, then Cards. Only
 * 'cards' and 'list' are accepted; any other value counts as absent and
 * falls through to the next source.
 */

export type ReportsIndexView = 'cards' | 'list';

export const REPORTS_VIEW_COOKIE = 'reports-index-view';
export const REPORTS_VIEW_PARAM = 'view';
export const REPORTS_INDEX_PANEL_ID = 'reports-index-panel';
export const DEFAULT_REPORTS_INDEX_VIEW: ReportsIndexView = 'cards';

const COOKIE_PATH = '/dashboard/reports';
const COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 365;

export function parseReportsIndexView(value: unknown): ReportsIndexView | null {
  return value === 'cards' || value === 'list' ? value : null;
}

export function resolveReportsIndexView({
  url,
  cookie,
}: {
  url: unknown;
  cookie: unknown;
}): ReportsIndexView {
  return parseReportsIndexView(url) ?? parseReportsIndexView(cookie) ?? DEFAULT_REPORTS_INDEX_VIEW;
}

/** `document.cookie` assignment string for the chosen layout. */
export function reportsViewCookie(view: ReportsIndexView): string {
  return `${REPORTS_VIEW_COOKIE}=${view}; path=${COOKIE_PATH}; max-age=${COOKIE_MAX_AGE_SECONDS}; SameSite=Lax`;
}
