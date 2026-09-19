/**
 * `ElectronWindows` — the Electron shell's Windows (BACKLOG-2962, seams PR B).
 *
 * As with the PR A adapters, `tests/helpers/installTestCapabilities.js` installs
 * a call-time forwarder rather than this class, so **no other suite exercises
 * it.** The properties that would actually break the product are the two SKIP
 * GUARDS, the per-broadcast enumeration, and that channel and payload are passed
 * through untouched. All four are pinned here.
 */

import { BrowserWindow } from "electron";

import { ElectronWindows } from "../electronWindows";

type FakeWindow = {
  isDestroyed: jest.Mock;
  webContents: { send: jest.Mock } | null;
};

function win(opts: { destroyed?: boolean; hasWebContents?: boolean } = {}): FakeWindow {
  return {
    isDestroyed: jest.fn(() => opts.destroyed === true),
    webContents: opts.hasWebContents === false ? null : { send: jest.fn() },
  };
}

const getAllWindows = jest.fn<FakeWindow[], []>(() => []);

beforeAll(() => {
  // The shared `tests/__mocks__/electron.js` mocks `BrowserWindow` as a
  // CONSTRUCTOR and gives it no `getAllWindows` static — which is correct, since
  // nothing but this adapter needs one. Attach it here rather than widening the
  // shared mock, so no other suite's view of `electron` changes.
  (BrowserWindow as unknown as { getAllWindows: unknown }).getAllWindows = getAllWindows;
});

describe("ElectronWindows (BACKLOG-2962)", () => {
  beforeEach(() => {
    getAllWindows.mockReset();
    getAllWindows.mockReturnValue([]);
  });

  it("sends the channel and the payload to every live window, untouched", () => {
    const a = win();
    const b = win();
    getAllWindows.mockReturnValue([a, b]);
    const payload = { stage: "db-ready", message: "Ready" };

    new ElectronWindows().broadcast("system:init-stage", payload);

    expect(a.webContents!.send).toHaveBeenCalledWith("system:init-stage", payload);
    expect(b.webContents!.send).toHaveBeenCalledWith("system:init-stage", payload);
    // BY REFERENCE. An adapter that spread the payload into a new object would
    // pass every `toHaveBeenCalledWith` above and still be a different message.
    expect(a.webContents!.send.mock.calls[0][1]).toBe(payload);
  });

  it("SKIPS a destroyed window — Electron throws on a closed window's webContents", () => {
    const dead = win({ destroyed: true });
    const live = win();
    getAllWindows.mockReturnValue([dead, live]);

    new ElectronWindows().broadcast("review:queue-changed", { transactionId: "t1" });

    expect(dead.webContents!.send).not.toHaveBeenCalled();
    expect(live.webContents!.send).toHaveBeenCalledTimes(1);
  });

  it("SKIPS a window with no webContents — reading .send off undefined is a TypeError", () => {
    const torn = win({ hasWebContents: false });
    const live = win();
    getAllWindows.mockReturnValue([torn, live]);

    expect(() =>
      new ElectronWindows().broadcast("system:init-stage", { stage: "idle" }),
    ).not.toThrow();
    expect(live.webContents!.send).toHaveBeenCalledTimes(1);
  });

  it("no windows open is a successful no-op", () => {
    getAllWindows.mockReturnValue([]);
    expect(() => new ElectronWindows().broadcast("c", 1)).not.toThrow();
  });

  it("enumerates on EVERY broadcast, never once at construction", () => {
    // The set of open windows is the thing that changes. A cached list would
    // send to a window that has since closed and miss one that has since opened.
    const w = new ElectronWindows();
    expect(getAllWindows).not.toHaveBeenCalled();
    w.broadcast("c", 1);
    w.broadcast("c", 2);
    expect(getAllWindows).toHaveBeenCalledTimes(2);
  });

  it("does NOT catch: a throwing send aborts the rest and reaches the caller", () => {
    // Deliberate. The two call sites handle delivery failure differently —
    // `initializationBroadcaster` logs it at debug, `reviewStateService` swallows
    // it — so catching here would make both handlers unreachable and silently
    // change the logging one.
    const boom = win();
    boom.webContents!.send.mockImplementation(() => {
      throw new Error("Object has been destroyed");
    });
    const after = win();
    getAllWindows.mockReturnValue([boom, after]);

    expect(() => new ElectronWindows().broadcast("c", 1)).toThrow("Object has been destroyed");
    expect(after.webContents!.send).not.toHaveBeenCalled();
  });
});
