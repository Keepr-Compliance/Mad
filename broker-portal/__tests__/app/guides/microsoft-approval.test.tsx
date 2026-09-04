/**
 * Public Microsoft approval guide — BACKLOG-3092, trimmed by BACKLOG-3097.
 *
 * This page is sent to a prospective customer's IT department to persuade them
 * to approve an OAuth grant, so the properties that make it usable are asserted
 * here rather than eyeballed:
 *
 *   1. It sits outside the middleware's protected prefix (an IT admin reading it
 *      has no Keepr session). The end-to-end proof is a cookie-less fetch against
 *      a production build — recorded in the PR — paired with a /dashboard fetch
 *      that DOES redirect, so the pair discriminates. This file guards the
 *      source-level precondition that makes that fetch pass.
 *   2. Every internal link on it resolves to a real route file.
 *   3. It makes no claim about SSO, JIT or SCIM — the three things
 *      /guides/sso-setup asserts today that are not true.
 *   4. Nothing under app/ or components/ links to /guides/sso-setup any more, so
 *      that page is unreachable by navigation without being deleted.
 *   5. No customer identifier (tenant GUID, org UUID) is embedded in the page.
 *   6. BACKLOG-3097: the sentences the founder cut stay cut, and the page keeps
 *      its shape — Prerequisites (the gate) first, then ONE approval section
 *      with the Settings route as a fallback inside it rather than a second
 *      parallel route with its own heading.
 */

import { createHash } from 'crypto';
import { readFileSync } from 'fs';
import { join } from 'path';
import { render } from '@testing-library/react';
import '@testing-library/jest-dom';

import MicrosoftApprovalGuidePage, { metadata } from '@/app/guides/microsoft-approval/page';
// BACKLOG-3097: these lived here until /help needed the same route resolution.
// `__tests__/app/help/page.test.tsx` is the second caller.
import {
  APP_DIR,
  COMPONENTS_DIR,
  PORTAL_ROOT,
  internalHrefs,
  resolveRoute,
  sourceFiles,
  stripComments,
} from '../../helpers/appRoutes';

const GUIDE_PAGE = join(APP_DIR, 'guides', 'microsoft-approval', 'page.tsx');

const guideSource = readFileSync(GUIDE_PAGE, 'utf8');

/** The sentences BACKLOG-3097 cut. Each explained rather than instructed. */
const CUT_SENTENCES = [
  // Described what /setup does internally, and advertised BACKLOG-3096.
  'Creates your Keepr account and makes it an administrator',
  'joining the one already registered for your Microsoft tenant',
  // An IT admin already knows this.
  'Personal Microsoft accounts',
  // Who can see what.
  'card is shown only to a Keepr account',
  // Interpreted a Microsoft screen the reader is looking at themselves.
  'all users in your organization',
  // Consequence with the action buried at the end; the button it describes is
  // itself being removed by BACKLOG-3090.
  'Skip for now',
  // Restated the page's own purpose above the first instruction.
  'for transaction auditing',
  // Mechanism.
  'the button inside the portal is what identifies',
  'it is not a live read of Microsoft',
];

