/**
 * Grandfather the OLD 3-month default (SR, 2026-10-02) — in ONE place.
 *
 * 5b387dc44 / 0bdd53b26 moved the default window for messages and email from
 * 3 months to 1.5. A user who never chose a window read the default, so the
 * upgrade alone would have narrowed their next Force re-import / Force
 * Re-cache (which replace everything with the window's rows) to 46 days.
 *
 * So, once per user, right after sign-in (deep link) or a restored session:
 *   - a user with NO stored lookback who already HAS data gets the old 3
 *     written as an explicit stored value — messages
 *     (`messageImport.filters.lookbackMonths`, plus
 *     `messageImport.android.filters.lookbackMonths` when that namespace
 *     exists) and email (`emailCache.durationMonths`), each on its own;
 *   - a user with no data (new) gets nothing written, so the 1.5 default applies;
 *   - a marker (`defaultsMigrations.lookback15`) is written either way, so a
 *     new user is never "grandfathered" later, once data exists.
 *
 * "Has data": messages — `message_import_state.last_import_at`, or any row in
 * `messages` (Mac, iPhone, Android companion, Google Messages); email — any
 * cached row in `emails`.
 */

import logService from "./logService";
import supabaseService from "./supabaseService";
import { dbGet } from "./db/core/dbConnection";
import { sql, type SafeSql } from "./db/core/sqlText";

export const LEGACY_DEFAULT_LOOKBACK_MONTHS = 3;

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- stored preferences are arbitrary JSON
type Prefs = Record<string, any>;

export interface GrandfatherDeps {
  getPreferences: (userId: string) => Promise<Prefs | null>;
  savePreferences: (userId: string, preferences: Prefs) => Promise<void>;
  hasMessageData: (userId: string) => boolean;
  hasEmailData: (userId: string) => boolean;
}

const isObj = (v: unknown): v is Prefs => !!v && typeof v === "object" && !Array.isArray(v);

/** The preferences to merge in, or null when nothing is to be written (already done). */
export function grandfatherPatch(prefs: Prefs | null | undefined, has: { messages: boolean; email: boolean }): Prefs | null {
  if (prefs?.defaultsMigrations?.lookback15 === true) return null;
  const patch: Prefs = { defaultsMigrations: { lookback15: true } };
  if (has.messages) {
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
  }
  if (has.email) {
    const stored = prefs?.emailCache?.durationMonths ?? prefs?.emailSync?.lookbackMonths;
    // As resolveEmailCacheDurationMonths: only a positive number is a stored choice.
    if (!(typeof stored === "number" && stored > 0)) patch.emailCache = { durationMonths: LEGACY_DEFAULT_LOOKBACK_MONTHS };
  }
  return patch;
}

function merge(target: Prefs, source: Prefs): Prefs {
  const out: Prefs = { ...target };
  for (const key of Object.keys(source)) {
    out[key] = isObj(source[key]) && isObj(target[key]) ? merge(target[key], source[key]) : source[key];
  }
  return out;
}

/** Run once per user; never throws (a failed write is retried on the next sign-in). */
export async function grandfatherLookbackDefaults(userId: string, deps: GrandfatherDeps): Promise<Prefs | null> {
  try {
    const prefs = (await deps.getPreferences(userId)) ?? {};
    const patch = grandfatherPatch(prefs, { messages: deps.hasMessageData(userId), email: deps.hasEmailData(userId) });
    if (!patch) return null;
    await deps.savePreferences(userId, merge(prefs, patch));
    void logService.info(
      `[Preferences] Lookback defaults: ${patch.messageImport ? "messages kept at 3 months; " : ""}` +
        `${patch.emailCache ? "email kept at 3 months; " : ""}marker written`,
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

/** The production deps: Supabase preferences + the local database. */
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
    hasMessageData: (id) =>
      exists(sql`SELECT 1 FROM message_import_state WHERE user_id = ? AND last_import_at IS NOT NULL`, [id]) ||
      exists(sql`SELECT 1 FROM messages WHERE user_id = ? LIMIT 1`, [id]),
    hasEmailData: (id) => exists(sql`SELECT 1 FROM emails WHERE user_id = ? LIMIT 1`, [id]),
  });
}
