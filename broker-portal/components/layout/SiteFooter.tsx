/**
 * Portal footer with legal links (BACKLOG-2126 portal slice).
 *
 * Links point at the CANONICAL, forward-looking legal URLs on the marketing
 * domain (https://keeprcompliance.com/{privacy,terms,cookies}). Those pages are
 * hosted by the landing repo — pointing the root domain at the published pages
 * is a founder-ops dependency (noted in the PR). The Cookie link additionally
 * offers the in-portal `/cookies` route (the consent-banner destination) so the
 * mechanism has a live target even before the marketing pages go up.
 *
 * Intentionally a plain server component (no client state) — it renders the same
 * links everywhere and can sit inside any layout.
 */

const LEGAL_LINKS = [
  { label: 'Privacy', href: 'https://keeprcompliance.com/privacy' },
  { label: 'Terms', href: 'https://keeprcompliance.com/terms' },
  { label: 'Cookies', href: 'https://keeprcompliance.com/cookies' },
] as const;

export function SiteFooter() {
  return (
    <footer className="border-t border-gray-200 bg-white px-6 py-4">
      <div className="mx-auto flex max-w-5xl flex-col items-center justify-between gap-2 text-xs text-gray-500 sm:flex-row">
        <span>&copy; {new Date().getFullYear()} Keepr</span>
        <nav aria-label="Legal" className="flex items-center gap-4">
          {LEGAL_LINKS.map((link) => (
            <a
              key={link.label}
              href={link.href}
              className="hover:text-gray-700 hover:underline"
            >
              {link.label}
            </a>
          ))}
        </nav>
      </div>
    </footer>
  );
}
