/** @jest-environment node */
/**
 * The startup wiring itself (BACKLOG-2430)
 *
 * `returningUserCapture.test.ts` proves `unlockIfProvisioned` works. It calls
 * it with the suite's own predicate, though — never `hasKeyStore()`, and never
 * from the startup path. So the *function* was guarded and the *wiring* was
 * not: SR review deleted the startup call and the full suite came back
 * identical to baseline. Nothing noticed the P0 fix being removed.
 *
 * That is the same defect class as BACKLOG-2430 itself — a runtime state
 * nothing exercised — closed one level down and left open one level up. This
 * closes it, by driving the real `initializeSupportAccess()` against the real
 * `keychainGate` singleton and asserting the gate is actually open afterwards.
 *
 * Only the boundaries are faked: `app`, the network/session services, and
 * `hasKeyStore` (which is `fs.existsSync` in production — there is no real
 * userData directory here). The gate is real, and its unlocked state after
 * startup is the assertion.
 */

import { promises as fs } from "fs";
import * as os from "os";
import * as path from "path";

const mockHasKeyStore = jest.fn();
let baseDir: string;

jest.mock("electron", () => ({
  app: {
    getPath: () => baseDir,
    getVersion: () => "2.27.0",
  },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (plaintext: string) =>
      Buffer.from(`keychain-sealed:${plaintext}`, "utf8"),
    decryptString: (sealed: Buffer) =>
      sealed.toString("utf8").slice("keychain-sealed:".length),
  },
}));

jest.mock("../../databaseEncryptionService", () => ({
  __esModule: true,
  databaseEncryptionService: {
    hasKeyStore: () => mockHasKeyStore(),
  },
  default: {
    hasKeyStore: () => mockHasKeyStore(),
  },
}));

jest.mock("../../logService", () => ({
  __esModule: true,
  default: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

jest.mock("../../sessionService", () => ({
  __esModule: true,
  default: { loadSession: jest.fn().mockResolvedValue(null) },
}));

jest.mock("../../supabaseService", () => ({
  __esModule: true,
  default: { getClient: () => null },
}));

jest.mock("../../supportTicketService", () => ({
  collectDiagnostics: jest.fn().mockResolvedValue({ app_version: "2.27.0" }),
}));

type Startup = typeof import("../index");
type KeychainGate = typeof import("../../keychainGate").default;

/**
 * A launch. A fresh module registry gives a fresh `keychainGate` singleton —
 * locked, as every real process start leaves it — and the support-access
 * module then closes over that instance.
 */
async function launch(): Promise<{ startup: Startup; gate: KeychainGate }> {
  jest.resetModules();
  const gate = (await import("../../keychainGate")).default;
  const startup = await import("../index");
  return { startup, gate };
}

describe("support access startup", () => {
  beforeEach(async () => {
    baseDir = await fs.mkdtemp(path.join(os.tmpdir(), "keepr-support-boot-"));
    mockHasKeyStore.mockReset();
    mockHasKeyStore.mockReturnValue(true);
  });

  afterEach(async () => {
    await fs.rm(baseDir, { recursive: true, force: true });
  });

  /**
   * THE GUARD. Delete the `unlockKeychainForProvisionedUser()` call from
   * `initializeSupportAccess` and this fails.
   */
  it("opens the keychain gate as part of starting up", async () => {
    const { startup, gate } = await launch();

    // The state every launch begins in, and the state a returning user was
    // stuck in for the whole session.
    expect(gate.isUnlocked()).toBe(false);

    await startup.initializeSupportAccess();

    expect(gate.isUnlocked()).toBe(true);
    startup._resetSupportAccessForTests();
  });

  it("asks the real key-store check, not something the test invented", async () => {
    const { startup } = await launch();

    await startup.initializeSupportAccess();

    // The predicate is `databaseEncryptionService.hasKeyStore` — the existing
    // no-prompt file check — rather than a constant or a duplicate of it.
    expect(mockHasKeyStore).toHaveBeenCalled();
    startup._resetSupportAccessForTests();
  });

  it("leaves the gate shut when secure storage was never set up", async () => {
    mockHasKeyStore.mockReturnValue(false);
    const { startup, gate } = await launch();

    await startup.initializeSupportAccess();

    // A genuinely new user. Unlocking here would raise a keychain prompt
    // before the app has earned one.
    expect(gate.isUnlocked()).toBe(false);
    startup._resetSupportAccessForTests();
  });

  it("leaves the gate shut when the key-store check throws", async () => {
    mockHasKeyStore.mockImplementation(() => {
      throw new Error("userData unreadable");
    });
    const { startup, gate } = await launch();

    // Fails closed, and startup still completes — a diagnostics feature must
    // not be able to take the app down with it.
    await expect(startup.initializeSupportAccess()).resolves.toBeUndefined();
    expect(gate.isUnlocked()).toBe(false);
    startup._resetSupportAccessForTests();
  });

  it("is callable on its own, and reports whether the gate ended open", async () => {
    const { startup, gate } = await launch();

    expect(startup.unlockKeychainForProvisionedUser()).toBe(true);
    expect(gate.isUnlocked()).toBe(true);

    // Idempotent: a second startup pass must not re-ask or flip anything.
    mockHasKeyStore.mockClear();
    expect(startup.unlockKeychainForProvisionedUser()).toBe(true);
    expect(mockHasKeyStore).not.toHaveBeenCalled();
  });
});
