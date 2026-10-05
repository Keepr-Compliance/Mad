/**
 * Grandfather the OLD 3-month default (SR, 2026-10-02) — in ONE place.
 *
 * 5b387dc44 / 0bdd53b26 moved the default window for messages and email from
 * 3 months to 1.5. A user who never chose a window read the default, so the
 * upgrade alone would have narrowed their next Force re-import / Force
 * Re-cache (which replace everything with the window's rows) to 46 days.
 *
 * Once per ACCOUNT (the preferences, and the marker, live in Supabase and are
 * shared by every device), right after sign-in or a restored session:
 *
 *   EXISTING user — the account was created BEFORE the release cut-over
 *   (LOOKBACK_DEFAULT_CUTOVER_ISO; Supabase `users.created_at`). Every
 *   absent window gets the old 3 written explicitly — messages
 *   (`messageImport.filters.lookbackMonths`, and `android.filters` when that
 *   namespace exists) and email (`emailCache.durationMonths`), each on its
 *   own — WHATEVER this machine holds: a long-time user signing in on a new,
 *   empty machine first must not leave the original machine ungrandfathered
 *   (SR fix: "has data" used to be local).
 *   OR this machine already holds data (messages or cached email) — SR: a
 *   deleted-and-recreated account with an old local database is still
 *   grandfathered; a recent created_at never overrides local data.
 *   NEW user — created on/after the cut-over (or no created_at) AND no local
 *   data: nothing but the marker, so 1.5 applies.
 *   The account row could not be read (offline): NOTHING is written, not even
 *   the marker; retried on the next sign-in.
 *
 * The marker (`defaultsMigrations.lookback15`) is written only together with
 * that decision, in the same save.
 */

import logService from "./logService";
import supabaseService from "./supabaseService";
import { dbGet } from "./db/core/dbConnection";
import { sql, type SafeSql } from "./db/core/sqlText";

export const LEGACY_DEFAULT_LOOKBACK_MONTHS = 3;

/**
 * The release that ships the 1.5-month default. Accounts created before it
 * keep 3. Final (founder, 2026-10-04): 2026-10-05.
 */
export const LOOKBACK_DEFAULT_CUTOVER_ISO = "2026-10-05T00:00:00.000Z";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- stored preferences are arbitrary JSON
type Prefs = Record<string, any>;

/** The account's creation time: known (an ISO string, or null when the row has none) or unknown (not read). */
export type AccountCreatedAt = { known: true; createdAt: string | null } | { known: false };

export interface GrandfatherDeps {
  getPreferences: (userId: string) => Promise<Prefs | null>;
  savePreferences: (userId: string, preferences: Prefs) => Promise<void>;
  getAccountCreatedAt: (userId: string) => Promise<AccountCreatedAt>;
  /** Messages or cached email on THIS machine. */
  hasLocalData: (userId: string) => boolean;
}

const isObj = (v: unknown): v is Prefs => !!v && typeof v === "object" && !Array.isArray(v);

/** existing / new / undecided (write nothing). */
export function classifyAccount(account: AccountCreatedAt, hasLocalData: boolean): "existing" | "new" | "undecided" {
  if (!account.known) return "undecided";
  if (hasLocalData) return "existing";
  const t = account.createdAt ? Date.parse(account.createdAt) : NaN;
  return Number.isFinite(t) && t < Date.parse(LOOKBACK_DEFAULT_CUTOVER_ISO) ? "existing" : "new";
}

/** The preferences to merge in (always with the marker), or null when already done. */
export function grandfatherPatch(prefs: Prefs | null | undefined, existing: boolean): Prefs | null {
  if (prefs?.defaultsMigrations?.lookback15 === true) return null;
  const patch: Prefs = { defaultsMigrations: { lookback15: true } };
  if (!existing) return patch;
  const messageImport: Prefs = {};
  if (prefs?.messageImport?.filters?.lookbackMonths === undefined) {
    messageImport.filters = { lookbackMonths: LEGACY_DEFAULT_LOOKBACK_MONTHS };
  }
  // The Android namespace (BACKLOG-2734) only when it exists: without it the
  // panel and the companion fall back to the shared filters written above.
  if (isObj(prefs?.messageImport?.android) && prefs.messageImport.android.filters?.lookbackMonths === undefined) {
    messageImport.android = { filters: { lookbackMonths: LEGACY_DEFAULT_LOOKBACK_MONTHS } };
  }
  if (Object.keys(messageImport).length > 0) patch.messageImport = messageImport;
  const stored = prefs?.emailCache?.durationMonths ?? prefs?.emailSync?.lookbackMonths;
  // As resolveEmailCacheDurationMonths: only a positive number is a stored choice.
  if (!(typeof stored === "number" && stored > 0)) patch.emailCache = { durationMonths: LEGACY_DEFAULT_LOOKBACK_MONTHS };
  return patch;
}

function merge(target: Prefs, source: Prefs): Prefs {
  const out: Prefs = { ...target };
  for (const key of Object.keys(source)) {
    out[key] = isObj(source[key]) && isObj(target[key]) ? merge(target[key], source[key]) : source[key];
  }
  return out;
}

/** Run once per account; never throws (an undecided or failed run is retried on the next sign-in). */
export async function grandfatherLookbackDefaults(userId: string, deps: GrandfatherDeps): Promise<Prefs | null> {
  try {
    const prefs = (await deps.getPreferences(userId)) ?? {};
    if (prefs?.defaultsMigrations?.lookback15 === true) return null;
    const kind = classifyAccount(await deps.getAccountCreatedAt(userId), deps.hasLocalData(userId));
    if (kind === "undecided") {
      void logService.info("[Preferences] Lookback defaults: account age unknown, retried next sign-in", "Preferences");
      return null;
    }
    const patch = grandfatherPatch(prefs, kind === "existing");
    if (!patch) return null;
    await deps.savePreferences(userId, merge(prefs, patch));
    void logService.info(
      `[Preferences] Lookback defaults: ${kind} account; ` +
        `${patch.messageImport ? "messages kept at 3 months; " : ""}${patch.emailCache ? "email kept at 3 months; " : ""}marker written`,
      "Preferences",
    );
    return patch;
  } catch (err) {
    void logService.warn("[Preferences] Lookback grandfathering skipped (retried next sign-in)", "Preferences", {
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/** The production deps: Supabase preferences and account row + the local database. */
export function grandfatherLookbackDefaultsForUser(userId: string): Promise<Prefs | null> {
  const exists = (q: SafeSql, params: unknown[]): boolean => {
    try {
      return !!dbGet(q, params);
    } catch {
      return false; // no table yet: no data
    }
  };
  return grandfatherLookbackDefaults(userId, {
    getPreferences: (id) => supabaseService.getPreferences(id),
    savePreferences: (id, p) => supabaseService.syncPreferences(id, p),
    getAccountCreatedAt: async (id) => {
      try {
        const user = (await supabaseService.getUserById(id)) as { created_at?: string | null } | null;
        return { known: true, createdAt: typeof user?.created_at === "string" ? user.created_at : null };
      } catch {
        return { known: false };
      }
    },
    hasLocalData: (id) =>
      exists(sql`SELECT 1 FROM message_import_state WHERE user_id = ? AND last_import_at IS NOT NULL`, [id]) ||
      exists(sql`SELECT 1 FROM messages WHERE user_id = ? LIMIT 1`, [id]) ||
      exists(sql`SELECT 1 FROM emails WHERE user_id = ? LIMIT 1`, [id]),
  });
}
