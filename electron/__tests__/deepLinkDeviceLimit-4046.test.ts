/**
 * BACKLOG-4046: the deep-link device-limit event carries exactly
 * { userId, deviceCount, deviceLimit } — from main, and through the preload
 * bridge.
 *
 * Three guards, one per place the payload could widen again:
 *   1. the main-side factory returns exactly the three keys;
 *   2. across every non-test file under electron/ (preload aside), only
 *      main.ts names the channel, from one call site that uses the factory;
 *   3. the real preload bridge forwards exactly the three keys to the
 *      renderer callback even when main sends more.
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

import { deviceLimitPayload } from "../utils/deepLinkDeviceLimitPayload";
import { eventBridge } from "../preload/eventBridge";

const CHANNEL = "auth:deep-link-device-limit";
const USER_ID = "00000000-0000-0000-0000-000000000000";
// The channel as a string literal in any quote style (comments that name it
// without quotes do not count).
const CHANNEL_LITERAL = /["'`]auth:deep-link-device-limit["'`]/;
const ELECTRON_DIR = path.join(__dirname, "..");

/** Every non-test .ts file under electron/, excluding preload/ and node_modules. */
function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (["preload", "__tests__", "__mocks__", "node_modules"].includes(entry.name)) continue;
      out.push(...sourceFiles(full));
    } else if (
      entry.isFile() &&
      /\.ts$/.test(entry.name) &&
      !/\.(test|spec)\.ts$/.test(entry.name) &&
      !/\.d\.ts$/.test(entry.name)
    ) {
      out.push(full);
    }
  }
  return out;
}

describe("BACKLOG-4046: device-limit event payload", () => {
  beforeEach(() => listeners.clear());

  it("main-side factory returns exactly userId, deviceCount and deviceLimit", () => {
    // The whole validation result, as main holds it at the call site.
    const licenseStatus = {
      isValid: true,
      licenseType: "trial" as const,
      transactionCount: 0,
      transactionLimit: 5,
      canCreateTransaction: true,
      deviceCount: 3,
      deviceLimit: 2,
      aiEnabled: false,
    };
    const payload = deviceLimitPayload(USER_ID, licenseStatus);
    expect(Object.keys(payload).sort()).toEqual(["deviceCount", "deviceLimit", "userId"]);
    expect(payload).toEqual({ userId: USER_ID, deviceCount: 3, deviceLimit: 2 });
  });

  it("only main.ts names the channel outside preload, from one call site built by the factory", () => {
    const files = sourceFiles(ELECTRON_DIR);
    // Sanity: the walk reaches the tree (main.ts and a handler file are in it).
    expect(files.map((f) => path.relative(ELECTRON_DIR, f))).toEqual(
      expect.arrayContaining(["main.ts", path.join("handlers", "systemHandlers.ts")]),
    );

    const emitters = files
      .filter((f) => CHANNEL_LITERAL.test(fs.readFileSync(f, "utf8")))
      .map((f) => path.relative(ELECTRON_DIR, f))
      .sort();
    expect(emitters).toEqual(["main.ts"]);

    const src = fs.readFileSync(path.join(ELECTRON_DIR, "main.ts"), "utf8");
    expect(src.split(CHANNEL).length - 1).toBe(1);
    const at = src.indexOf(`"${CHANNEL}"`);
    // The argument list after the channel name, up to the closing `);`.
    const args = src.slice(at, src.indexOf(");", at));
    expect(args).toMatch(/,\s*deviceLimitPayload\(user\.id, licenseStatus\),?\s*$/);
  });

  it("the preload bridge forwards only userId, deviceCount and deviceLimit to the renderer callback", () => {
    const callback = jest.fn();
    const cleanup = eventBridge.onDeepLinkDeviceLimit(callback);
    const listener = listeners.get(CHANNEL);
    expect(listener).toBeDefined();

    // What main sent before BACKLOG-4046, so the bridge is tested against the wider shape.
    listener!({} as IpcRendererEvent, {
      accessToken: "fixture-access-value",
      refreshToken: "fixture-refresh-value",
      userId: USER_ID,
      deviceCount: 3,
      deviceLimit: 2,
      licenseStatus: { isValid: true, licenseType: "trial", deviceCount: 3, deviceLimit: 2 },
    });

    expect(callback).toHaveBeenCalledTimes(1);
    const received = callback.mock.calls[0][0] as Record<string, unknown>;
    expect(Object.keys(received).sort()).toEqual(["deviceCount", "deviceLimit", "userId"]);
    expect(received).toEqual({ userId: USER_ID, deviceCount: 3, deviceLimit: 2 });
    expect(JSON.stringify(received)).not.toMatch(/fixture-(access|refresh)-value/);
    cleanup();
  });
});
