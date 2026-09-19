/**
 * The host's modal message box, as an interface (BACKLOG-2962, seam 5 of 5).
 *
 * WHY THIS EXISTS
 * ---------------
 * BACKLOG-2961's compiler measurement (`pm_comments` `4c10fdb4` §4) left three
 * `dialog.showMessageBox` calls in the extraction closure, all in
 * `databaseService.ts` (`:346`, `:394`, `:490`). Every one of them is on a
 * terminal or near-terminal database path — a migration that failed, a restore
 * that recovered, a database with no upgrade path — and each is the ONLY thing
 * that tells the user why the app is about to stop being useful.
 *
 * WHAT THIS IS NOT
 * ----------------
 * Not a wrapper for Electron's `dialog`. That module has open, save, certificate
 * and error-box APIs and `MessageBoxOptions` carries some fifteen keys; a seam
 * exposing them would be describing Electron rather than describing what the
 * core needs — the rule `appPaths.ts` states for having a single `userData()`
 * accessor. Enumerated by the compiler, the three call sites pass **exactly five
 * keys** (`type`, `title`, `message`, `detail`, `buttons`) and `type` is only
 * ever `"error"` or `"warning"`. So that is the whole request shape, and a sixth
 * key is added when the first core caller needs one.
 *
 * `dialog.showErrorBox` is deliberately absent. Its one use is in
 * `electron/bootstrap/installNativeCapabilities.ts`, which is the SHELL: it runs
 * before any capability is trusted, and routing "a capability is missing"
 * through a capability would be circular. That file keeps its own direct import
 * and says so.
 *
 * THE RESULT IS FORWARDED, NOT DISCARDED
 * --------------------------------------
 * None of the three call sites reads the return value today — two `await` it for
 * ordering (the dialog must be dismissed before the app exits) and one does not
 * await at all. Returning `Promise<MessageBoxResult>` anyway means the adapter
 * hands back what the platform gave it instead of rebuilding a shape, which is
 * one fewer place a key can be dropped, and a caller that later needs the
 * button index does not have to change the interface to get it.
 *
 * @module electron/capabilities/dialog
 */

/**
 * The kinds of message box the core asks for.
 *
 * Two, because the call sites use two. Electron offers `"none"`, `"info"` and
 * `"question"` as well; none of them appears in the core and none is added on
 * spec.
 */
export type MessageBoxKind = "error" | "warning";

/**
 * A modal message box the core wants shown.
 *
 * Every field is REQUIRED, matching all three call sites: a dialog missing its
 * `detail` on a terminal database failure is a worse bug than a compile error.
 * Implementations must pass this object to the platform unaltered — see
 * `electronDialog.ts` for why it is forwarded by reference.
 */
export interface MessageBoxRequest {
  /** Icon and severity. */
  readonly type: MessageBoxKind;
  /** Window title. Read by the founder in a support conversation. */
  readonly title: string;
  /** The bold headline. */
  readonly message: string;
  /** The body, including any database path or remediation steps. */
  readonly detail: string;
  /** Button labels, in order. Index 0 is the default. */
  readonly buttons: string[];
}

/** What the host reports once the box is dismissed. */
export interface MessageBoxResult {
  /** Index into {@link MessageBoxRequest.buttons} of the button chosen. */
  readonly response: number;
}

/** Raised by {@link UnavailableDialog}. */
export class DialogUnavailableError extends Error {
  constructor(title: string) {
    super(
      `No dialog is installed, so the message box "${title}" cannot be shown. ` +
        "The host shell must install a Dialog at its composition root before any " +
        "code reaches this capability (Electron does so in " +
        "electron/bootstrap/installNativeCapabilities.ts).",
    );
    this.name = "DialogUnavailableError";
  }
}

/**
 * A {@link Dialog} that throws instead of showing anything.
 *
 * THIS ONE THROWS, WHERE `SilentWindows` DOES NOT — and the asymmetry is forced
 * by what the callers do next, not chosen. `Windows.broadcast` sits inside a
 * `catch` that treats undelivered as ordinary, because a window really can be
 * absent. A message box is different: all three call sites are on paths where
 * the app is about to quit or has just lost a migration, two of them `await` the
 * box precisely so the user reads it BEFORE the process ends, and none of them
 * catches. A silent default there would exit the app with no explanation — the
 * exact failure the dialogs exist to prevent — and every happy-path test would
 * pass.
 *
 * It names the box's title so the thrown error says which one went missing.
 */
export class UnavailableDialog implements Dialog {
  showMessageBox(request: MessageBoxRequest): Promise<MessageBoxResult> {
    throw new DialogUnavailableError(request.title);
  }
}

/**
 * The host's modal dialogs, as far as the core is concerned.
 *
 * One method, because the core asks for one thing.
 */
export interface Dialog {
  /**
   * Show a modal message box and resolve once it is dismissed.
   *
   * Implementations MUST pass `request` to the platform unaltered — no key
   * rebuilt, none defaulted, none dropped.
   */
  showMessageBox(request: MessageBoxRequest): Promise<MessageBoxResult>;
}
