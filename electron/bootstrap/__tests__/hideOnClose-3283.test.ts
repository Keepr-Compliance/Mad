/**
 * @jest-environment node
 *
 * BACKLOG-3283: on macOS closing the main window hides it; a quit lets it close.
 */
import { EventEmitter } from "events";
import { attachHideOnClose } from "../hideOnClose";
import { clearQuitting, markQuitting } from "../quitState";

class FakeWindow extends EventEmitter {
  hidden = false;
  destroyed = false;
  hide() { this.hidden = true; }
  /** Electron: the close proceeds (window destroyed) unless a listener prevents it. */
  close() {
    let prevented = false;
    this.emit("close", { preventDefault: () => { prevented = true; } });
    if (!prevented) this.destroyed = true;
  }
}

afterEach(() => clearQuitting());

describe("hide on close (BACKLOG-3283)", () => {
  it("macOS, not quitting: close hides the window and does not destroy it", () => {
    const win = new FakeWindow();
    attachHideOnClose(win, "darwin");
    win.close();
    expect({ hidden: win.hidden, destroyed: win.destroyed }).toEqual({ hidden: true, destroyed: false });
  });

  it("macOS, quitting: close goes through (Cmd+Q, menu Quit, update install)", () => {
    const win = new FakeWindow();
    attachHideOnClose(win, "darwin");
    markQuitting();
    win.close();
    expect({ hidden: win.hidden, destroyed: win.destroyed }).toEqual({ hidden: false, destroyed: true });
  });

  it.each(["win32", "linux"] as const)("%s: nothing is attached, close destroys the window", (platform) => {
    const win = new FakeWindow();
    attachHideOnClose(win, platform);
    expect(win.listenerCount("close")).toBe(0);
    win.close();
    expect({ hidden: win.hidden, destroyed: win.destroyed }).toEqual({ hidden: false, destroyed: true });
  });
});