describe('/guides/microsoft-approval — BACKLOG-3092, trimmed by BACKLOG-3097', () => {
  describe('reachable without a Keepr session', () => {
    // The middleware gates on a path prefix. If /guides ever falls inside it,
    // an IT admin with no account gets bounced to /login and the page is
    // useless — which is the whole reason this route exists.
    const middleware = readFileSync(join(PORTAL_ROOT, 'middleware.ts'), 'utf8');

    it('the protected-route prefix does not cover /guides', () => {
      const prefixes = [...middleware.matchAll(/pathname\.startsWith\('([^']+)'\)/g)].map(
        (m) => m[1]
      );

      expect(prefixes.length).toBeGreaterThan(0);
      expect(prefixes).toContain('/dashboard');
      for (const prefix of prefixes) {
        expect('/guides/microsoft-approval'.startsWith(prefix)).toBe(false);
      }
    });

    it('is not named as an auth route that redirects a signed-in user away', () => {
      const authRoutes = [...middleware.matchAll(/pathname === '([^']+)'/g)].map((m) => m[1]);
      expect(authRoutes).not.toContain('/guides/microsoft-approval');
    });

    it('the route file exists where the App Router will serve it', () => {
      expect(resolveRoute('/guides/microsoft-approval')).toBe(GUIDE_PAGE);
    });

    it('keeps its path after the retitle — the URL is already in a prospect’s inbox', () => {
      // BACKLOG-3097 renamed the page, not the route. The h1 and the browser
      // title move together; /guides/microsoft-approval does not move at all,
      // and no redirect stands in for it.
      const { container } = render(<MicrosoftApprovalGuidePage />);

      expect(container.querySelector('h1')?.textContent?.trim()).toBe(
        'Connecting Keepr to Entra ID (Microsoft 365)'
      );
      expect(metadata.title).toBe('Connecting Keepr to Entra ID (Microsoft 365) - Keepr');
      expect(resolveRoute('/guides/microsoft-approval')).toBe(GUIDE_PAGE);
      expect(resolveRoute('/guides/connecting-keepr-to-entra-id')).toBeNull();
    });
  });

  describe('every internal link resolves', () => {
    const hrefs = internalHrefs(guideSource);

    it('finds the links it is supposed to be checking', () => {
      // Pre-registered so a regex that silently matches nothing cannot pass.
      expect(hrefs.sort()).toEqual(['/dashboard/settings', '/login', '/setup']);
    });

    it.each(hrefs)('%s resolves to a route file', (href) => {
      expect(resolveRoute(href)).not.toBeNull();
    });

    it('the support link is absolute and points at the public ticket form', () => {
      // Absolute on purpose: this page's text gets pasted into email, where a
      // relative href is dead. That puts it outside internalHrefs, so the route
      // behind it is asserted here instead — and /support/new must resolve,
      // because the reader filing a ticket has no Keepr account.
      expect(guideSource).toContain('href="https://app.keeprcompliance.com/support/new"');
      expect(resolveRoute('/support/new')).not.toBeNull();
      expect(guideSource).not.toContain('mailto:');
    });

    it('offers no way "back" to a page the reader never came from', () => {
      // BACKLOG-3097: a "Back to Help" breadcrumb sat above the title. Readers
      // reach this page from a link in an email forwarded to their IT team, so
      // "back" pointed at a page they had never visited and implied history
      // they did not have. The page stands alone.
      const { container } = render(<MicrosoftApprovalGuidePage />);

      expect(container.textContent ?? '').not.toContain('Back to Help');
      expect(hrefs).not.toContain('/help');
      expect(
        [...container.querySelectorAll('a[href]')].map((a) => a.getAttribute('href'))
      ).not.toContain('/help');
    });

    it('does not link to a route that was removed or never existed', () => {
      for (const dead of ['/guides/scim-provisioning', '/guides/admin-consent', '/guides']) {
        expect(resolveRoute(dead)).toBeNull();
        expect(hrefs).not.toContain(dead);
      }
    });
  });

  describe('makes no claim about SSO, JIT or SCIM', () => {
    it('the rendered text mentions none of them', () => {
      const { container } = render(<MicrosoftApprovalGuidePage />);
      const text = container.textContent ?? '';

      expect(text.length).toBeGreaterThan(2000);
      expect(text).not.toMatch(/\bSSO\b/i);
      expect(text).not.toMatch(/single sign-?on/i);
      expect(text).not.toMatch(/\bSCIM\b/i);
      expect(text).not.toMatch(/\bJIT\b/i);
      expect(text).not.toMatch(/just-?in-?time/i);
      expect(text).not.toMatch(/provisioning/i);
    });

    it('renders the substance an IT reviewer is looking for', () => {
      const { container } = render(<MicrosoftApprovalGuidePage />);
      const text = container.textContent ?? '';

      // Named after the system, not the action (BACKLOG-3097). The route is
      // deliberately NOT renamed with it: /guides/microsoft-approval is live in
      // a prospect's inbox.
      expect(text).toContain('Connecting Keepr to Entra ID (Microsoft 365)');
      expect(text).not.toContain('Approving Keepr for Microsoft Outlook');
      expect(text).toContain('Desktop App Permissions');
      // The shape of the grant, which is what replaces the enumeration.
      expect(text).toMatch(/read permissions only/i);
      expect(text).toMatch(/no application-level permission/i);
      expect(text).toMatch(/credential store/i);
      // What an admin's users experience after a revoke. Traced to
      // microsoftAuthService.refreshToken (invalid_grant is preserved) ->
      // emailSyncService.classifyProviderError, which returns
      // "Your email connection has expired. Please reconnect in Settings."
      expect(text).toMatch(/keeps working\s+for about an hour/i);
      expect(text).toMatch(/reconnect in Settings/i);
    });

    it('leads with Prerequisites, then one approval section', () => {
      // Prerequisites is the gate. A reader without one of those roles must
      // stop there rather than discover it at step 4.
      const { container } = render(<MicrosoftApprovalGuidePage />);
      const headings = [...container.querySelectorAll('h2')].map((h) => h.textContent?.trim());

      expect(headings).toEqual([
        'Prerequisites',
        'Approving Keepr',
        'What is granted',
        'Troubleshooting',
      ]);
    });

    it('names exactly the four roles that can grant it, Global Administrator first', () => {
      // Verified 2026-09-04 against the app registration: with Mail.Send
      // (Application) removed, every remaining permission is delegated and none
      // is "Admin consent required: Yes", so all four suffice. Asserted as an
      // exact ordered SET, not as four independent toContain calls, so neither
      // a dropped role nor a smuggled-in fifth one can pass.
      const { container } = render(<MicrosoftApprovalGuidePage />);
      const roles = [...container.querySelectorAll('ul li')].map((li) => li.textContent?.trim());

      expect(roles).toEqual([
        'Global Administrator',
        'Privileged Role Administrator',
        'Cloud Application Administrator',
        'Application Administrator',
      ]);
    });

    it('offers the setup link first and Settings as its fallback, not a second route', () => {
      const { container } = render(<MicrosoftApprovalGuidePage />);
      const text = container.textContent ?? '';

      expect(text).toMatch(/Go to\s*\/setup\s*and sign in with your work Microsoft account/);
      expect(text).toContain('If that does not work, do it manually from Settings');
      // The two parallel route headings this replaced.
      expect(text).not.toContain('If you don');
      expect(text).not.toContain('If you already have');
      // Five numbered steps, still one list.
      expect(container.querySelectorAll('ol > li')).toHaveLength(5);
    });

    it.each(CUT_SENTENCES)('no longer says “%s”', (sentence) => {
      const { container } = render(<MicrosoftApprovalGuidePage />);
      expect(container.textContent ?? '').not.toContain(sentence);
    });

    it('lists every granted scope, as an exact ordered set', () => {
      // BACKLOG-3092 removed this list because a hand-written copy of the
      // consent screen drifts out of sync with the app registration.
      // BACKLOG-3097 restores it as a table so an IT reviewer can evaluate the
      // grant without clicking through to a consent screen — and pins it here,
      // which is the answer to the original objection: drift fails CI instead
      // of reaching a customer.
      //
      // Asserted as an ordered SET of [scope, description] pairs, not as six
      // independent toContain calls, so a dropped row, a reordered one and a
      // smuggled-in seventh all go red. Verified against the live consent
      // screen on 2026-09-03, after Mail.Send (Application) was removed from
      // the registration.
      const { container } = render(<MicrosoftApprovalGuidePage />);
      const rows = [...container.querySelectorAll('tbody tr')].map((row) =>
        [...row.querySelectorAll('td')].map((cell) => cell.textContent?.trim())
      );

      expect(rows).toEqual([
        ['User.Read', "Sign in and read the user's own profile"],
        ['offline_access', 'Keep the connection active without prompting again'],
        ['Mail.Read', "Read the signed-in user's mail, to build the audit trail"],
        ['Mail.Read.Shared', 'Read shared mailboxes that user already has access to'],
        [
          'Contacts.Read',
          "Read the signed-in user's contacts, to identify transaction participants",
        ],
        ['Contacts.Read.Shared', 'Read shared contacts that user already has access to'],
      ]);
    });

    it('grants nothing that can write, send or act without a signed-in user', () => {
      // The property the table is really claiming. Read off the rendered scope
      // column rather than the source constant, so a row added straight into
      // the JSX is caught too.
      const { container } = render(<MicrosoftApprovalGuidePage />);
      const scopes = [...container.querySelectorAll('tbody tr td:first-child')].map((cell) =>
        cell.textContent?.trim()
      );

      expect(scopes.length).toBe(6);
      for (const scope of scopes) {
        expect(scope).toMatch(/^(User\.Read|offline_access|(Mail|Contacts)\.Read(\.Shared)?)$/);
        expect(scope).not.toMatch(/Send|Write|ReadWrite|\.All$/);
      }
    });

    it('shows the permissions in a table, in a container that can scroll', () => {
      // A six-row two-column table on a 375px phone overflows. It must scroll
      // inside its own container rather than making the page scroll sideways.
      const { container } = render(<MicrosoftApprovalGuidePage />);
      const table = container.querySelector('table');

      expect(table).not.toBeNull();
      expect(table?.parentElement?.className).toContain('overflow-x-auto');
      expect([...container.querySelectorAll('thead th')].map((th) => th.textContent?.trim())).toEqual(
        ['Permission', 'What it allows']
      );
    });

    it('makes no reassuring claim about where data goes', () => {
      const { container } = render(<MicrosoftApprovalGuidePage />);
      const text = container.textContent ?? '';

      // The data-flow section was cut deliberately: an approval guide is the
      // wrong place for it, and the honest version needs more room than this
      // page should give it. Saying NOTHING is the decision, so the guard is
      // that the page never gains a partial or false reassurance instead.
      // Transaction submissions upload message content by design, and audit-log
      // entries carry names and property addresses today (BACKLOG-3052) — every
      // phrase below would therefore be a lie on a public page.
      expect(text).not.toMatch(/never leaves (your|the|their) (computer|device|machine)/i);
      expect(text).not.toMatch(/nothing (is sent|reaches|leaves|is uploaded)/i);
      expect(text).not.toMatch(/no data (is sent|reaches|leaves|is uploaded)/i);
      expect(text).not.toMatch(/stays? (entirely |only )?on (your|their|the employee)/i);
      expect(text).not.toMatch(/we (never|do not) (see|store|upload|receive)/i);
    });
  });

  describe('/guides/sso-setup is unreachable by navigation', () => {
    // Enumerated, not sampled: every source file the portal renders.
    const files = [
      ...sourceFiles(APP_DIR, (path) => path.includes(join('guides', 'sso-setup'))),
      ...sourceFiles(COMPONENTS_DIR),
    ];

    it('scans the whole rendered surface', () => {
      expect(files.length).toBeGreaterThan(30);
      expect(files.some((f) => f.endsWith(join('app', 'help', 'page.tsx')))).toBe(true);
    });

    it('no file under app/ or components/ links to it', () => {
      const offenders = files.filter((file) =>
        stripComments(readFileSync(file, 'utf8')).includes('sso-setup')
      );
      expect(offenders).toEqual([]);
    });

    it('the comment-stripping cannot hide a real link', () => {
      // Control for the assertion above: prose is ignored, code is not.
      expect(stripComments('// see /guides/sso-setup for why')).not.toContain('sso-setup');
      expect(stripComments('{/* /guides/sso-setup */}')).not.toContain('sso-setup');
      expect(stripComments("href='/guides/sso-setup'")).toContain('sso-setup');
      expect(stripComments('const p = `/guides/${"sso-setup"}`;')).toContain('sso-setup');
      expect(stripComments("redirect('https://x/guides/sso-setup')")).toContain('sso-setup');
    });

    it('the page itself is still served — unlinked, not deleted', () => {
      expect(resolveRoute('/guides/sso-setup')).not.toBeNull();
    });

    it('its dead SCIM link is gone', () => {
      const ssoSource = readFileSync(
        join(APP_DIR, 'guides', 'sso-setup', 'page.tsx'),
        'utf8'
      );
      expect(internalHrefs(ssoSource)).not.toContain('/guides/scim-provisioning');
    });
  });

  describe('the "last updated" date cannot go stale unnoticed', () => {
    // The date is hardcoded (see the comment on LAST_UPDATED in the page: a git
    // date is not derivable at build OR render time on Vercel, and a silently
    // wrong date on a security page is worse than no date). This is the guard
    // that makes hardcoding safe: the file's fingerprint is pinned, so ANY edit
    // to the page fails here until the date is reviewed and the fingerprint
    // re-pinned. If you are reading this because the test went red: update
    // LAST_UPDATED in the page if the change is user-visible, then paste the
    // fingerprint the failure prints below.
    const PINNED_FINGERPRINT = 'c617e615e5e0a311';
    const PINNED_DATE = 'September 4, 2026';

    it('renders the date directly under the title', () => {
      const { container } = render(<MicrosoftApprovalGuidePage />);
      const text = container.textContent ?? '';

      expect(text).toContain(`Last updated ${PINNED_DATE}`);
      // Under the title, above the first section.
      expect(text.indexOf('Last updated')).toBeGreaterThan(
        text.indexOf('Connecting Keepr to Entra ID')
      );
      expect(text.indexOf('Last updated')).toBeLessThan(text.indexOf('Prerequisites'));
    });

    it('claims a date that has actually happened', () => {
      // One day of slack, because the date is a calendar day and the runner's
      // clock is not: "September 4, 2026" parses to local midnight, which is
      // still ahead of a machine sitting in UTC-7 on the UTC morning of the
      // 4th. Anything beyond a day ahead is a typo or a copied-forward date.
      const ONE_DAY_MS = 24 * 60 * 60 * 1000;
      const claimed = new Date(PINNED_DATE);

      expect(Number.isNaN(claimed.getTime())).toBe(false);
      expect(claimed.getTime()).toBeLessThanOrEqual(Date.now() + ONE_DAY_MS);
    });

    it('the page has not changed since that date was last reviewed', () => {
      // Fingerprinted on what a READER sees — rendered text plus the two
      // metadata strings — not on the source bytes. A source-byte pin fires on
      // a comment typo, which trains people to re-pin without reviewing the
      // date, and a guard everyone reflexively silences guards nothing.
      const { container } = render(<MicrosoftApprovalGuidePage />);
      const visible = [
        container.textContent ?? '',
        String(metadata.title),
        String(metadata.description),
      ].join('\u0000');
      const fingerprint = createHash('sha256').update(visible).digest('hex').slice(0, 16);

      expect(fingerprint).toBe(PINNED_FINGERPRINT);
    });
  });

  describe('carries no customer identifier', () => {
    const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
    // Keepr's own desktop app registration. Public by design: Microsoft shows it
    // in the address bar of every consent screen.
    // pii-allow-uuid: Keepr's own OAuth application (client) id, public by design — not a record id, names no customer or tenant
    const OUR_CLIENT_ID = '3a6c341a-17ab-4739-977d-a7d71b27f945';

    it('the only GUID in the source is our own public client id', () => {
      const guids = [...new Set(guideSource.match(UUID) ?? [])];
      expect(guids).toEqual([OUR_CLIENT_ID]);
    });

    it('uses the generic organizations tenant so one link serves every customer', () => {
      expect(guideSource).toContain('login.microsoftonline.com/organizations/adminconsent');
    });
  });
});
