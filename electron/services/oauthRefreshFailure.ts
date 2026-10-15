/**
 * Mailbox token-refresh failure classification (BACKLOG-3799).
 *
 * A refresh that fails because the provider could not be REACHED (network,
 * TLS interception by antivirus, DNS, 5xx, 429) says nothing about the stored
 * grant: the connection is still good and the user must NOT be told to
 * reconnect. Only an answer from the token endpoint itself (HTTP 400/401,
 * which is how `invalid_grant` and its relatives arrive) means the grant is
 * dead and "Reconnect" is the right prompt.
 *
 * Pure: no Electron import.
 *
 * @module services/oauthRefreshFailure
 */

import { isNetworkError } from "../utils/networkErrors";
import { classifyNetError } from "./supabaseNetError";

export type MailboxProviderName = "Microsoft" | "Google";

/** User-facing copy for an unreachable provider (connection kept). */
export function providerUnreachableMessage(provider: MailboxProviderName): string {
  return `Can't reach ${provider}. Check your network or antivirus, then try again.`;
}

/** OAuth error codes that mean the stored grant cannot be refreshed. */
const HARD_OAUTH_CODES = [
  "invalid_grant",
  "interaction_required",
  "consent_required",
  "login_required",
  "invalid_client",
  "unauthorized_client",
];

function causeChain(err: unknown): unknown[] {
  const out: unknown[] = [];
  let cur: unknown = err;
  for (let i = 0; i < 5 && cur && typeof cur === "object"; i += 1) {
    out.push(cur);
    cur = (cur as { cause?: unknown }).cause;
  }
  return out;
}

function statusOf(e: unknown): number | undefined {
  const o = e as { status?: unknown; response?: { status?: unknown } } | null;
  const s = o?.response?.status ?? o?.status;
  return typeof s === "number" ? s : undefined;
}

function messageOf(e: unknown): string {
  const m = (e as { message?: unknown } | null)?.message;
  return typeof m === "string" ? m.toLowerCase() : "";
}

/**
 * True when a refresh failed because the provider could not be reached (or
 * answered 5xx / 429 / 408). False for a real OAuth rejection and for anything
 * unrecognised, so an unknown failure keeps today's "Reconnect" behaviour.
 */
export function isTransientRefreshFailure(err: unknown): boolean {
  const chain = causeChain(err);
  for (const e of chain) {
    const status = statusOf(e);
    if (status !== undefined) return status >= 500 || status === 429 || status === 408;
    const msg = messageOf(e);
    if (HARD_OAUTH_CODES.some((c) => msg.includes(c))) return false;
  }
  return chain.some(
    (e) => isNetworkError(e) || classifyNetError(e).causeCode !== "OTHER",
  );
}
