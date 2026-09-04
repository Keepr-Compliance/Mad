/**
 * The account page's SHAPE and its pure display helpers. BACKLOG-3079.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS A SEPARATE FILE FROM getAccountView.ts
 * ---------------------------------------------------------------------------
 * `getAccountView.ts` imports `@/lib/supabase/server`, which reaches for
 * `next/headers` and therefore only exists on the server. AccountClient is a
 * client component: importing ANYTHING from that module — even a type, even a
 * pure function — drags the whole server module into the client bundle and the
 * build fails with "You're importing a component that needs next/headers".
 *
 * That failure is invisible to `tsc` and to jest, both of which resolve the
 * import happily. It shows up ONLY in `next build`. So the split is not tidiness
 * — it is the boundary, and this file is the client-safe side of it.
 */

export interface AccountIdentity {
  userId: string;
  displayName: string | null;
  email: string | null;
  /** users.oauth_provider, raw. Rendered through providerDisplayName(). */
  authProvider: string | null;
  role: string | null;
  organizationName: string | null;
  createdAt: string | null;
}

export interface AccountView {
  identity: AccountIdentity;
  /** The raw blob. null when the person has no user_preferences row at all. */
  preferences: Record<string, unknown> | null;
  /** When the preferences were last written. */
  preferencesUpdatedAt: string | null;
  /** organizations.retention_years, when the person belongs to an org. */
  orgRetentionYears: number | null;
  /** True while a support session is reading somebody else's account. */
  isImpersonating: boolean;
}

/**
 * How the desktop names an auth provider — plus the case it gets wrong.
 *
 * src/components/Profile.tsx getProviderDisplay() maps "google" -> "Google" and
 * "microsoft" -> "Microsoft", and otherwise falls through to the raw string.
 * Production only ever stores `azure`, `google` or `email` in
 * users.oauth_provider (23 rows, checked 2026-09-04) — "microsoft" never
 * appears. So the desktop's fallback is what actually runs for Microsoft users,
 * and its Account panel reads "Signed in with azure".
 *
 * This page maps `azure` to Microsoft rather than reproducing that. The LABEL
 * is the desktop's ("Signed in with X"); printing an OAuth provider slug at a
 * person is not a label worth mirroring. Flagged on the item so the desktop can
 * be brought into line — until it is, the two surfaces differ by one word for
 * Microsoft users, and this is the surface that is right.
 */
export function providerDisplayName(provider: string | null): string | null {
  if (!provider) return null;
  switch (provider) {
    case 'google':
      return 'Google';
    case 'microsoft':
    case 'azure':
      return 'Microsoft';
    case 'email':
      return 'Email';
    default:
      return provider;
  }
}
