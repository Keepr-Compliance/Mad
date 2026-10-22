/**
 * The only builder of broker-portal URLs that the desktop hands to the browser
 * (BACKLOG-3617, extracted for BACKLOG-3863).
 *
 * Callers name a PAGE, never a path: `portalUrl("billing")`. The renderer never
 * supplies a URL or a path; each page maps to a constant below. The origin
 * comes from `BROKER_PORTAL_URL` and must pass the allow-list:
 *   https://keeprcompliance.com and its subdomains (production)
 *   http(s)://localhost or 127.0.0.1 (the dev portal, .env.example)
 * Anything else — another host (including *.vercel.app previews), another
 * scheme, credentials in the address, a string that does not parse — is
 * refused, so `BROKER_PORTAL_URL` cannot turn a channel into "open any URL".
 *
 * `portalOrigin()` is the same check without a page, for main-process calls
 * that send the user's Bearer token to the portal: the token only ever goes to
 * an allowed origin.
 */

export type PortalPage = "checklists" | "billing";

/** The portal page behind each key. Constant: no caller can choose a path. */
export const PORTAL_PATHS: Readonly<Record<PortalPage, string>> = Object.freeze({
  checklists: "/dashboard/checklists",
  billing: "/dashboard/billing",
});

const DEFAULT_BROKER_PORTAL_URL = "https://app.keeprcompliance.com";

/** The allowed portal origin (no trailing slash), or null when refused. */
export function portalOrigin(
  configured: string | undefined = process.env.BROKER_PORTAL_URL,
): string | null {
  const base = configured || DEFAULT_BROKER_PORTAL_URL;
  let parsed: URL;
  try {
    parsed = new URL(base);
  } catch {
    return null;
  }
  if (parsed.username || parsed.password) return null;
  const host = parsed.hostname.toLowerCase();
  const isLocal = host === "localhost" || host === "127.0.0.1";
  const isKeepr = host === "keeprcompliance.com" || host.endsWith(".keeprcompliance.com");
  const schemeOk =
    parsed.protocol === "https:" ? isKeepr || isLocal : parsed.protocol === "http:" && isLocal;
  if (!schemeOk) return null;
  // The ORIGIN alone: a path, query or fragment in the configured address
  // never reaches the browser or a request.
  return parsed.origin;
}

/** The full URL of one portal page, or null when the configured origin is refused. */
export function portalUrl(
  page: PortalPage,
  configured: string | undefined = process.env.BROKER_PORTAL_URL,
): string | null {
  const origin = portalOrigin(configured);
  return origin ? `${origin}${PORTAL_PATHS[page]}` : null;
}
