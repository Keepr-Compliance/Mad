/**
 * BACKLOG-3896: one source for the page titles shown in the phone top bar.
 *
 * Pages whose heading is a fixed string import it from PAGE_TITLES, so the top
 * bar and the page heading cannot drift apart. Detail pages (a record's own
 * name is their heading) get the short generic title below instead.
 *
 * Submissions pages are deliberately absent: they keep their own heading and
 * the wordmark top bar until PR #2961 lands.
 */
export const PAGE_TITLES = {
  dashboard: 'Dashboard',
  users: 'Users Management',
  settings: 'Settings',
  scim: 'SCIM Provisioning',
  account: 'My Account',
  support: 'Support',
  supportNew: 'Submit a Support Request',
  checklists: 'Checklists',
  myTransactions: 'My Transactions',
} as const;

/** Exact-path titles, relative to /dashboard. */
const EXACT: Record<string, string> = {
  '': PAGE_TITLES.dashboard,
  '/users': PAGE_TITLES.users,
  '/settings': PAGE_TITLES.settings,
  '/settings/scim': PAGE_TITLES.scim,
  '/account': PAGE_TITLES.account,
  '/support': PAGE_TITLES.support,
  '/support/new': PAGE_TITLES.supportNew,
  '/checklists': PAGE_TITLES.checklists,
  '/checklists/new': 'Checklist',
  '/my-transactions': PAGE_TITLES.myTransactions,
};

/** One-segment detail routes: /dashboard/<section>/<id>. */
const DETAIL: Record<string, string> = {
  users: 'User',
  support: 'Ticket',
  checklists: 'Checklist',
  'my-transactions': 'Transaction',
};

/** Title for the phone top bar, or undefined to keep the wordmark. */
export function getPhoneTitle(pathname: string | null | undefined): string | undefined {
  if (!pathname) return undefined;
  const m = pathname.replace(/\/+$/, '').match(/^\/dashboard(\/.*)?$/);
  if (!m) return undefined;
  const rest = m[1] ?? '';
  if (rest in EXACT) return EXACT[rest];
  const seg = rest.split('/').filter(Boolean);
  if (seg.length === 2 && seg[0] in DETAIL) return DETAIL[seg[0]];
  return undefined;
}
