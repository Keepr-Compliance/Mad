/**
 * The public help page — BACKLOG-3097.
 *
 * `/help` is public and is where a prospect's IT department is pointed. It
 * shipped nine articles, seven of which took the reader nowhere useful: four
 * SCIM entries and an "IT Admin Guides Overview" pointed at routes that have
 * never existed (`/guides/scim-provisioning`, `/guides` — both 404), and two
 * more dressed an application screen as documentation (`/setup`,
 * `/dashboard/users`). This file is the guard that stops any of that returning.
 *
 * THE LINKS ARE READ OFF THE RENDERED DOM, NOT THE SOURCE. `/help` declares its
 * links as `href: '/…'` object properties and renders `<Link href={article.href}>`,
 * so the source-level `href="…"` regex that guards the approval guide matches
 * NOTHING here. A test built on it would pass on an empty set — asserting over
 * zero links while every one of them 404s. `hrefs are derived from the DOM`
 * below is that control, made explicit: it asserts the source regex really does
 * come back empty for this page, so the reason for the DOM approach cannot be
 * quietly lost.
 *
 * Both link branches are exercised: the article list, and the "no results"
 * state, whose contact-support link only exists when a search matches nothing.
 */

import { readFileSync } from 'fs';
import { join } from 'path';

import { render, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom';

import HelpPage from '@/app/help/page';
import {
  APP_DIR,
  COMPONENTS_DIR,
  internalHrefs,
  readSource,
  renderedHrefs,
  resolveRoute,
  sourceFiles,
  stripComments,
} from '../../helpers/appRoutes';

const helpSource = readSource('app', 'help', 'page.tsx');

/** Routes named on this page's history that the App Router cannot serve. */
const DEAD_ROUTES = ['/guides/scim-provisioning', '/guides'];

/** Titles removed by BACKLOG-3097. None may render again without a live route. */
const REMOVED_TITLES = [
  'Automatic User Provisioning (SCIM)',
  'How to Configure SCIM for Your Organization',
  'How to Generate a SCIM Token',
  'How SCIM User Provisioning Works',
  'IT Admin Guides Overview',
  'Set Up Your Organization',
  'Managing User Roles',
];

/** Render, then type a query that matches no article, to reach the empty state. */
function renderWithNoResults() {
  const { container } = render(<HelpPage />);
  const input = container.querySelector('input');
  if (!input) throw new Error('help page rendered no search input');
  fireEvent.change(input, { target: { value: 'zzzznotanarticlezzzz' } });
  return container;
}

describe('BACKLOG-3097 — /help', () => {
  describe('reachable without a Keepr session', () => {
    // An IT admin reading this page has no Keepr account. If /help ever falls
    // inside the middleware's protected prefix they are bounced to /login.
    const middleware = readSource('middleware.ts');

    it('the protected-route prefix does not cover /help', () => {
      const prefixes = [...middleware.matchAll(/pathname\.startsWith\('([^']+)'\)/g)].map(
        (m) => m[1]
      );

      expect(prefixes.length).toBeGreaterThan(0);
      expect(prefixes).toContain('/dashboard');
      for (const prefix of prefixes) {
        expect('/help'.startsWith(prefix)).toBe(false);
      }
    });

    it('the route file exists where the App Router will serve it', () => {
      expect(resolveRoute('/help')).not.toBeNull();
    });
  });

  describe('hrefs are derived from the DOM', () => {
    it('the source-level regex sees none of this page’s article links', () => {
      // The control for this whole file. Every article link is built from a
      // variable (`<Link href={article.href}>`), so the regex used on the
      // approval guide cannot see one — it finds only the two literal
      // support-form hrefs. A test built on it would have asserted over that
      // set while all four SCIM links 404'd underneath.
      expect(internalHrefs(helpSource)).toEqual(['/support/new']);
      expect(internalHrefs(helpSource)).not.toContain('/guides/microsoft-approval');
      expect(internalHrefs(helpSource)).not.toContain('/download');
    });

    it('the DOM extraction finds links the regex cannot', () => {
      const { container } = render(<HelpPage />);
      expect(renderedHrefs(container).length).toBeGreaterThan(internalHrefs(helpSource).length);
    });
  });

  describe('every link resolves', () => {
    it('renders exactly the pre-registered set of links', () => {
      // Pre-registered so an empty render — or a filter that hides everything —
      // cannot pass as "no dead links".
      const { container } = render(<HelpPage />);
      expect(renderedHrefs(container)).toEqual([
        '/download',
        '/guides/microsoft-approval',
        '/support/new',
      ]);
    });

    it('renders the pre-registered set in the no-results state too', () => {
      const container = renderWithNoResults();
      expect(container.textContent).toContain('No articles found');
      expect(renderedHrefs(container)).toEqual(['/support/new']);
    });

    it.each(['/download', '/guides/microsoft-approval', '/support/new'])(
      '%s resolves to a route file',
      (href) => {
        expect(resolveRoute(href)).not.toBeNull();
      }
    );

    it('resolveRoute can tell a live route from a dead one', () => {
      // Without this, "every link resolves" would also pass if resolveRoute
      // returned non-null for everything.
      for (const dead of DEAD_ROUTES) {
        expect(resolveRoute(dead)).toBeNull();
      }
    });

    it('links to no route the App Router cannot serve', () => {
      const { container } = render(<HelpPage />);
      const hrefs = [...renderedHrefs(container), ...renderedHrefs(renderWithNoResults())];

      for (const href of hrefs) {
        expect(DEAD_ROUTES).not.toContain(href);
        expect(resolveRoute(href)).not.toBeNull();
      }
    });

    it('opens no mail client', () => {
      // The two mailto: links here opened Outlook on the reader's machine and
      // produced nothing anyone could track. /support/new is public, needs no
      // Keepr account, and lands in the support module.
      const { container } = render(<HelpPage />);
      const hrefs = [...renderedHrefs(container), ...renderedHrefs(renderWithNoResults())];

      expect(hrefs.some((href) => href.startsWith('mailto:'))).toBe(false);
      expect(helpSource).not.toContain('mailto:');
    });
  });

  describe('the removed articles are gone', () => {
    it('renders exactly the two surviving articles', () => {
      const { container } = render(<HelpPage />);
      const headings = [...container.querySelectorAll('h2')].map((h) => h.textContent?.trim());

      expect(headings).toEqual([
        'Connecting Keepr to Entra ID (Microsoft 365)',
        'Download the Desktop App',
      ]);
    });

    it.each(REMOVED_TITLES)('does not render “%s”', (title) => {
      const { container } = render(<HelpPage />);
      expect(container.textContent ?? '').not.toContain(title);
    });

    it('says nothing about SCIM or provisioning', () => {
      // Asserted on content, not on the href: an article that describes SCIM
      // sells a feature whose endpoint has never been deployed, whatever it
      // links to. It comes back with BACKLOG-2241.
      const { container } = render(<HelpPage />);
      const text = container.textContent ?? '';

      expect(text.length).toBeGreaterThan(100);
      expect(text).not.toMatch(/\bSCIM\b/i);
      expect(text).not.toMatch(/provisioning/i);
    });

    it('a search cannot surface a removed article by its tags', () => {
      // The removed entries carried tags like "scim" and "token". Searching for
      // one must find nothing, not an entry whose title merely lost the word.
      const container = render(<HelpPage />).container;
      const input = container.querySelector('input');
      if (!input) throw new Error('help page rendered no search input');

      for (const term of ['scim', 'provisioning', 'bearer']) {
        fireEvent.change(input, { target: { value: term } });
        expect(container.textContent).toContain('No articles found');
      }
    });
  });

  describe('/guides/scim-provisioning is linked from nowhere in the portal', () => {
    // Enumerated, not sampled. The four /help entries were the last links to a
    // route that has never existed; this stops a fifth appearing anywhere else.
    const files = [...sourceFiles(APP_DIR), ...sourceFiles(COMPONENTS_DIR)];

    it('scans the whole rendered surface', () => {
      expect(files.length).toBeGreaterThan(30);
      expect(files.some((f) => f.endsWith('page.tsx'))).toBe(true);
    });

    it('no file under app/ or components/ links to it', () => {
      const offenders = files.filter((file) =>
        stripComments(readFileSync(file, 'utf8')).includes('scim-provisioning')
      );
      expect(offenders).toEqual([]);
    });

    it('the comment-stripping cannot hide a real link', () => {
      // Control: the sweep above must ignore prose and catch code. The one
      // surviving mention of that route is the JSX comment in
      // app/guides/sso-setup/page.tsx explaining why its link was removed.
      expect(stripComments('{/* /guides/scim-provisioning 404s */}')).not.toContain(
        'scim-provisioning'
      );
      expect(stripComments("href='/guides/scim-provisioning'")).toContain('scim-provisioning');
      expect(readFileSync(join(APP_DIR, 'guides', 'sso-setup', 'page.tsx'), 'utf8')).toContain(
        'scim-provisioning'
      );
    });
  });
});
