/**
 * The Dialog composition seam (BACKLOG-2962, seams PR B).
 *
 * Mirrors `appPathsProvider.test.ts`: this default THROWS, and the reason is
 * asserted rather than described. All three call sites are on terminal or
 * near-terminal database paths, two of them `await` the box precisely so the
 * user reads it before the process ends, and none of them catches. A silent
 * default would quit the app with no explanation — the exact failure the
 * dialogs exist to prevent — while every happy-path test passed.
 */

import {
  DialogUnavailableError,
  UnavailableDialog,
  type Dialog,
  type MessageBoxRequest,
} from "../dialog";
import {
  getDialog,
  hostDialog,
  installDialog,
  isDialogInstalled,
  resetDialog,
} from "../dialogProvider";

/** Transcribed from `databaseService.ts:487-506` — the refusal box. */
const REFUSAL: MessageBoxRequest = {
  type: "error",
  title: "Database from an older version",
  message: "This database was created by an older version of Keepr and cannot be opened.",
  detail: "Keepr reset its local database format…",
  buttons: ["Quit"],
};

function recorder(): { dialog: Dialog; shown: MessageBoxRequest[] } {
  const shown: MessageBoxRequest[] = [];
  return {
    shown,
    dialog: {
      showMessageBox: async (request) => {
        shown.push(request);
        return { response: 0 };
      },
    },
  };
}

describe("dialogProvider (BACKLOG-2962)", () => {
  afterEach(() => {
    // tests/setup.js installed one for this file; put a real one back so no
    // later case in this file inherits the throwing default.
    installDialog(recorder().dialog);
  });

  it("reports NOT installed while the throwing default is in force", () => {
    resetDialog();
    expect(isDialogInstalled()).toBe(false);
    expect(getDialog()).toBeInstanceOf(UnavailableDialog);
  });

  it("the default THROWS a named error naming the box that went missing", () => {
    resetDialog();
    expect(() => hostDialog.showMessageBox(REFUSAL)).toThrow(DialogUnavailableError);
    expect(() => hostDialog.showMessageBox(REFUSAL)).toThrow(
      /Database from an older version/,
    );
    expect(() => hostDialog.showMessageBox(REFUSAL)).toThrow(/installNativeCapabilities/);
  });

  it("forwards the request BY REFERENCE — no key rebuilt, none defaulted", async () => {
    const { dialog, shown } = recorder();
    installDialog(dialog);
    await hostDialog.showMessageBox(REFUSAL);
    expect(shown).toHaveLength(1);
    // Identity, not deep equality: a forwarder that spread the request into a
    // new object could drop `buttons` and still satisfy `toEqual`.
    expect(shown[0]).toBe(REFUSAL);
  });

  it("returns the platform's result unchanged", async () => {
    installDialog({ showMessageBox: async () => ({ response: 3 }) });
    await expect(hostDialog.showMessageBox(REFUSAL)).resolves.toEqual({ response: 3 });
  });

  it("forwards at CALL time, not at bind time", () => {
    // `databaseService` binds `hostDialog` when its module loads, which is
    // before any shell has installed anything.
    resetDialog();
    const bound = hostDialog;
    const { dialog, shown } = recorder();
    installDialog(dialog);
    void bound.showMessageBox(REFUSAL);
    expect(shown).toHaveLength(1);
  });

  it("installing twice replaces the implementation", async () => {
    const first = recorder();
    const second = recorder();
    installDialog(first.dialog);
    installDialog(second.dialog);
    await hostDialog.showMessageBox(REFUSAL);
    expect(first.shown).toHaveLength(0);
    expect(second.shown).toHaveLength(1);
  });

  it("resetDialog puts the throwing default back", () => {
    installDialog(recorder().dialog);
    expect(isDialogInstalled()).toBe(true);
    resetDialog();
    expect(isDialogInstalled()).toBe(false);
  });
});
