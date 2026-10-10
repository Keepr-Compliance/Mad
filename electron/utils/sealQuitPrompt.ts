/**
 * BACKLOG-3816: a quit the USER starts while the kept iPhone backup is being secured
 * (post-sync seal, recovery reseal, launch migration) asks first:
 *
 *   Securing your iPhone backup (N%)
 *   Quit now? Securing will finish next time you open Keepr.
 *   [Keep running] [Quit anyway]
 *
 * Keep running cancels the quit and the seal pass carries on. Quit anyway issues the
 * quit again, which then runs the existing deferrals in their order (backup stop, link
 * wait, index seal). Not asked for an OS shutdown / restart / logout, for Restart to
 * update, or when no seal pass is running. One dialog per quit: a further quit while it
 * is open is held, not stacked.
 *
 * `before-quit` handlers are synchronous, so — as in createBackupStopOnQuit — the check
 * cancels this quit, asks, and quits again on "Quit anyway".
 */
import type { QuitEventLike, QuittableApp } from "./backupStopOnQuit";

export const SEAL_QUIT_PROMPT_DETAIL = "Quit now? Securing will finish next time you open Keepr.";
export const SEAL_QUIT_KEEP_RUNNING = "Keep running";
export const SEAL_QUIT_QUIT_ANYWAY = "Quit anyway";

export function sealQuitPromptHeading(percent: number): string {
  return `Securing your iPhone backup (${percent}%)`;
}

/** Why a quit is not the user's: the prompt is never shown for these. */
export type SystemQuitReason = "os-shutdown" | "update";

export interface SealQuitPromptDeps {
  app: QuittableApp;
  /** Percentage of the running seal pass, or null when none is running. */
  sealPercent: () => number | null;
  /**
   * Shows the dialog. Resolves "quit" for Quit anyway, "keep" otherwise (including a
   * dialog closed by `signal`). Rejecting counts as "quit": a quit is never swallowed.
   */
  ask: (percent: number, signal: AbortSignal) => Promise<"keep" | "quit">;
  log?: (message: string, meta?: Record<string, unknown>) => void;
}

export interface SealQuitPrompt {
  /**
   * The check for `before-quit` (and, on Windows, the main window's `close`). True when
   * it held the quit; the caller must then return without running anything else.
   */
  check(event: QuitEventLike): boolean;
  /** The quit in progress (or the next one) is not the user's: never ask. */
  noteSystemQuit(reason: SystemQuitReason): void;
}

export function createSealQuitPrompt(deps: SealQuitPromptDeps): SealQuitPrompt {
  // "idle" -> "asking" (dialog open) -> "idle" (Keep running) | "proceed" (Quit anyway).
  let state: "idle" | "asking" | "proceed" = "idle";
  let systemQuit: SystemQuitReason | null = null;
  let open: AbortController | null = null;

  const proceed = (why: string) => {
    state = "proceed";
    deps.log?.("[Quit] quitting while the iPhone backup is being secured", { why });
    deps.app.quit();
  };

  return {
    noteSystemQuit(reason) {
      systemQuit = reason;
      // A shutdown that arrives while the dialog is open must not wait on the user.
      open?.abort();
    },
    check(event) {
      if (state === "proceed" || systemQuit) return false;
      if (state === "asking") {
        event.preventDefault();
        return true;
      }
      let percent: number | null;
      try {
        percent = deps.sealPercent();
      } catch {
        percent = null;
      }
      if (percent === null) return false;
      state = "asking";
      event.preventDefault();
      const controller = new AbortController();
      open = controller;
      let asked: Promise<"keep" | "quit">;
      try {
        asked = deps.ask(percent, controller.signal);
      } catch (error) {
        asked = Promise.reject(error);
      }
      asked.then(
        (choice) => {
          open = null;
          if (systemQuit) return proceed(systemQuit);
          if (choice === "quit") return proceed("quit anyway");
          state = "idle";
          deps.log?.("[Quit] quit cancelled; securing the iPhone backup continues", { percent });
        },
        () => {
          open = null;
          proceed("dialog failed");
        },
      );
      return true;
    },
  };
}

// The app's one prompt. The updater and the shutdown listeners mark a quit as not the
// user's through `noteSystemQuit`, which may run before the prompt is installed.
let installed: SealQuitPrompt | null = null;
let pendingSystemQuit: SystemQuitReason | null = null;

export function installSealQuitPrompt(prompt: SealQuitPrompt): SealQuitPrompt {
  installed = prompt;
  if (pendingSystemQuit) prompt.noteSystemQuit(pendingSystemQuit);
  return prompt;
}

export function noteSystemQuit(reason: SystemQuitReason): void {
  pendingSystemQuit = reason;
  installed?.noteSystemQuit(reason);
}

/** Tests only. */
export function resetSealQuitPromptForTests(): void {
  installed = null;
  pendingSystemQuit = null;
}
