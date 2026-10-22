/**
 * Setup guide step choice — BACKLOG-4007 PR-3. Pure, so the order is testable.
 *
 * Founder 88a1f065: Billing comes BEFORE "Connect Microsoft". While the deal waits, the guide
 * shows only the Billing step, whatever the URL asks for. After it:
 *   - an admin whose brokerage has no Microsoft organization, signed in with Microsoft -> Connect
 *     (with "Skip for now"; founder e4d40740: the broker may connect later);
 *   - everyone else -> Done.
 * Connecting needs an admin (the /auth/setup/callback rule, canGrantAdminConsent) and a Microsoft
 * sign-in (a Google session cannot link a Microsoft organization).
 */

export type SetupStep = 'billing' | 'microsoft' | 'done';

export interface SetupStepInput {
  state: string;
  role: string;
  hasMicrosoftTenant: boolean;
  signInProvider: string | null | undefined;
  requested: string | null | undefined;
}

export function canConnectMicrosoft(i: Pick<SetupStepInput, 'role' | 'hasMicrosoftTenant' | 'signInProvider'>): boolean {
  return i.role === 'admin' && !i.hasMicrosoftTenant && i.signInProvider === 'azure';
}

export function setupStepFor(i: SetupStepInput): SetupStep {
  if (i.state === 'waiting_for_setup') return 'billing';
  if (i.requested === 'done') return 'done';
  return canConnectMicrosoft(i) ? 'microsoft' : 'done';
}

/**
 * BACKLOG-4007 PR-4 (SR F3 on PR-3): which provider decides the Microsoft step. Supabase's
 * `app_metadata.provider` is the account's FIRST provider, so a Google-first admin who later
 * signs in with Microsoft read as 'google' and was never offered "Connect Microsoft". An account
 * with ANY Microsoft identity reads 'azure' (it can complete the Microsoft flow); otherwise the
 * first provider, as before.
 */
export function signInProviderOf(user: {
  app_metadata?: { provider?: unknown; providers?: unknown } | null;
  identities?: Array<{ provider?: string | null }> | null;
}): string | null {
  const providers = Array.isArray(user.app_metadata?.providers) ? (user.app_metadata?.providers as unknown[]) : [];
  const identities = (user.identities ?? []).map((i) => i?.provider);
  if (providers.includes('azure') || identities.includes('azure')) return 'azure';
  return typeof user.app_metadata?.provider === 'string' ? user.app_metadata.provider : null;
}
