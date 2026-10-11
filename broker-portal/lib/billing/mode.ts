/**
 * Stripe mode of this deployment (BACKLOG-3845, plan v3 §2.6).
 *
 * The mode comes from the secret key's prefix and nothing else. Every Stripe
 * path reads it here, writes it on every billing row, and filters every billing
 * read by it, so a test-key preview and the live production deployment never
 * see each other's rows even though they share one database.
 *
 * Read on every call (not memoised): the key is process configuration and a
 * memo would make the value depend on which call happened first.
 */

export type StripeMode = 'test' | 'live';

/** Mode of a Stripe secret or restricted key. Throws on anything else — never guesses. */
export function stripeModeFromKey(key: string | undefined | null): StripeMode {
  if (!key) throw new Error('STRIPE_SECRET_KEY is not configured');
  if (key.startsWith('sk_test_') || key.startsWith('rk_test_')) return 'test';
  if (key.startsWith('sk_live_') || key.startsWith('rk_live_')) return 'live';
  throw new Error('STRIPE_SECRET_KEY has an unrecognised prefix');
}

/** Mode of the key this deployment runs with. */
export function currentStripeMode(): StripeMode {
  return stripeModeFromKey(process.env.STRIPE_SECRET_KEY);
}

/** Mode a Stripe event was created in. */
export function eventStripeMode(event: { livemode: boolean }): StripeMode {
  return event.livemode ? 'live' : 'test';
}

/** True when the event was created in this deployment's mode. */
export function eventMatchesCurrentMode(event: { livemode: boolean }): boolean {
  return eventStripeMode(event) === currentStripeMode();
}
