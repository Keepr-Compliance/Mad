/**
 * @jest-environment node
 */

/**
 * BACKLOG-3675 P8 — the renderer cannot hand main an offline pass.
 *
 * 1. Census: the channels main registers for entitlement are exactly the four
 *    the preload bridge invokes, and the bridge exposes exactly four methods.
 * 2. An extra argument (a pass string) on get-status / unlock-with-credit
 *    never reaches the service.
 * 3. No preload file names the pass.
 * 4. Registering the handlers starts the main-process refresher once.
 */

import { readdirSync, readFileSync } from "fs";
import path from "path";

const mockHandlers = new Map<string, (...args: unknown[]) => unknown>();
const mockInvokedChannels: string[] = [];
jest.mock("electron", () => ({
  ipcMain: {
    handle: (channel: string, fn: (...args: unknown[]) => unknown) => mockHandlers.set(channel, fn),
  },
  ipcRenderer: {
    invoke: (channel: string) => {
      mockInvokedChannels.push(channel);
      return Promise.resolve(null);
    },
  },
}));
jest.mock("../../services/logService", () => {
  const fns = { info: jest.fn(), debug: jest.fn(), warn: jest.fn(), error: jest.fn() };
  return { __esModule: true, default: fns, logService: fns };
});
jest.mock("../../services/supabaseService", () => ({
  __esModule: true,
  default: { getAuthSession: jest.fn(async () => null), trackEvent: jest.fn() },
}));
const mockService = {
  getEntitlementStatus: jest.fn(async (tx: string) => ({
    localTransactionId: tx, status: "locked", lockReason: "no_unlock", fromCache: false, quote: null, creditBalance: null,
  })),
  unlockWithCredit: jest.fn(async () => ({ success: false, status: "locked", error: "no_credit" })),
  getNextUnlockQuote: jest.fn(async () => null),
  getCreditBalance: jest.fn(async () => null),
  startOfflinePassRefresher: jest.fn(),
};
jest.mock("../../services/entitlementService", () => ({ __esModule: true, default: mockService }));

import { registerEntitlementHandlers } from "../entitlementHandlers";
import { entitlementBridge } from "../../preload/entitlementBridge";

const FORGED = "eyJhbGciOiJub25lIn0.eyJzdWIiOiJ4In0.";

beforeAll(() => {
  registerEntitlementHandlers();
});

describe("BACKLOG-3675 P8 no pass injection from the renderer", () => {
  it("registers exactly the four channels the bridge invokes", async () => {
    expect(Object.keys(entitlementBridge).sort()).toEqual(
      ["getBalance", "getQuote", "getStatus", "unlockWithCredit"],
    );
    await entitlementBridge.getStatus("tx");
    await entitlementBridge.getQuote();
    await entitlementBridge.getBalance();
    await entitlementBridge.unlockWithCredit("tx");
    const registered = [...mockHandlers.keys()].filter((c) => c.startsWith("entitlement:")).sort();
    expect(registered).toEqual([...new Set(mockInvokedChannels)].sort());
    expect(registered).toEqual([
      "entitlement:get-balance",
      "entitlement:get-quote",
      "entitlement:get-status",
      "entitlement:unlock-with-credit",
    ]);
  });

  it("get-status ignores an extra pass argument", async () => {
    await mockHandlers.get("entitlement:get-status")!({}, "tx-1", FORGED);
    expect(mockService.getEntitlementStatus).toHaveBeenLastCalledWith("tx-1");
    expect(mockService.getEntitlementStatus.mock.lastCall).toHaveLength(1);
  });

  it("unlock-with-credit ignores an extra pass argument", async () => {
    await mockHandlers.get("entitlement:unlock-with-credit")!({}, "tx-2", FORGED);
    expect(mockService.unlockWithCredit).toHaveBeenLastCalledWith("tx-2");
    expect(mockService.unlockWithCredit.mock.lastCall).toHaveLength(1);
  });

  it("no preload file names the offline pass", () => {
    const dir = path.join(__dirname, "../../preload");
    const files = readdirSync(dir, { recursive: true })
      .map(String)
      .filter((f) => /\.(ts|tsx|js)$/.test(f));
    expect(files.length).toBeGreaterThan(5);
    const hits = files.filter((f) =>
      /offline[-_ ]?pass|offlinePass/i.test(readFileSync(path.join(dir, f), "utf8")),
    );
    expect(hits).toEqual([]);
  });

  it("registering starts the refresher exactly once", () => {
    expect(mockService.startOfflinePassRefresher).toHaveBeenCalledTimes(1);
  });
});
