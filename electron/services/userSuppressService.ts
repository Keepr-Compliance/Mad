/**
 * BACKLOG-4212: the per-user sender suppress list (rule U1).
 *
 * A sender is on the list when THIS user answered "newsletter" for at least N
 * of its messages in Learn, never answered "real estate" for one, has not
 * chosen "Stop hiding" for it, and it is not one of the user's own addresses.
 * Exact address only. N comes from the active rule set
 * (`thresholds.userSuppressMinAnswers`), else the bundled fallback; 0 = off.
 *
 * Consumers: the detector (transactionService) and the address pass
 * (reviewStateService). Learn run / score / pilot must NEVER receive the list
 * (it would grade the filter with the user's own answers); a pin test keeps
 * every file under services/learn free of it.
 *
 * The list is returned as a separate set. It is never merged into the shared
 * rule set object (that object is persisted on a Learn run and would turn U1
 * into an S0 that beats the keep rules).
 *
 * Privacy: local only; the caller logs the list's SIZE, never an address.
 */
import type { SenderRuleSet } from "../utils/senderFilter/bundledRules";
import { userSuppressMinAnswers } from "../utils/senderFilter/bundledRules";
import { fromAddress } from "../utils/senderFilter/senderFilter";
import { dbTransaction } from "./db/core/dbConnection";
import {
  insertSenderOverride,
  listUserOwnAddresses,
  listUserSuppressCandidates,
  listUserSuppressSettingsRows,
  softDeleteSenderOverride,
} from "./db/userSuppressDb";
import logService from "./logService";

const EMPTY: ReadonlySet<string> = new Set<string>();

/**
 * The user's list for one scan / pass. On a read failure the list is empty
 * (hides less, never more) and the error is logged without any address.
 */
export function buildUserSuppress(userId: string, rules: SenderRuleSet): ReadonlySet<string> {
  try {
    return readUserSuppress(userId, rules);
  } catch (error) {
    void logService.warn("[BACKLOG-4212] user suppress list unavailable; hiding none", "UserSuppressService", {
      error: error instanceof Error ? error.name : "unknown",
    });
    return EMPTY;
  }
}

function readUserSuppress(userId: string, rules: SenderRuleSet): ReadonlySet<string> {
  const n = userSuppressMinAnswers(rules);
  if (!Number.isInteger(n) || n <= 0) return EMPTY;
  const candidates = listUserSuppressCandidates(userId, n);
  if (candidates.length === 0) return EMPTY;
  const own = ownAddresses(userId);
  const list = new Set<string>();
  for (const key of candidates) if (!own.has(key)) list.add(key);
  return list;
}

function ownAddresses(userId: string): Set<string> {
  const own = new Set<string>();
  for (const raw of listUserOwnAddresses(userId)) {
    const a = fromAddress(raw);
    if (a) own.add(a);
  }
  return own;
}

// ---- Settings (PR3): "Senders you marked as newsletters" ---------------------

export interface SuppressedSenderRow {
  senderKey: string;
  newsletterCount: number;
  /** True = on the list now (no live "Stop hiding" row). */
  hidden: boolean;
}

/**
 * The Settings list: every sender at or above N (real_estate veto applied),
 * hidden or un-hidden by the user. Own addresses are never listed (they are
 * never hidden). N = 0 (off) lists nothing. `hidden` rows equal buildUserSuppress.
 */
export function listSuppressedForSettings(userId: string, rules: SenderRuleSet): SuppressedSenderRow[] {
  const n = userSuppressMinAnswers(rules);
  if (!Number.isInteger(n) || n <= 0) return [];
  const rows = listUserSuppressSettingsRows(userId, n);
  if (rows.length === 0) return [];
  const own = ownAddresses(userId);
  return rows
    .filter((r) => !own.has(r.senderKey))
    .map((r) => ({ senderKey: r.senderKey, newsletterCount: r.newsletterCount, hidden: !r.overridden }));
}

export type SetOverrideOutcome = "ok" | "invalid" | "not_listed";

/**
 * "Stop hiding" (hide = false) or "Hide again" (hide = true) for THIS user.
 * The key is normalised with fromAddress() (the same normaliser that wrote
 * sender_key), so "Name <A@B>" and "a@b" are one sender. Stop hiding is
 * accepted only for a sender on this user's Settings list, read and written in
 * one transaction. Hide again is one soft-delete statement.
 */
export function setSenderOverride(
  userId: string,
  rawSenderKey: string,
  hide: boolean,
  rules: SenderRuleSet,
): SetOverrideOutcome {
  const key = fromAddress(rawSenderKey);
  if (!key) return "invalid";
  if (hide) {
    softDeleteSenderOverride(userId, key);
    return "ok";
  }
  return dbTransaction(() => {
    const listed = listSuppressedForSettings(userId, rules).some((r) => r.senderKey === key);
    if (!listed) return "not_listed" as const;
    insertSenderOverride(userId, key);
    return "ok" as const;
  });
}
