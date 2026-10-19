/**
 * BACKLOG-3956: one spelling of the sign-in provider for everything the main
 * process hands onward.
 *
 * Supabase stores a Microsoft sign-in as "azure"; the rest of the app (session
 * file, local `users.oauth_provider`, the renderer's contact-source defaults)
 * speaks "microsoft". This maps that one value and passes every other value
 * through unchanged — "google", "email", anything a future provider adds —
 * so callers that gate on "is there a provider at all" keep working.
 *
 * Narrowing to "google" | "microsoft" | null is NOT done here: that is a
 * decision for the onboarding boundary (OnboardingFlow), not for transport.
 */
export function normalizeOAuthProvider(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length === 0) return undefined;
  return value === "azure" ? "microsoft" : value;
}
