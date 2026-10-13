/**
 * BACKLOG-3927: main reads the channel from the package.json inside the app
 * (where electron-builder's --config.extraMetadata.distributionChannel lands).
 */
import fs from "fs";
import os from "os";
import path from "path";

const mockApp = { isPackaged: true, getAppPath: jest.fn() };
jest.mock("electron", () => ({ app: mockApp }));
jest.mock("electron-log", () => ({ info: jest.fn(), warn: jest.fn() }));

import {
  getAppleDriverSource,
  getDistributionChannel,
  isStoreBuild,
  resetDistributionChannelCacheForTests,
} from "../distributionChannelService";

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "channel-3927-"));
  mockApp.getAppPath.mockReturnValue(dir);
  mockApp.isPackaged = true;
  delete process.env.KEEPR_DISTRIBUTION_CHANNEL;
  resetDistributionChannelCacheForTests();
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
  delete process.env.KEEPR_DISTRIBUTION_CHANNEL;
});

const writePkg = (pkg: object) => fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify(pkg));

it("packaged app marked store -> store", () => {
  writePkg({ name: "keepr", distributionChannel: "store" });
  expect(getDistributionChannel()).toBe("store");
  expect(isStoreBuild()).toBe(true);
});

it("packaged app without the field -> website", () => {
  writePkg({ name: "keepr" });
  expect(getDistributionChannel()).toBe("website");
});

it("unreadable package.json -> website", () => {
  expect(getDistributionChannel()).toBe("website");
});

it("packaged app ignores the env override", () => {
  writePkg({ name: "keepr" });
  process.env.KEEPR_DISTRIBUTION_CHANNEL = "store";
  expect(getDistributionChannel()).toBe("website");
});

it("dev (unpackaged) honours the env override", () => {
  mockApp.isPackaged = false;
  writePkg({ name: "keepr" });
  process.env.KEEPR_DISTRIBUTION_CHANNEL = "store";
  expect(getDistributionChannel()).toBe("store");
});

describe("KEEPR_APPLE_DRIVER_SOURCE gate (BACKLOG-3927)", () => {
  afterEach(() => {
    delete process.env.KEEPR_APPLE_DRIVER_SOURCE;
    delete process.env.KEEPR_QA_OVERRIDES;
  });

  it("unpackaged (dev): honoured", () => {
    mockApp.isPackaged = false;
    process.env.KEEPR_APPLE_DRIVER_SOURCE = "appledevices";
    expect(getAppleDriverSource()).toBe("appledevices");
    process.env.KEEPR_APPLE_DRIVER_SOURCE = "msi";
    expect(getAppleDriverSource()).toBe("msi");
  });

  it("packaged WITHOUT KEEPR_QA_OVERRIDES=1: ignored (auto)", () => {
    mockApp.isPackaged = true;
    process.env.KEEPR_APPLE_DRIVER_SOURCE = "msi";
    expect(getAppleDriverSource()).toBe("auto");
    process.env.KEEPR_QA_OVERRIDES = "true"; // only the exact "1" opens it
    expect(getAppleDriverSource()).toBe("auto");
  });

  it("packaged WITH KEEPR_QA_OVERRIDES=1: honoured", () => {
    mockApp.isPackaged = true;
    process.env.KEEPR_QA_OVERRIDES = "1";
    process.env.KEEPR_APPLE_DRIVER_SOURCE = "msi";
    expect(getAppleDriverSource()).toBe("msi");
  });

  it("unset or unknown value: auto", () => {
    mockApp.isPackaged = false;
    expect(getAppleDriverSource()).toBe("auto");
    process.env.KEEPR_APPLE_DRIVER_SOURCE = "itunes";
    expect(getAppleDriverSource()).toBe("auto");
  });
});
