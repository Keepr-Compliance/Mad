/**
 * BACKLOG-3785 repro branch ONLY — proves the dev-fixture gates before any launch.
 * (a) the installed SecretStore never reaches safeStorage; (b) local sources are refused.
 */
import { app, safeStorage } from "electron";

const KEY = "ab".repeat(32);

function setEnv(on: boolean): void {
  if (on) {
    process.env.KEEPR_DEV_FIXTURE_MODE = "1";
    process.env.KEEPR_DEV_FIXTURE_KEY = KEY;
  } else {
    delete process.env.KEEPR_DEV_FIXTURE_MODE;
    delete process.env.KEEPR_DEV_FIXTURE_KEY;
  }
}

afterEach(() => {
  setEnv(false);
  (app as { isPackaged: boolean }).isPackaged = false;
  jest.clearAllMocks();
});

describe("isDevFixtureMode", () => {
  it("is on only for an unpackaged build with KEEPR_DEV_FIXTURE_MODE=1", () => {
    const { isDevFixtureMode } = require("../devFixtureMode");
    expect(isDevFixtureMode()).toBe(false);
    setEnv(true);
    expect(isDevFixtureMode()).toBe(true);
    (app as { isPackaged: boolean }).isPackaged = true;
    expect(isDevFixtureMode()).toBe(false);
  });
});

describe("gate (a): SecretStore", () => {
  it("installs the env-key store and never calls safeStorage", () => {
    setEnv(true);
    jest.isolateModules(() => {
      require("../installNativeCapabilities");
      const { getSecretStore } = require("../../capabilities/secretStoreProvider");
      const { DevFixtureSecretStore } = require("../../capabilities/devFixture/devFixtureSecretStore");
      const store = getSecretStore();
      expect(store).toBeInstanceOf(DevFixtureSecretStore);
      expect(store.isEncryptionAvailable()).toBe(true);
      expect(store.decryptString(store.encryptString("db-key-hex"))).toBe("db-key-hex");
    });
    expect(safeStorage.isEncryptionAvailable).not.toHaveBeenCalled();
    expect(safeStorage.encryptString).not.toHaveBeenCalled();
    expect(safeStorage.decryptString).not.toHaveBeenCalled();
  });

  it("fails closed without a key (never falls back to safeStorage)", () => {
    const { DevFixtureSecretStore } = require("../../capabilities/devFixture/devFixtureSecretStore");
    expect(() => new DevFixtureSecretStore(undefined)).toThrow(/KEEPR_DEV_FIXTURE_KEY/);
  });

  it("without the env var the Electron store is installed", () => {
    jest.isolateModules(() => {
      require("../installNativeCapabilities");
      const { getSecretStore } = require("../../capabilities/secretStoreProvider");
      const { ElectronSecretStore } = require("../../capabilities/electron/electronSecretStore");
      expect(getSecretStore()).toBeInstanceOf(ElectronSecretStore);
    });
  });
});

describe("gate (b): local sources", () => {
  it("address-book discovery returns nothing", async () => {
    setEnv(true);
    const { discoverAddressBooks } = require("../../services/addressBookDiscovery");
    await expect(discoverAddressBooks("/nonexistent-base", "/nonexistent-default")).resolves.toEqual({
      books: [],
      usedFallback: false,
    });
  });

  it("refuseLocalSource logs and refuses only in fixture mode", () => {
    const { refuseLocalSource } = require("../devFixtureMode");
    expect(refuseLocalSource("x")).toBe(false);
    setEnv(true);
    expect(refuseLocalSource("x")).toBe(true);
  });
});
