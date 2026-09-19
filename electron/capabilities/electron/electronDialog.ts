/**
 * The Electron shell's {@link Dialog}: `dialog.showMessageBox`
 * (BACKLOG-2962, seam 5).
 *
 * THE REQUEST IS FORWARDED BY REFERENCE, NOT REBUILT
 * ---------------------------------------------------
 * `dialog.showMessageBox(request)` — not `showMessageBox({ type: request.type,
 * … })`. The same choice `ElectronErrorReporter` makes for Sentry options, and
 * for the same measured reason: an adapter that rebuilds the object can drop a
 * key, and no assertion written against the adapter's own fixture would notice,
 * because the fixture would be the input and the expectation at once.
 * `MessageBoxRequest`'s five keys are a structural subset of Electron's
 * `MessageBoxOptions`, so this is a plain pass-through.
 *
 * The result is passed back unchanged for the same reason. No core caller reads
 * it today; two `await` it so the box is dismissed before the app exits.
 *
 * WHAT THIS DOES NOT DO
 * ---------------------
 * No parent window is attached. All three call sites ran the window-less
 * `showMessageBox(options)` overload, and they run during database
 * initialisation when there may be no window to parent to. Attaching one would
 * change modality on macOS from app-modal to sheet.
 *
 * @module electron/capabilities/electron/electronDialog
 */

import { dialog } from "electron";

import type { Dialog, MessageBoxRequest, MessageBoxResult } from "../dialog";

/** {@link Dialog} backed by Electron's `dialog.showMessageBox`. */
export class ElectronDialog implements Dialog {
  showMessageBox(request: MessageBoxRequest): Promise<MessageBoxResult> {
    return dialog.showMessageBox(request);
  }
}
