/**
 * `ElectronDialog` — the Electron shell's Dialog (BACKLOG-2962, seams PR B).
 *
 * WHY THIS SUITE EXISTS, AND HOW ITS ABSENCE WAS FOUND
 * -----------------------------------------------------
 * `tests/helpers/installTestCapabilities.js` installs a call-time forwarder, not
 * this class, so **no other suite in the tree exercises it** — the structural
 * blindness SR recorded as S4 while reviewing PR #2523.
 *
 * It was not written on principle. It was written because a pre-registered
 * control refused to go red: rewriting `showMessageBox` to destructure four keys
 * and rebuild the object — silently dropping `buttons` — left all 167 capability
 * tests GREEN. `dialogProvider.test.ts` pins by-reference forwarding for
 * `hostDialog`, and `databaseService`'s suites assert against the option object
 * the PRODUCTION code builds, so neither can see an adapter that mangles it on
 * the way out. That mutation now reds here.
 */

import { dialog } from "electron";

import { ElectronDialog } from "../electronDialog";
import type { MessageBoxRequest } from "../../dialog";

const mockShowMessageBox = dialog.showMessageBox as unknown as jest.Mock;

/** Transcribed from `databaseService.ts:487-506` — the refusal box. */
const REFUSAL: MessageBoxRequest = {
  type: "error",
  title: "Database from an older version",
  message: "This database was created by an older version of Keepr and cannot be opened.",
  detail: "Keepr reset its local database format…",
  buttons: ["Quit"],
};

describe("ElectronDialog (BACKLOG-2962)", () => {
  beforeEach(() => {
    mockShowMessageBox.mockClear();
    mockShowMessageBox.mockResolvedValue({ response: 0 });
  });

  it("hands the request object to Electron BY REFERENCE — no key rebuilt", async () => {
    await new ElectronDialog().showMessageBox(REFUSAL);
    expect(mockShowMessageBox).toHaveBeenCalledTimes(1);
    // Identity, not deep equality. This is the assertion the missing suite cost:
    // an adapter that destructured `{type, title, message, detail}` and rebuilt
    // the object would satisfy `toHaveBeenCalledWith(expect.objectContaining(…))`
    // while dropping the button labels entirely.
    expect(mockShowMessageBox.mock.calls[0][0]).toBe(REFUSAL);
  });

  it("calls the window-less overload — exactly one argument", async () => {
    // All three replaced call sites used `showMessageBox(options)`. Attaching a
    // parent window would change macOS modality from app-modal to a sheet, and
    // these run during database init when there may be no window at all.
    await new ElectronDialog().showMessageBox(REFUSAL);
    expect(mockShowMessageBox.mock.calls[0]).toHaveLength(1);
  });

  it("returns Electron's result unchanged", async () => {
    mockShowMessageBox.mockResolvedValueOnce({ response: 2, checkboxChecked: false });
    await expect(new ElectronDialog().showMessageBox(REFUSAL)).resolves.toEqual({
      response: 2,
      checkboxChecked: false,
    });
  });

  it("constructing it shows nothing", async () => {
    new ElectronDialog();
    expect(mockShowMessageBox).not.toHaveBeenCalled();
  });
});
