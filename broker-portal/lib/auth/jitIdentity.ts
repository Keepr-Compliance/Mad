/**
 * Which brokerage a portal sign-in may auto-join (JIT) — BACKLOG-4012.
 *
 * The answer comes from the identity this sign-in used: of the user's linked identities
 * (returned by the auth server through getUser), the one the auth server wrote last. Signing in
 * with a provider rewrites that provider's identity, so the newest one is this sign-in's.
 * `app_metadata.provider` is NOT used: it names the account's FIRST provider, so a user who
 * started with email and later linked Microsoft never reached JIT.
 *
 * The tenant (Microsoft `tid`) and the Workspace domain (Google `hd`) are read from that
 * identity's `identity_data.custom_claims`, which the auth server copies from the provider's
 * ID token. Google puts `hd` there, never at the top level of user_metadata.
 *
 * jit_join_organization checks all of this again in the database (the identity must carry the
 * identifier and must come from a fresh OAuth sign-in in this session); this only decides
 * whether to ask.
 */

/** The parts of a supabase-js UserIdentity this reads. */
export interface IdentityLike {
  provider?: string | null;
  updated_at?: string | null;
  identity_data?: Record<string, unknown> | null;
}

export interface UserWithIdentities {
  identities?: IdentityLike[] | null;
}

export interface JitTarget {
  providerType: 'azure_ad' | 'google_workspace';
  identifier: string;
}

/** Consumer Google domains: never a brokerage's Workspace. */
const CONSUMER_GOOGLE_DOMAINS = ['gmail.com', 'googlemail.com'];

function claim(identity: IdentityLike, key: string): string | null {
  const claims = identity.identity_data?.custom_claims as Record<string, unknown> | undefined;
  const value = claims?.[key];
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

function time(identity: IdentityLike): number {
  const t = identity.updated_at ? Date.parse(identity.updated_at) : NaN;
  return Number.isNaN(t) ? -Infinity : t;
}

/** The identity this sign-in used: the one written last. null when there is none. */
export function signInIdentity(user: UserWithIdentities | null | undefined): IdentityLike | null {
  const identities = user?.identities ?? [];
  let latest: IdentityLike | null = null;
  for (const identity of identities) {
    if (!latest || time(identity) > time(latest)) latest = identity;
  }
  return latest;
}

/** What to pass to jit_join_organization for this sign-in, or null when JIT does not apply. */
export function jitTargetFor(user: UserWithIdentities | null | undefined): JitTarget | null {
  const identity = signInIdentity(user);
  if (!identity) return null;
  if (identity.provider === 'azure') {
    const tid = claim(identity, 'tid');
    return tid ? { providerType: 'azure_ad', identifier: tid } : null;
  }
  if (identity.provider === 'google') {
    const hd = claim(identity, 'hd')?.toLowerCase();
    return hd && !CONSUMER_GOOGLE_DOMAINS.includes(hd) ? { providerType: 'google_workspace', identifier: hd } : null;
  }
  return null;
}

/**
 * The member trigger's refusal while the brokerage's billing setup is pending
 * (_billing_guard_idp_join_while_setup_pending): code AND message, as isBrokerageSuspendedError.
 */
export function isBillingSetupIncompleteError(error: { code?: string; message?: string } | null | undefined): boolean {
  return !!error && error.code === 'P0001' && error.message === 'billing_setup_incomplete';
}
