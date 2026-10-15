// ============================================
// ACCOUNT SETUP IPC HANDLERS (BACKLOG-3673)
// Handles: the per-account "setup finished" record (users.onboarding_completed_at)
// ============================================
//
// One server-side record decides whether an account has finished setup. These
// two handlers are its only app-side reader and writer.
//
// - Both act on the SESSION user (supabaseService.getAuthUserId()). Neither
//   accepts a user id from the renderer; any argument is ignored.
// - The session file keeps an offline cache (accountSetupFinishedAt). The
//   server decides; the cache is read only when the server cannot be reached.

import { ipcMain } from "electron";
import * as Sentry from "@sentry/electron/main";
import supabaseService from "../services/supabaseService";
import sessionService from "../services/sessionService";
import logService from "../services/logService";

export type AccountSetup = "finished" | "not-finished" | "unknown";

export interface GetAccountSetupResult {
  success: boolean;
  setup: AccountSetup;
  emailStepAnswered: boolean;
  contactSourceAnswered: boolean;
  /**
   * BACKLOG-3888: the mailbox providers this account has ever connected
   * (`preferences.emailProviders`), read from the same bag under the same
   * timeout. Absent when the bag could not be read.
   */
  emailProviders?: string[];
  error?: string;
}

const MODULE = "AccountSetup";

/**
 * Upper bound on the server read. Phase 4 (the loading screen) waits for this
 * answer, so a hung request must not hold the app: past this, the cache answers.
 */
export const ACCOUNT_SETUP_READ_TIMEOUT_MS = 8000;

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`account setup read timed out after ${ms} ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

/** The session file's offline cache of the record, or null. Never throws. */
async function readCachedFinishedAt(): Promise<string | null> {
  try {
    const session = await sessionService.loadSession();
    return session?.accountSetupFinishedAt ?? null;
  } catch {
    return null;
  }
}

/** Keep the offline cache in step with the server answer. Never throws. */
async function writeCache(finishedAt: string | null): Promise<void> {
  try {
    // JSON drops `undefined`, so a not-finished answer removes the field.
    await sessionService.updateSession({ accountSetupFinishedAt: finishedAt ?? undefined });
  } catch (error) {
    logService.warn("[AccountSetup] Could not update the session cache", MODULE, {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Read the account record for the session user.
 *
 * - server row with the record set   -> "finished"
 * - server row without it, or no row -> "not-finished"
 * - server unreachable / no session user -> the session cache if it says
 *   finished, otherwise "unknown" (the renderer shows the "Couldn't load your
 *   account settings" screen for "unknown", never setup)
 */
export async function getAccountSetup(): Promise<GetAccountSetupResult> {
  const userId = supabaseService.getAuthUserId();

  if (!userId) {
    const cached = await readCachedFinishedAt();
    // No session user is a different case from a failed server read (below):
    // Retry cannot fix it, only Sign out can. Logged and tagged separately so
    // the two can be told apart.
    logService.warn("[AccountSetup] No session user; answering from cache", MODULE, {
      cached: cached !== null,
    });
    Sentry.captureException(new Error("Account setup read with no session user"), {
      level: "warning",
      tags: {
        service: "account-setup",
        operation: "getAccountSetup",
        account_setup_reason: "no-session-user",
      },
      extra: { cached: cached !== null },
    });
    return {
      success: true,
      setup: cached ? "finished" : "unknown",
      emailStepAnswered: false,
      contactSourceAnswered: false,
    };
  }

  try {
    const [record, preferences] = await withTimeout(
      Promise.all([
        supabaseService.getAccountSetupRecord(userId),
        supabaseService.getPreferences(userId).catch(() => ({}) as Record<string, unknown>),
      ]),
      ACCOUNT_SETUP_READ_TIMEOUT_MS,
    );

    const finishedAt = record.onboardingCompletedAt;
    const setup: AccountSetup = finishedAt ? "finished" : "not-finished";
    await writeCache(finishedAt);

    const contactSources = (preferences as { contactSources?: { direct?: unknown } } | undefined)
      ?.contactSources;

    const recordedProviders = (preferences as { emailProviders?: unknown } | undefined)
      ?.emailProviders;

    return {
      success: true,
      setup,
      emailStepAnswered: Boolean(record.emailOnboardingCompletedAt),
      contactSourceAnswered: Boolean(contactSources?.direct),
      emailProviders: Array.isArray(recordedProviders)
        ? recordedProviders.filter((v): v is string => typeof v === "string" && v.length > 0)
        : [],
    };
  } catch (error) {
    const cached = await readCachedFinishedAt();
    logService.warn("[AccountSetup] Server read failed; answering from cache", MODULE, {
      error: error instanceof Error ? error.message : String(error),
      cached: cached !== null,
    });
    return {
      success: true,
      setup: cached ? "finished" : "unknown",
      emailStepAnswered: false,
      contactSourceAnswered: false,
    };
  }
}

/**
 * Write the record for the session user (write-once). A failure is logged and
 * reported to Sentry and returned as `success: false` -- never as success. The
 * account still reaches the dashboard; the next launch reads "not-finished",
 * the setup queue completes at once (every answer is seeded) and the write is
 * retried.
 */
export async function completeAccountSetup(): Promise<{ success: boolean; error?: string }> {
  const userId = supabaseService.getAuthUserId();
  if (!userId) {
    logService.warn("[AccountSetup] No session user; setup-finished record not written", MODULE);
    return { success: false, error: "No session user" };
  }

  try {
    await supabaseService.completeAccountSetup(userId);
    await writeCache(new Date().toISOString());
    logService.info("[AccountSetup] Setup-finished record written", MODULE);
    return { success: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logService.error("[AccountSetup] Setup-finished record write failed", MODULE, { error: message });
    Sentry.captureException(error, {
      tags: { service: "account-setup", operation: "completeAccountSetup" },
    });
    return { success: false, error: message };
  }
}

/** Register the account-setup IPC handlers. */
export function registerAccountSetupHandlers(): void {
  // Any renderer-supplied arguments are ignored on purpose: the session user
  // is the only account these handlers act on.
  ipcMain.handle("user:get-account-setup", () => getAccountSetup());
  ipcMain.handle("user:complete-account-setup", () => completeAccountSetup());
}
