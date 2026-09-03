/**
 * Public Microsoft approval guide — BACKLOG-3092.
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
 */

import { readFileSync, readdirSync, existsSync, statSync } from 'fs';
import { join } from 'path';
import { render } from '@testing-library/react';
import '@testing-library/jest-dom';

import MicrosoftApprovalGuidePage from '@/app/guides/microsoft-approval/page';

const PORTAL_ROOT = join(__dirname, '..', '..', '..');
const APP_DIR = join(PORTAL_ROOT, 'app');
const COMPONENTS_DIR = join(PORTAL_ROOT, 'components');
const GUIDE_PAGE = join(APP_DIR, 'guides', 'microsoft-approval', 'page.tsx');

const guideSource = readFileSync(GUIDE_PAGE, 'utf8');

/** Every `href="/…"` literal in a source file, deduplicated, in source order. */
function internalHrefs(source: string): string[] {
  const found = new Set<string>();
  for (const match of source.matchAll(/href=(?:"|'|\{')(\/[^"'`{}\s]*)(?:"|'|'\})/g)) {
    found.add(match[1]);
  }
  return [...found];
}

/**
 * Resolve an App Router path to the file that serves it, honouring dynamic
 * segments (`[id]`, `[...slug]`) and route groups is not needed here, but the
 * dynamic case is, so a missing route can never pass by accident.
 */
function resolveRoute(pathname: string): string | null {
  const segments = pathname.split('/').filter(Boolean);
  let dir = APP_DIR;

  for (const segment of segments) {
    const exact = join(dir, segment);
    if (existsSync(exact) && statSync(exact).isDirectory()) {
      dir = exact;
      continue;
    }
    const dynamic = readdirSync(dir, { withFileTypes: true }).find(
      (entry) => entry.isDirectory() && entry.name.startsWith('[')
    );
    if (!dynamic) return null;
    dir = join(dir, dynamic.name);
  }

  for (const leaf of ['page.tsx', 'page.ts', 'route.ts', 'route.tsx']) {
    const candidate = join(dir, leaf);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * Strip comments so a note *about* a route does not read as a link *to* it.
 * Only whole-line `//` comments are removed, never an inline `//`, so a `https://`
 * inside a string literal survives and stays scannable.
 */
function stripComments(source: string): string {
  return source
    .replace(/\{?\/\*[\s\S]*?\*\/\}?/g, '')
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('//'))
    .join('\n');
}

/** Every .ts/.tsx file under a directory, excluding tests and build output. */
function sourceFiles(root: string, skip: (path: string) => boolean = () => false): string[] {
  if (!existsSync(root)) return [];
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (skip(full)) continue;
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name === '__tests__' || entry.name === '.next') {
          continue;
        }
        walk(full);
      } else if (/\.tsx?$/.test(entry.name)) {
        out.push(full);
      }
    }
  };
  walk(root);
  return out;
}

describe('BACKLOG-3092 — /guides/microsoft-approval', () => {
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
  });

  describe('every internal link resolves', () => {
    const hrefs = internalHrefs(guideSource);

    it('finds the links it is supposed to be checking', () => {
      // Pre-registered so a regex that silently matches nothing cannot pass.
      expect(hrefs.sort()).toEqual(['/dashboard/settings', '/help', '/login', '/setup']);
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

      expect(text).toContain('Approving Keepr for Microsoft Outlook');
      // Both routes, /setup first: most readers arrive from the outreach email,
      // which sends them to /setup, so the first section matches the path they
      // are already on.
      expect(text.indexOf('If you don')).toBeGreaterThan(-1);
      expect(text.indexOf('If you already have')).toBeGreaterThan(-1);
      expect(text.indexOf('If you don')).toBeLessThan(text.indexOf('If you already have'));
      expect(text).toContain('Desktop App Permissions');
      // The roles that can consent.
      expect(text).toContain('Privileged Role Administrator');
      expect(text).toContain('Cloud Application Administrator');
      expect(text).toContain('Application Administrator');
      // The shape of the grant, which is what replaces the enumeration.
      expect(text).toMatch(/every permission is read-only/i);
      expect(text).toMatch(/no application-level permission/i);
      expect(text).toMatch(/credential store/i);
      // The sentence on the Microsoft screen that alarms people.
      expect(text).toMatch(/all users in your organization/i);
      expect(text).toMatch(/delegated/i);
      // What an admin's users actually experience after a revoke. Traced to
      // microsoftAuthService.refreshToken (invalid_grant is preserved) ->
      // emailSyncService.classifyProviderError, which returns
      // "Your email connection has expired. Please reconnect in Settings."
      expect(text).toMatch(/no longer\s+refresh/i);
      expect(text).toMatch(/reconnect\s+in Settings/i);
    });

    it('does not restate the permission list', () => {
      // Microsoft's consent screen is the authority on WHAT is granted. A
      // hand-written copy of that list is what let the app registration drift
      // out of sync with what customers were told, so the page claims the SHAPE
      // of the grant instead and cannot go stale when a permission is renamed.
      const { container } = render(<MicrosoftApprovalGuidePage />);
      const text = container.textContent ?? '';

      for (const displayString of [
        'Sign in and read user profile',
        'Read user mail',
        'Read user contacts',
        'Read user and shared mail',
        'Read user and shared contacts',
        'Maintain access to data you have given it access to',
      ]) {
        expect(text).not.toContain(displayString);
      }
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
