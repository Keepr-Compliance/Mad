/**
 * The composition seam for {@link Dialog} (BACKLOG-2962, seam 5 of 5).
 *
 * Same shape as the other four providers: core modules bind {@link hostDialog},
 * a forwarder that resolves to whatever the host shell installed.
 *
 * ORDERING
 * --------
 * {@link hostDialog} forwards at CALL time, and no core module shows a dialog
 * during module construction — all three call sites are inside
 * `DatabaseService.initialize()`'s error handling, which runs long after the
 * composition root. Nothing is captured at install time.
 *
 * @module electron/capabilities/dialogProvider
 */

import { UnavailableDialog, type Dialog } from "./dialog";

let installed: Dialog = new UnavailableDialog();

/**
 * Install the host shell's implementation. Called once, from the shell's
 * composition root. Calling it again replaces the implementation, which is what
 * lets a test swap in a fake.
 */
export function installDialog(dialog: Dialog): void {
  installed = dialog;
}

/**
 * Drop back to the throwing {@link UnavailableDialog}.
 *
 * For tests that need to assert the uninstalled behaviour. Production code has
 * no reason to call this.
 */
export function resetDialog(): void {
  installed = new UnavailableDialog();
}

/** The currently installed implementation. */
export function getDialog(): Dialog {
  return installed;
}

/**
 * Whether a host shell has installed a real implementation (BACKLOG-2962).
 *
 * The `instanceof` check lives HERE, beside the only `new UnavailableDialog()`
 * sites, for the reason `secretStoreProvider` records: `jest.isolateModules`
 * gives a class loaded twice two distinct constructors, and an `instanceof`
 * written across that boundary answers `false` for an object that really is one.
 */
export function isDialogInstalled(): boolean {
  return !(installed instanceof UnavailableDialog);
}

/**
 * A {@link Dialog} that forwards each call to the installed implementation at
 * the moment of the call.
 */
export const hostDialog: Dialog = {
  showMessageBox: (request) => installed.showMessageBox(request),
};
