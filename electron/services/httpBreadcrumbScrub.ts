/**
 * BACKLOG-3768: strip query string and fragment from HTTP breadcrumb URLs.
 *
 * MEASURED (Electron 38.8.6, @sentry/electron main): `net.fetch` and
 * `net.request` each record an `electron.net` / type `http` breadcrumb whose
 * `data.url` is the full request URL, query included. Supabase PostgREST
 * filters can carry an email in the query, so only origin + path are kept.
 *
 * Pure: no Sentry or Electron import. Never throws.
 */

interface BreadcrumbLike {
  type?: string;
  category?: string;
  data?: { [key: string]: unknown };
}

function stripUrl(raw: string): string {
  const cut = raw.search(/[?#]/);
  return cut === -1 ? raw : raw.slice(0, cut);
}

export function scrubHttpBreadcrumb<T extends BreadcrumbLike>(breadcrumb: T): T {
  try {
    const data = breadcrumb.data;
    if (breadcrumb.type === "http" && data) {
      const next: { [key: string]: unknown } = { ...data };
      if (typeof next.url === "string") next.url = stripUrl(next.url);
      // Sentry's Node http/fetch breadcrumbs carry the query separately.
      delete next["http.query"];
      delete next["http.fragment"];
      return { ...breadcrumb, data: next };
    }
  } catch {
    // fall through: return unchanged
  }
  return breadcrumb;
}
