/**
 * BACKLOG-3956: renderer handling of the sign-in provider.
 *
 * Two functions, two purposes — keep them apart:
 *
 * - `normalizeAuthProvider` is for transport and app state (AuthContext,
 *   the deep-link login). It maps Supabase's "azure" to "microsoft" and passes
 *   every other value through unchanged. An "email" sign-in must stay truthy:
 *   AppModals/AppShell show Profile, the transactions view and the health
 *   monitor only when `authProvider` is set.
 *
 * - `toOnboardingAuthProvider` narrows to "google" | "microsoft" | null for the
 *   onboarding context ONLY. Anything that is not a mailbox provider becomes
 *   null, which the contact-source rule reads as "neither Outlook nor Google".
 *   There is deliberately no fallback to either provider.
 *
 * Mirrors electron/utils/normalizeOAuthProvider.ts (the main process applies
 * the same mapping before it sends the value; this is defence in depth for the
 * session-restore paths and any older payload).
 */
export function normalizeAuthProvider(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0) return null;
  return value === "azure" ? "microsoft" : value;
}

export function toOnboardingAuthProvider(
  value: unknown,
): "google" | "microsoft" | null {
  const normalized = normalizeAuthProvider(value);
  return normalized === "google" || normalized === "microsoft"
    ? normalized
    : null;
}
