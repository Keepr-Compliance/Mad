/**
 * Canonical public legal document URLs.
 *
 * Single source of truth so onboarding, settings, and login all point at the
 * live public landing routes. The public site (keeprcompliance.com) serves
 * these at /terms, /privacy, and /cookies — there is NO /legal route, so do
 * not reintroduce `www.` + `/legal#…` fragments (they 404).
 *
 * See BACKLOG-2164: About links had drifted to the dead /legal#… scheme
 * because each file hardcoded its own URLs.
 */

export const TERMS_URL: string = "https://keeprcompliance.com/terms";
export const PRIVACY_URL: string = "https://keeprcompliance.com/privacy";
export const COOKIES_URL: string = "https://keeprcompliance.com/cookies";
