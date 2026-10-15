/**
 * BACKLOG-3927: the Microsoft Store build never contacts the update feed.
 * Behaviour of the gate, plus a text check that both of main.ts's automatic
 * checks (startup and the 4-hour timer) go through it — main.ts has no seam a
 * behavioural test can load (same approach as mainResponsiveIdle-3833).
 */
import * as fs from "fs";
import * as path from "path";

let mockStore = false;
jest.mock("../distributionChannelService", () => ({ isStoreBuild: () => mockStore }));
jest.mock("electron-log", () => ({ info: jest.fn(), warn: jest.fn() }));

import { checkForUpdatesUnlessStore, isSelfUpdateDisabled } from "../selfUpdatePolicy";

describe("checkForUpdatesUnlessStore (BACKLOG-3927)", () => {
  it.each(["startup", "periodic"] as const)("Store build, %s: returns null and never calls the updater", (trigger) => {
    mockStore = true;
    const updater = { checkForUpdates: jest.fn() };
    expect(checkForUpdatesUnlessStore(updater, trigger)).toBeNull();
    expect(updater.checkForUpdates).not.toHaveBeenCalled();
    expect(isSelfUpdateDisabled()).toBe(true);
  });

  it("website build: the check runs and its promise is returned", () => {
    mockStore = false;
    const p = Promise.resolve(null);
    const updater = { checkForUpdates: jest.fn(() => p) };
    expect(checkForUpdatesUnlessStore(updater, "startup")).toBe(p);
    expect(updater.checkForUpdates).toHaveBeenCalledTimes(1);
    expect(isSelfUpdateDisabled()).toBe(false);
  });
});

const MAIN = fs.readFileSync(path.resolve(__dirname, "../../main.ts"), "utf8");

describe("main.ts automatic update checks go through the Store gate (BACKLOG-3927)", () => {
  it("no direct autoUpdater.checkForUpdates call anywhere in main.ts", () => {
    expect(MAIN.match(/autoUpdater\s*\.\s*checkForUpdates\s*\(/g)).toBeNull();
  });

  it("startup check (after the window loads) uses the gate", () => {
    expect(MAIN).toMatch(/checkForUpdatesUnlessStore\(autoUpdater, "startup"\)[\s\S]{0,600}?\}, UPDATE_CHECK_DELAY\)/);
  });

  it("4-hour periodic check uses the gate", () => {
    expect(MAIN).toMatch(/checkForUpdatesUnlessStore\(autoUpdater, "periodic"\)[\s\S]{0,1200}?\}, UPDATE_CHECK_INTERVAL\)/);
  });
});
