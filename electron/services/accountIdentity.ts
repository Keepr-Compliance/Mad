/**
 * BACKLOG-4075: the same-account rule, in a leaf module so both the session
 * restore (sessionHandlers.ts) and the token write-back (supabaseService.ts)
 * use ONE rule. sessionHandlers imports supabaseService, so the rule cannot
 * live there and be imported back.
 */
import type { User } from "../types/models";

export interface AccountIdentity {
  id: string;
  email?: string | null;
  oauthId?: string | null;
}

const normEmail = (e?: string | null): string => (e || "").trim().toLowerCase();

/**
 * Same person = same email (case-insensitive), or — for the session-file
 * target only — the same OAuth id (getUserByOAuthId found it).
 */
export function isSameAccount(local: User, target: AccountIdentity): boolean {
  const le = normEmail(local.email);
  if (le && le === normEmail(target.email)) return true;
  if (local.oauth_id && target.oauthId && local.oauth_id === target.oauthId) return true;
  return false;
}
