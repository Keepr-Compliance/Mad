// ============================================
// LEARN: SENDERS YOU MARKED AS NEWSLETTERS — IPC HANDLERS (BACKLOG-4212 PR3)
// ============================================
//
// Two channels behind Settings › "Senders you marked as newsletters":
//   `learn:list-suppressed`  the caller's senders at or above the threshold
//                            (hidden now, or un-hidden by the user).
//   `learn:set-override`     "Stop hiding" (hide: false) / "Hide again"
//                            (hide: true) for one of them.
//
// Both are UNGATED (session only), on the same basis as learn:delete-answer:
// the list applies with Learn mode off, so a user can always see and undo it.
// The user id comes from the session, never from the payload; the payload of
// learn:set-override is a strict schema and anything else is refused.
//
// This file is separate from learnModeHandlers.ts on purpose (SR R5): that
// file hosts learn:score and the pilot report and must never reach the user
// list (learnIsolation-4212 pins it).
//
// PRIVACY. The reply carries addresses for the screen; logs carry counts only.
// Errors are logged by name. Nothing here is synced, exported or sent.

import { ipcMain } from "electron";
import type { IpcMainInvokeEvent } from "electron";

import logService from "../services/logService";
import sessionService from "../services/sessionService";
import { getActiveSenderRules } from "../services/senderRuleSetStore";
import { listSuppressedForSettings, setSenderOverride } from "../services/userSuppressService";
import { LearnSetOverrideArgsSchema } from "../schemas/learnMode";
import type {
  LearnFailure,
  LearnListSuppressedResult,
  LearnSetOverrideResult,
} from "../types/ipc/window-api-learn";

const MODULE = "LearnSuppress";

export const LEARN_SUPPRESS_CHANNELS = ["learn:list-suppressed", "learn:set-override"] as const;

export const SUPPRESS_NO_SESSION_ERROR = "Not signed in.";
export const SUPPRESS_INVALID_ERROR = "Invalid request.";
export const SUPPRESS_NOT_LISTED_ERROR = "That sender is not on your list.";
export const SUPPRESS_FAILED_ERROR = "Request failed.";

function fail(error: string): LearnFailure {
  return { success: false, error };
}

async function sessionUserId(): Promise<string | null> {
  try {
    const session = await sessionService.loadSession();
    const id = session?.user?.id;
    return typeof id === "string" && id.length > 0 ? id : null;
  } catch {
    return null;
  }
}

function guarded<A extends unknown[], R>(
  channel: string,
  body: (event: IpcMainInvokeEvent, ...args: A) => Promise<R>,
): (event: IpcMainInvokeEvent, ...args: A) => Promise<R | LearnFailure> {
  return async (event, ...args) => {
    try {
      return await body(event, ...args);
    } catch (error) {
      logService.warn("Learn suppress request failed", MODULE, {
        channel,
        errorName: error instanceof Error ? error.name : typeof error,
      });
      return fail(SUPPRESS_FAILED_ERROR);
    }
  };
}

export function registerLearnSuppressHandlers(): void {
  ipcMain.handle(
    "learn:list-suppressed",
    guarded("learn:list-suppressed", async (): Promise<LearnListSuppressedResult> => {
      // UNGATED: session only. Own rows only; any payload is ignored.
      const userId = await sessionUserId();
      if (!userId) return fail(SUPPRESS_NO_SESSION_ERROR);
      const senders = listSuppressedForSettings(userId, getActiveSenderRules().rules);
      logService.info("Learn suppressed senders listed", MODULE, {
        count: senders.length,
        hidden: senders.filter((s) => s.hidden).length,
      });
      return { success: true, senders };
    }),
  );

  ipcMain.handle(
    "learn:set-override",
    guarded("learn:set-override", async (_e, payload: unknown): Promise<LearnSetOverrideResult> => {
      // UNGATED: session only. Writes only the caller's own override rows.
      const userId = await sessionUserId();
      if (!userId) return fail(SUPPRESS_NO_SESSION_ERROR);
      const parsed = LearnSetOverrideArgsSchema.safeParse(payload);
      if (!parsed.success) return fail(SUPPRESS_INVALID_ERROR);
      const { senderKey, hide } = parsed.data;
      const outcome = setSenderOverride(userId, senderKey, hide, getActiveSenderRules().rules);
      if (outcome === "invalid") return fail(SUPPRESS_INVALID_ERROR);
      if (outcome === "not_listed") return fail(SUPPRESS_NOT_LISTED_ERROR);
      logService.info("Learn sender override set", MODULE, { hide });
      return { success: true, hidden: hide };
    }),
  );
}
