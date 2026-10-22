/**
 * BACKLOG-4041: `auth:deep-link-license-blocked` carries exactly
 * { userId, blockReason } — from main, and through the preload bridge.
 *
 * Three guards, one per place the payload could widen again:
 *   1. the main-side factory returns exactly the two keys;
 *   2. main.ts sends this event from one call site, and it uses the factory;
 *   3. the real preload bridge forwards exactly the two keys to the renderer
 *      callback even when main sends more.
 */
import * as fs from "fs";
import * as path from "path";
import type { IpcRendererEvent } from "electron";

type Listener = (event: IpcRendererEvent, data: unknown) => void;
const listeners = new Map<string, Listener>();

jest.mock("electron", () => ({
  ipcRenderer: {
    on: (channel: string, listener: Listener) => {
      listeners.set(channel, listener);
    },
    removeListener: jest.fn(),
    send: jest.fn(),
    invoke: jest.fn(),
  },
}));

import { licenseBlockedPayload } from "../utils/deepLinkLicenseBlockedPayload";
import { eventBridge } from "../preload/eventBridge";

const CHANNEL = "auth:deep-link-license-blocked";
const USER_ID = "00000000-0000-0000-0000-000000000000";

describe("BACKLOG-4041: license-blocked event payload", () => {
  beforeEach(() => listeners.clear());

  it("main-side factory returns exactly userId and blockReason", () => {
    const payload = licenseBlockedPayload(USER_ID, "expired");
    expect(Object.keys(payload).sort()).toEqual(["blockReason", "userId"]);
    expect(payload).toEqual({ userId: USER_ID, blockReason: "expired" });
  });

  it("an absent block reason is sent as \"unknown\"", () => {
    expect(licenseBlockedPayload(USER_ID, undefined)).toEqual({
      userId: USER_ID,
      blockReason: "unknown",
    });
  });

  it("main.ts sends the event from exactly one call site, built by the factory", () => {
    const src = fs.readFileSync(path.join(__dirname, "..", "main.ts"), "utf8");
    const sites = src.split(`"${CHANNEL}"`).length - 1;
    expect(sites).toBe(1);
    const at = src.indexOf(`"${CHANNEL}"`);
    // The argument list after the channel name, up to the closing `);`.
    const args = src.slice(at, src.indexOf(");", at));
    expect(args).toMatch(/,\s*licenseBlockedPayload\(user\.id, licenseStatus\.blockReason\),?\s*$/);
  });

  it("the preload bridge forwards only userId and blockReason to the renderer callback", () => {
    const callback = jest.fn();
    const cleanup = eventBridge.onDeepLinkLicenseBlocked(callback);
    const listener = listeners.get(CHANNEL);
    expect(listener).toBeDefined();

    // What main sent before BACKLOG-4041, so the bridge is tested against the wider shape.
    listener!({} as IpcRendererEvent, {
      accessToken: "fixture-access-value",
      refreshToken: "fixture-refresh-value",
      userId: USER_ID,
      blockReason: "suspended",
      licenseStatus: { isValid: false, licenseType: "trial", blockReason: "suspended" },
    });

    expect(callback).toHaveBeenCalledTimes(1);
    const received = callback.mock.calls[0][0] as Record<string, unknown>;
    expect(Object.keys(received).sort()).toEqual(["blockReason", "userId"]);
    expect(received).toEqual({ userId: USER_ID, blockReason: "suspended" });
    expect(JSON.stringify(received)).not.toMatch(/fixture-(access|refresh)-value/);
    cleanup();
  });
});
