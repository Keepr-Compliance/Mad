/**
 * BACKLOG-3658 (founder): the extension shows NOTHING on the page when idle —
 * the legacy manual "Send to Keepr" button is gone, and so is its plumbing
 * (the worker's keepr-send-chat → POST /chat). A signed-in page only says it
 * is paired. A Sync job (job.js) is untouched.
 *
 * Mutations that turn this suite red:
 *   N1 content.js builds any element again                → "adds no element"
 *   N2 a stale Send box of an older instance is kept       → "removes a stale Send box"
 *   N3 the worker's manual-send route brought back         → "no manual-send plumbing"
 *   N4 the paired hello not sent / sent more than once     → "adds no element"
 */
export {};

import * as fs from "fs";
import * as path from "path";

const EXT = path.join(__dirname, "..", "..", "chrome-extension");
const src = (name: string) => fs.readFileSync(path.join(EXT, name), "utf8");

type Sent = Array<{ type: string; paired?: boolean }>;

function runContent(sent: Sent): void {
  (globalThis as Record<string, unknown>).chrome = {
    runtime: {
      sendMessage: (m: { type: string; paired?: boolean }, cb?: () => void) => {
        sent.push(m);
        if (cb) cb();
      },
      lastError: undefined,
    },
  };
  (globalThis as Record<string, unknown>).KeeprScan = { signInState: () => "signed_in" };
  delete (window as unknown as Record<string, unknown>).__keeprSendInstalled;
  new Function(src("content.js"))();
}

beforeEach(() => jest.useFakeTimers());
afterEach(() => {
  jest.clearAllTimers();
  jest.useRealTimers();
  delete (globalThis as Record<string, unknown>).chrome;
  delete (globalThis as Record<string, unknown>).KeeprScan;
  document.body.innerHTML = "";
});

describe("content.js: nothing on the page when idle", () => {
  it("adds no element to a signed-in conversation page; says paired once (N1, N4)", () => {
    document.body.innerHTML = "<div id='app'></div>";
    const before = document.body.innerHTML;
    const sent: Sent = [];
    runContent(sent);
    jest.advanceTimersByTime(5000);
    expect(document.body.innerHTML).toBe(before);
    expect(sent).toEqual([{ type: "keepr-hello", paired: true }]);
  });

  it("removes a stale Send box left by an older extension instance (N2)", () => {
    const stale = document.createElement("div");
    stale.id = "keepr-send-container";
    stale.textContent = "Send to Keepr";
    document.body.appendChild(stale);
    runContent([]);
    expect(document.getElementById("keepr-send-container")).toBeNull();
    // ...also when the old instance puts it back a moment later.
    document.body.appendChild(stale);
    jest.advanceTimersByTime(1100);
    expect(document.getElementById("keepr-send-container")).toBeNull();
  });
});

describe("no manual-send plumbing (N3)", () => {
  it("neither the page nor the worker sends a chat outside a Sync job", () => {
    expect(src("content.js")).not.toMatch(/keepr-send-chat|createElement|innerHTML|textContent/);
    expect(src("background.js")).not.toMatch(/keepr-send-chat|sendChat|\/chat`/);
    // The Sync job still posts its chats through the worker's job route.
    expect(src("job.js")).toMatch(/base \+ "\/chat"/);
  });
});
