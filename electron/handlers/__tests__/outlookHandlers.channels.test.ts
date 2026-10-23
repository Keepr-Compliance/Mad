/**
 * BACKLOG-3820: registers the real Outlook IPC handlers, invokes every channel,
 * and checks that MSAL is never constructed and no msal-cache file is touched.
 * The msal-node mock is virtual so this test does not depend on the package
 * staying installed.
 */
const msalCtor = jest.fn();
jest.mock(
  "@azure/msal-node",
  () => ({
    PublicClientApplication: jest.fn().mockImplementation((cfg: unknown) => {
      msalCtor(cfg);
      return { getTokenCache: () => ({ getAllAccounts: async () => [], removeAccount: async () => {} }) };
    }),
  }),
  { virtual: true },
);

const handlers: Record<string, (...args: unknown[]) => unknown> = {};
jest.mock("electron", () => ({
  app: { getPath: () => "/tmp/outlook-handlers-test-userdata" },
  shell: { openExternal: jest.fn() },
  BrowserWindow: jest.fn(),
  ipcMain: {
    handle: (channel: string, fn: (...args: unknown[]) => unknown) => {
      handlers[channel] = fn;
    },
  },
}));
jest.mock("../../services/databaseService", () => ({
  __esModule: true,
  default: { getUserById: jest.fn(), getOAuthToken: jest.fn(async () => null), saveOAuthToken: jest.fn() },
}));
jest.mock("../../services/microsoftAuthService", () => ({ __esModule: true, default: {} }));
jest.mock("../../services/logService", () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock("../../utils/userIdHelper", () => ({ getValidUserId: jest.fn(async () => null) }));

import fs from "fs";
import type { BrowserWindow } from "electron";

type FsMethod = "writeFileSync" | "readFileSync" | "existsSync" | "unlinkSync";

describe("Outlook IPC handlers", () => {
  it("register all five channels, return their results, and never construct MSAL or touch an msal-cache file", async () => {
    const touched: string[] = [];
    for (const m of ["writeFileSync", "readFileSync", "existsSync", "unlinkSync"] as FsMethod[]) {
      const orig = fs[m] as (...args: unknown[]) => unknown;
      jest.spyOn(fs, m).mockImplementation(((...args: unknown[]) => {
        if (String(args[0]).includes("msal-cache")) touched.push(`${m}:${String(args[0])}`);
        return orig.apply(fs, args);
      }) as never);
    }

    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { registerOutlookHandlers } = require("../outlookHandlers");
    registerOutlookHandlers({} as BrowserWindow);

    const channels = Object.keys(handlers).sort();
    expect(channels).toEqual([
      "outlook-authenticate",
      "outlook-get-user-email",
      "outlook-initialize",
      "outlook-is-authenticated",
      "outlook-signout",
    ]);

    const results: Record<string, unknown> = {};
    for (const ch of channels) results[ch] = await handlers[ch]({}, undefined);

    expect(results["outlook-initialize"]).toEqual({ success: true });
    expect(results["outlook-signout"]).toEqual({ success: true });
    expect(results["outlook-is-authenticated"]).toBe(false);
    expect(results["outlook-authenticate"]).toEqual({ success: false, error: "No user found in database" });
    expect(results["outlook-get-user-email"]).toEqual({ success: false, error: "No user found in database" });

    expect(msalCtor).not.toHaveBeenCalled();
    expect(touched).toEqual([]);
  });
});
