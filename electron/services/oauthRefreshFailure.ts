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
import { classifyNetError, type NetErrorClass } from "./supabaseNetError";
import { SUPPORT_CLOSING_LINE } from "./diagnostics/userFacingErrors";

export type MailboxProviderName = "Microsoft" | "Google";

/** What `refreshAccessToken` returns (Microsoft and Google alike). */
export interface RefreshAccessTokenResult {
  success: boolean;
  error?: string;
  /** BACKLOG-3799: the provider could not be reached; the grant is still good. */
  unreachable?: boolean;
  /** BACKLOG-3954: allow-listed network classification of the failure. */
  cause?: Pick<NetErrorClass, "causeCode" | "tlsIntercept">;
}

/**
 * User-facing title for an unreachable provider (connection kept).
 * BACKLOG-3954: founder wording. Must stay clear of the token-expiry patterns
 * in emailSyncService.isTokenExpiryError, so the sync never asks to reconnect.
 */
export function providerUnreachableMessage(provider: MailboxProviderName): string {
  return `Can't reach ${provider}. Keepr will keep trying.`;
}

/**
 * BACKLOG-3954: the second line under the title — what the user can check,
 * ending with the shared support line (founder requirement 2026-10-15).
 */
export function providerUnreachableHelp(): string {
  return `If you use antivirus or a firewall, check that it isn't blocking Keepr, or restart your computer. ${SUPPORT_CLOSING_LINE}`;
}

/**
 * BACKLOG-3954: when the health banner speaks for an unreachable provider.
 *
 * Both conditions must hold: at least `failures` refreshes in a row could not
 * reach the provider, AND the first of them was at least `minMs` ago.
 *
 * - The count alone would trip seconds after launch: several callers check the
 *   connection at startup (loading screen, auto-refresh, the first health poll).
 * - The time alone would trip on a single failure after a quiet period.
 * - `minMs` sits below two health-poll intervals (2 min each, first poll 3 s
 *   after mount), so on the poll cadence alone the row appears on the third
 *   poll, about 4 minutes after the first failure.
 *
 * To show it on the first failure instead, set `{ failures: 1, minMs: 0 }`.
 */
export const UNREACHABLE_STREAK_THRESHOLD = {
  failures: 3,
  minMs: 3 * 60 * 1000,
} as const;

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

/**
 * BACKLOG-3954: the network classification of a refresh failure, read from the
 * first error in the cause chain that carries one. `classifyNetError` alone
 * reads only one level, and on the net.fetch path the Chromium error sits
 * under AxiosError -> TypeError("fetch failed"). Allow-listed codes only, so
 * the result is safe to send as a Sentry tag.
 */
export function refreshFailureCause(err: unknown): Pick<NetErrorClass, "causeCode" | "tlsIntercept"> {
  for (const e of causeChain(err)) {
    const c = classifyNetError(e);
    if (c.causeCode !== "OTHER") return { causeCode: c.causeCode, tlsIntercept: c.tlsIntercept };
  }
  return { causeCode: "OTHER", tlsIntercept: false };
}
