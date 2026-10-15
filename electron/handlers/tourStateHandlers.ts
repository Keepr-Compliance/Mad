// ============================================
// DASHBOARD TOUR STATE IPC HANDLERS (BACKLOG-3674)
// Handles: the per-account "tour dismissed" record (users.tour_dismissed_at)
// ============================================
//
// - Both act on the SESSION user (supabaseService.getAuthUserId()). Neither
//   accepts a user id from the renderer; any argument is ignored.
// - There is no local copy of this record. When the server cannot be read the
//   answer is "unknown", and the renderer shows no tour this run.

import { ipcMain } from "electron";
import * as Sentry from "@sentry/electron/main";
import supabaseService from "../services/supabaseService";
import logService from "../services/logService";

export type TourState = "dismissed" | "not-dismissed" | "unknown";

export interface GetTourStateResult {
  success: boolean;
  tour: TourState;
  error?: string;
}

const MODULE = "TourState";

/** Upper bound on the server read; past this the answer is "unknown". */
export const TOUR_STATE_READ_TIMEOUT_MS = 8000;

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`tour state read timed out after ${ms} ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

/** Read the record for the session user. Never throws. */
export async function getTourState(): Promise<GetTourStateResult> {
  const userId = supabaseService.getAuthUserId();
  if (!userId) {
    return { success: false, tour: "unknown", error: "No session user" };
  }

  try {
    const record = await withTimeout(
      supabaseService.getTourDismissedAt(userId),
      TOUR_STATE_READ_TIMEOUT_MS,
    );
    return { success: true, tour: record.tourDismissedAt ? "dismissed" : "not-dismissed" };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logService.warn("[TourState] Tour state read failed; no tour this run", MODULE, { error: message });
    return { success: false, tour: "unknown", error: message };
  }
}

/**
 * Write the record for the session user (keeps the first timestamp). A failure
 * is logged and reported to Sentry and returned as `success: false` -- never as
 * success.
 */
export async function dismissTour(): Promise<{ success: boolean; error?: string }> {
  const userId = supabaseService.getAuthUserId();
  if (!userId) {
    logService.warn("[TourState] No session user; tour-dismissed record not written", MODULE);
    return { success: false, error: "No session user" };
  }

  try {
    await supabaseService.dismissTour(userId);
    logService.info("[TourState] Tour-dismissed record written", MODULE);
    return { success: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logService.error("[TourState] Tour-dismissed record write failed", MODULE, { error: message });
    Sentry.captureException(error, {
      tags: { service: "tour-state", operation: "dismissTour" },
    });
    return { success: false, error: message };
  }
}

/** Register the tour-state IPC handlers. */
export function registerTourStateHandlers(): void {
  // Any renderer-supplied arguments are ignored on purpose: the session user
  // is the only account these handlers act on.
  ipcMain.handle("user:get-tour-state", () => getTourState());
  ipcMain.handle("user:dismiss-tour", () => dismissTour());
}
