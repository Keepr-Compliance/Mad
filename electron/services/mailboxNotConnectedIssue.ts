/**
 * Mailbox-not-connected health issue (BACKLOG-3888)
 *
 * The health banner (SystemHealthMonitor) speaks for broken mailbox tokens
 * only; a provider that is simply NOT_CONNECTED is excluded (see
 * BROKEN_TOKEN_TYPES in diagnosticHandlers.ts). This module adds ONE
 * exception: a user who has connected a mailbox before — the cloud set
 * `preferences.emailProviders` is non-empty (written by emailProviderRecord.ts
 * on each successful connect) — and has no mailbox connected now gets an amber
 * "connect" row. Users with no record (texts-only) get nothing.
 *
 * The caller decides WHEN to ask (no mailbox connected, no broken-token row
 * already raised); this module decides WHAT to say. The preferences read is
 * bounded; a timeout or failure means "no record" and no row.
 *
 * @module services/mailboxNotConnectedIssue
 */

import supabaseService from "./supabaseService";
import logService from "./logService";
import { EMAIL_PROVIDERS_PREFERENCE_KEY } from "./emailProviderRecord";
import type { HealthConnectionIssue } from "../types/ipc/healthIssue";

/** Upper bound on the preferences read made by a health check. */
export const NOT_CONNECTED_READ_TIMEOUT_MS = 5000;

export const NOT_CONNECTED_MESSAGES = {
  outlook: "Your Outlook mailbox isn't connected. Connect to keep capturing email.",
  gmail: "Your Gmail mailbox isn't connected. Connect to keep capturing email.",
  both: "Your email isn't connected. Connect to keep capturing email.",
} as const;

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`preferences read timed out after ${ms} ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

/** The recorded providers, or an empty list when none / unreadable. */
export async function readRecordedEmailProviders(userId: string): Promise<Array<"outlook" | "gmail">> {
  try {
    const preferences = await withTimeout(
      supabaseService.getPreferences(userId),
      NOT_CONNECTED_READ_TIMEOUT_MS,
    );
    const value = (preferences ?? {})[EMAIL_PROVIDERS_PREFERENCE_KEY];
    if (!Array.isArray(value)) return [];
    const out: Array<"outlook" | "gmail"> = [];
    if (value.includes("outlook")) out.push("outlook");
    if (value.includes("gmail")) out.push("gmail");
    return out;
  } catch (error) {
    try {
      void Promise.resolve(
        logService.warn("[MailboxNotConnected] Could not read recorded email providers", "Diagnostics", {
          error: error instanceof Error ? error.message : String(error),
        }),
      ).catch(() => undefined);
    } catch {
      // Logging must never turn "no record" into a failed health check.
    }
    return [];
  }
}

/**
 * The amber "connect" row for a user who chose email and has no mailbox now,
 * or null when the user has no recorded provider.
 */
export function mailboxNotConnectedIssue(
  recorded: ReadonlyArray<"outlook" | "gmail">,
): HealthConnectionIssue | null {
  const outlook = recorded.includes("outlook");
  const gmail = recorded.includes("gmail");
  if (!outlook && !gmail) return null;
  const base = {
    type: "NOT_CONNECTED" as const,
    severity: "warning" as const,
    action: "Connect",
  };
  if (outlook && gmail) {
    // One row for both. `provider` is the row's identity for dismissal
    // (healthIssueIdentity.ts); `connect-email` sends the user to both buttons.
    return {
      ...base,
      provider: "microsoft",
      userMessage: NOT_CONNECTED_MESSAGES.both,
      actionHandler: "connect-email",
    };
  }
  return outlook
    ? { ...base, provider: "microsoft", userMessage: NOT_CONNECTED_MESSAGES.outlook, actionHandler: "connect-microsoft" }
    : { ...base, provider: "google", userMessage: NOT_CONNECTED_MESSAGES.gmail, actionHandler: "connect-google" };
}
