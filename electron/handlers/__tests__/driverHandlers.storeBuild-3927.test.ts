/**
 * BACKLOG-3927: in the Microsoft Store build, `drivers:install-apple` and
 * `drivers:download` refuse before anything is downloaded or installed. Before
 * this, install-apple DOWNLOADED Apple's installer whenever nothing was
 * bundled — so a Store build without the MSI would still have installed a
 * non-Microsoft driver. `drivers:open-apple-devices-store` opens Apple Devices.
 */

const handlers = new Map<string, (...args: unknown[]) => unknown>();
const mockOpenExternal = jest.fn();
jest.mock("electron", () => ({
  ipcMain: { handle: (ch: string, fn: (...a: unknown[]) => unknown) => handlers.set(ch, fn) },
  shell: { openExternal: (...a: unknown[]) => mockOpenExternal(...a) },
  BrowserWindow: { fromWebContents: () => null },
}));
jest.mock("electron-log", () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const mockInstall = jest.fn(async () => ({ success: true, error: null, rebootRequired: false }));
const mockDownload = jest.fn(async () => ({ success: true }));
const mockHasBundled = jest.fn(() => false);
jest.mock("../../services/appleDriverService", () => ({
  checkAppleDrivers: jest.fn(),
  installAppleDrivers: () => mockInstall(),
  hasBundledDrivers: () => mockHasBundled(),
  getITunesDownloadUrl: () => "ms-windows-store://pdp/?ProductId=9PB2MZ1ZMB1S",
  getITunesWebUrl: () => "https://www.apple.com/itunes/download/win64",
  checkForDriverUpdate: jest.fn(),
  downloadAppleDrivers: () => mockDownload(),
  getAppleDevicesStoreUrl: () => "ms-windows-store://pdp/?ProductId=9NP83LWLPZ9K",
  getAppleDevicesWebUrl: () => "https://apps.microsoft.com/detail/9NP83LWLPZ9K",
  STORE_INSTALL_REFUSAL_MESSAGE: "Install Apple Devices from the Microsoft Store to set up your iPhone.",
}));

let mockStore = false;
jest.mock("../../services/distributionChannelService", () => ({ isStoreBuild: () => mockStore }));

import { registerDriverHandlers } from "../driverHandlers";

const event = { sender: {} };
const call = (ch: string) => {
  const fn = handlers.get(ch);
  if (!fn) throw new Error(`no handler for ${ch}`);
  return fn(event);
};

beforeAll(() => registerDriverHandlers());
beforeEach(() => jest.clearAllMocks());

describe("Store build (BACKLOG-3927)", () => {
  beforeEach(() => {
    mockStore = true;
  });

  it("drivers:install-apple refuses without downloading or installing", async () => {
    const result = await call("drivers:install-apple");
    expect(result).toEqual({
      success: false,
      error: "Install Apple Devices from the Microsoft Store to set up your iPhone.",
      rebootRequired: false,
    });
    expect(mockDownload).not.toHaveBeenCalled();
    expect(mockInstall).not.toHaveBeenCalled();
  });

  it("drivers:download refuses without downloading", async () => {
    const result = (await call("drivers:download")) as { success: boolean };
    expect(result.success).toBe(false);
    expect(mockDownload).not.toHaveBeenCalled();
  });
});

describe("website build is unchanged (BACKLOG-3927)", () => {
  beforeEach(() => {
    mockStore = false;
  });

  it("drivers:install-apple downloads when nothing is bundled, then installs", async () => {
    await call("drivers:install-apple");
    expect(mockDownload).toHaveBeenCalledTimes(1);
    expect(mockInstall).toHaveBeenCalledTimes(1);
  });
});

describe("drivers:open-apple-devices-store (BACKLOG-3927)", () => {
  it("opens the Apple Devices product page in the Microsoft Store app", async () => {
    mockOpenExternal.mockResolvedValueOnce(undefined);
    expect(await call("drivers:open-apple-devices-store")).toEqual({ success: true });
    expect(mockOpenExternal).toHaveBeenCalledWith("ms-windows-store://pdp/?ProductId=9NP83LWLPZ9K");
  });

  it("falls back to the web product page", async () => {
    mockOpenExternal.mockRejectedValueOnce(new Error("no handler")).mockResolvedValueOnce(undefined);
    expect(await call("drivers:open-apple-devices-store")).toEqual({ success: true });
    expect(mockOpenExternal).toHaveBeenLastCalledWith("https://apps.microsoft.com/detail/9NP83LWLPZ9K");
  });
});
