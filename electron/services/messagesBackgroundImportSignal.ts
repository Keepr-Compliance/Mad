/**
 * Background-import signal — BACKLOG-2772
 *
 * Announces a macOS Messages import that the RENDERER did not start, so the
 * renderer can mirror it into the sync queue and give it a Cancel button.
 *
 * ## Why this exists rather than "route the trigger through the orchestrator"
 *
 * The spec asks for the transaction trigger to go "through the orchestrator".
 * The orchestrator is `src/services/SyncOrchestratorService.ts` — it lives in
 * the RENDERER, is instantiated only when `typeof window !== "undefined"`, and
 * every sync function it registers dereferences `window.api`. Main-process code
 * cannot enqueue on it and must not import from `src/`.
 *
 * So the routing takes the only shape the boundary allows, and it is one the
 * codebase already runs: the EXTERNAL sync item. `registerExternalSync` /
 * `completeExternalSync` exist precisely for syncs the orchestrator does not
 * drive, and the iPhone sync has used them since BACKLOG-2195. Main announces;
 * the renderer mirrors.
 *
 * What that buys is exactly what was missing: a queue item, and therefore the
 * Cancel button. The cancel MECHANISM was never the gap —
 * `MESSAGES_IMPORT_CANCEL_CHANNEL` calls
 * `macOSMessagesImportService.requestCancellation()`, which is global to the
 * service and would already have stopped a trigger-driven run. What did not
 * exist was any surface from which a user could press it.
 */

import { BrowserWindow } from "electron";
import logService from "./logService";
import {
  MESSAGES_BACKGROUND_IMPORT_STARTED_CHANNEL,
  MESSAGES_BACKGROUND_IMPORT_FINISHED_CHANNEL,
} from "../types/ipc/messageChannels";

const SERVICE_NAME = "MessagesBackgroundImportSignal";

/*
 * Payload both events carry.
 *
 * Imported rather than re-declared: this is a wire shape crossing the
 * main/preload boundary, and a hand-maintained copy on each side is a rule kept
 * by hand. Both files live in `electron/`, so a field added on one side is now
 * a compile error on the other instead of a silent disagreement.
 */
export type { BackgroundImportSignal } from "../types/ipc/window-api-messages";
import type { BackgroundImportSignal } from "../types/ipc/window-api-messages";

/**
 * Broadcast to every window, matching `initializationBroadcaster`'s pattern.
 *
 * Never throws. A signal that cannot be delivered must not take down the import
 * it is describing — the run is the product, the queue item is the UI for it.
 */
function broadcast(channel: string, payload: BackgroundImportSignal): void {
  try {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed() && win.webContents) {
        win.webContents.send(channel, payload);
      }
    }
  } catch (error) {
    logService.warn(
      `Could not broadcast ${channel}; the import continues without a queue item`,
      SERVICE_NAME,
      { error: error instanceof Error ? error.message : String(error) }
    );
  }
}

/** A main-initiated messages import has begun. */
export function emitBackgroundImportStarted(userId: string, reason: string): void {
  broadcast(MESSAGES_BACKGROUND_IMPORT_STARTED_CHANNEL, { userId, reason });
}

/**
 * A main-initiated messages import has ended — for ANY reason, including a
 * throw. Callers put this in a `finally`: a start with no finish leaves a queue
 * item spinning forever with a Cancel button that stops nothing.
 */
export function emitBackgroundImportFinished(userId: string, reason: string): void {
  broadcast(MESSAGES_BACKGROUND_IMPORT_FINISHED_CHANNEL, { userId, reason });
}
