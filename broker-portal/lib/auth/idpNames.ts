/**
 * Identity-provider names at sign-in — BACKLOG-3991.
 *
 * Microsoft or Google is the source of truth for a person's first, last and shown
 * name. Every portal sign-in (/auth/callback) and every desktop sign-in (the
 * /auth/desktop/callback page, through syncDesktopIdpNames) sends the names the
 * provider gave to ONE database function, public.sync_profile_names_from_idp,
 * which holds the rule: a name the provider sent overwrites the stored one; an
 * absent, empty or whitespace-only name keeps it. This module only gathers the
 * names; it does not decide anything.
 *
 * Where the names are (traced, not assumed):
 *  - Microsoft: Supabase Auth's Azure provider copies every ID-token claim it does
 *    not map into user_metadata.custom_claims. given_name and family_name (Entra
 *    optional claims) therefore arrive there, never at the top level.
 *  - Google: Supabase stores no first or last name. They come from the userinfo
 *    endpoint, read with the sign-in's provider token (default scopes cover it).
 *  - Both: the shown name is user_metadata.full_name (or name).
 *
 * Never blocks a sign-in: every failure is logged by code and swallowed. Never
 * logs a token or a name.
 */

export const GOOGLE_USERINFO_URL = 'https://www.googleapis.com/userinfo/v2/me';
export const GOOGLE_USERINFO_TIMEOUT_MS = 3000;

export interface IdpNameArgs {
  p_first: string | null;
  p_last: string | null;
  p_display: string | null;
}

export interface GoogleNames {
  given_name: string | null;
  family_name: string | null;
}

/** The minimum of a Supabase client this module uses: one rpc call. */
export interface RpcClient {
  rpc: (_fn: string, _args: Record<string, unknown>) => PromiseLike<{ data: unknown; error: { code?: string } | null }>;
}

/** The minimum of a Supabase user this module reads. */
export interface IdpUser {
  app_metadata?: Record<string, unknown> | null;
  user_metadata?: Record<string, unknown> | null;
}

const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);

/**
 * The function's arguments from this sign-in. Strings are passed as they came;
 * the database trims, skips blanks and rejects bad values, so this side is not
 * the guard.
 */
export function idpNameArgs(
  userMetadata: Record<string, unknown> | null | undefined,
  provider: string | null | undefined,
  googleNames?: GoogleNames | null
): IdpNameArgs {
  const m = userMetadata ?? {};
  const display = str(m.full_name) ?? str(m.name);
  if (provider === 'azure') {
    const claims =
      m.custom_claims && typeof m.custom_claims === 'object' ? (m.custom_claims as Record<string, unknown>) : {};
    return { p_first: str(claims.given_name), p_last: str(claims.family_name), p_display: display };
  }
  if (provider === 'google') {
    return { p_first: googleNames?.given_name ?? null, p_last: googleNames?.family_name ?? null, p_display: display };
  }
  return { p_first: null, p_last: null, p_display: display };
}

/**
 * Google's first and last name for this sign-in, or null when they cannot be read
 * in time. A non-2xx reply, a timeout, a network error or a body that is not a JSON
 * object all give null. Logs the status or 'timeout' only.
 */
export async function fetchGoogleNames(
  providerToken: string,
  opts: { timeoutMs?: number } = {}
): Promise<GoogleNames | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? GOOGLE_USERINFO_TIMEOUT_MS);
  try {
    const res = await fetch(GOOGLE_USERINFO_URL, {
      headers: { Authorization: `Bearer ${providerToken}` },
      signal: controller.signal,
      cache: 'no-store',
    });
    if (!res.ok) {
      console.error(`google userinfo unavailable: ${res.status}`);
      return null;
    }
    const body: unknown = await res.json();
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      console.error('google userinfo unavailable: unexpected body');
      return null;
    }
    const b = body as Record<string, unknown>;
    return { given_name: str(b.given_name), family_name: str(b.family_name) };
  } catch {
    console.error(`google userinfo unavailable: ${controller.signal.aborted ? 'timeout' : 'error'}`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Sends this sign-in's names to sync_profile_names_from_idp on `supabase`, which
 * MUST be the signed-in user's own client: the function writes auth.uid()'s row,
 * and on a service client auth.uid() is NULL, so nothing would ever be written.
 * A refusal in the reply (success:false) is logged by its code, not only a thrown
 * or returned error, so that case cannot pass silently.
 */
export async function syncIdpNames(
  supabase: RpcClient,
  user: IdpUser,
  providerToken: string | null | undefined
): Promise<void> {
  try {
    const provider = str(user.app_metadata?.provider);
    const google = provider === 'google' && providerToken ? await fetchGoogleNames(providerToken) : null;
    const args = idpNameArgs(user.user_metadata, provider, google);
    if (args.p_first === null && args.p_last === null && args.p_display === null) return;

    const { data, error } = await supabase.rpc('sync_profile_names_from_idp', { ...args });
    if (error) {
      console.error(`sync_profile_names_from_idp failed: ${error.code ?? 'unknown'}`);
      return;
    }
    const reply = data && typeof data === 'object' ? (data as { success?: unknown; error?: unknown }) : null;
    if (reply?.success !== true) {
      console.error(`sync_profile_names_from_idp refused: ${typeof reply?.error === 'string' ? reply.error : 'unexpected reply'}`);
    }
  } catch {
    console.error('sync_profile_names_from_idp failed: exception');
  }
}
