/**
 * Keychain Gate Service Tests
 * TASK-2254: Tests for the keychain gating mechanism
 */

const mockIsEncryptionAvailable = jest.fn().mockReturnValue(true);
const mockEncryptString = jest.fn().mockReturnValue(Buffer.from("encrypted"));
const mockDecryptString = jest.fn().mockReturnValue("decrypted");

jest.mock("electron", () => ({
  safeStorage: {
    isEncryptionAvailable: () => mockIsEncryptionAvailable(),
    encryptString: (s: string) => mockEncryptString(s),
    decryptString: (b: Buffer) => mockDecryptString(b),
  },
}));

jest.mock("../logService", () => ({
  __esModule: true,
  default: {
    info: jest.fn().mockResolvedValue(undefined),
    warn: jest.fn().mockResolvedValue(undefined),
    error: jest.fn().mockResolvedValue(undefined),
    debug: jest.fn().mockResolvedValue(undefined),
  },
}));

// We need to import fresh instances for each test
let keychainGate: typeof import("../keychainGate").default;

// Helpers to mock process.platform (read at construction time by the service)
const originalPlatform = process.platform;

function mockPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, "platform", { value: platform, configurable: true });
}

function restorePlatform(): void {
  Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
}

describe("KeychainGateService", () => {
  beforeEach(async () => {
    jest.clearAllMocks();
    jest.resetModules();

    // Re-import to get fresh singleton
    const mod = await import("../keychainGate");
    keychainGate = mod.default;
  });

  afterEach(() => {
    restorePlatform();
  });

  describe("isUnlocked", () => {
    it("should start locked", () => {
      expect(keychainGate.isUnlocked()).toBe(false);
    });
  });

  describe("unlock", () => {
    it("should unlock the gate", () => {
      keychainGate.unlock();
      expect(keychainGate.isUnlocked()).toBe(true);
    });

    it("should be idempotent when already unlocked", () => {
      keychainGate.unlock();
      keychainGate.unlock(); // Should not error
      expect(keychainGate.isUnlocked()).toBe(true);
    });
  });

  /**
   * BACKLOG-2430. The gate's unlocked flag is per-process, and the only caller
   * of unlock() is the onboarding secure-storage step. A returning user never
   * sees that step, so before this the gate stayed shut for the whole session
   * on every launch after the first — and support access, its only consumer,
   * could never seal a report.
   */
  describe("unlockIfProvisioned", () => {
    it("unlocks when secure storage was provisioned in an earlier session", () => {
      // The state a returning user actually starts in.
      expect(keychainGate.isUnlocked()).toBe(false);

      expect(keychainGate.unlockIfProvisioned(() => true)).toBe(true);
      expect(keychainGate.isUnlocked()).toBe(true);
    });

    it("stays locked when secure storage has never been set up", () => {
      // A genuinely new user. Unlocking here would raise a keychain prompt
      // before the app has earned one, which is what the gate exists to stop.
      expect(keychainGate.unlockIfProvisioned(() => false)).toBe(false);
      expect(keychainGate.isUnlocked()).toBe(false);
    });

    it("stays locked when the provisioning check throws", () => {
      // Fails closed. An unreadable userData directory must not be treated as
      // consent.
      expect(
        keychainGate.unlockIfProvisioned(() => {
          throw new Error("userData unreadable");
        }),
      ).toBe(false);
      expect(keychainGate.isUnlocked()).toBe(false);
    });

    it("does not consult the check once the gate is already unlocked", () => {
      keychainGate.unlock();
      const check = jest.fn().mockReturnValue(false);

      expect(keychainGate.unlockIfProvisioned(check)).toBe(true);
      expect(check).not.toHaveBeenCalled();
      expect(keychainGate.isUnlocked()).toBe(true);
    });

    it("leaves a gate it unlocked able to encrypt, which is the whole point", () => {
      expect(() => keychainGate.encryptString("secret")).toThrow(
        /keychain access not yet allowed/i,
      );

      keychainGate.unlockIfProvisioned(() => true);

      expect(keychainGate.encryptString("secret")).toEqual(
        Buffer.from("encrypted"),
      );
    });
  });

  describe("lock", () => {
    it("should lock the gate", () => {
      keychainGate.unlock();
      expect(keychainGate.isUnlocked()).toBe(true);

      keychainGate.lock();
      expect(keychainGate.isUnlocked()).toBe(false);
    });
  });

  describe("isEncryptionAvailable", () => {
    it("should return true when safeStorage is available", () => {
      mockIsEncryptionAvailable.mockReturnValue(true);
      expect(keychainGate.isEncryptionAvailable()).toBe(true);
    });

    it("should return false when safeStorage is not available", () => {
      mockIsEncryptionAvailable.mockReturnValue(false);
      expect(keychainGate.isEncryptionAvailable()).toBe(false);
    });

    it("should return false when safeStorage throws", () => {
      mockIsEncryptionAvailable.mockImplementation(() => {
        throw new Error("Not ready");
      });
      expect(keychainGate.isEncryptionAvailable()).toBe(false);
    });
  });

  describe("encryptString", () => {
    it("should throw when gate is locked", () => {
      expect(() => keychainGate.encryptString("secret")).toThrow(
        /keychain access not yet allowed/i
      );
    });

    it("should encrypt when gate is unlocked", () => {
      keychainGate.unlock();
      const result = keychainGate.encryptString("secret");

      expect(mockEncryptString).toHaveBeenCalledWith("secret");
      expect(result).toEqual(Buffer.from("encrypted"));
    });
  });

  describe("decryptString", () => {
    it("should throw when gate is locked", () => {
      const encrypted = Buffer.from("encrypted");
      expect(() => keychainGate.decryptString(encrypted)).toThrow(
        /keychain access not yet allowed/i
      );
    });

    it("should decrypt when gate is unlocked", () => {
      keychainGate.unlock();
      const encrypted = Buffer.from("encrypted");
      const result = keychainGate.decryptString(encrypted);

      expect(mockDecryptString).toHaveBeenCalledWith(encrypted);
      expect(result).toBe("decrypted");
    });
  });

  describe("requiresUserConsent", () => {
    it("should return true on darwin (macOS)", async () => {
      // Mock platform as darwin BEFORE constructing the service instance,
      // because the service reads process.platform at construction time.
      mockPlatform("darwin");
      jest.resetModules();
      const mod = await import("../keychainGate");
      const darwinGate = mod.default;

      expect(darwinGate.requiresUserConsent()).toBe(true);
    });

    it("should return false on win32 (Windows)", async () => {
      mockPlatform("win32");
      jest.resetModules();
      const mod = await import("../keychainGate");
      const winGate = mod.default;

      expect(winGate.requiresUserConsent()).toBe(false);
    });
  });

  describe("autoUnlockIfSilent", () => {
    it("should not auto-unlock on macOS (requires consent)", async () => {
      // Mock platform as darwin BEFORE constructing the service instance
      mockPlatform("darwin");
      jest.resetModules();
      const mod = await import("../keychainGate");
      const darwinGate = mod.default;

      darwinGate.autoUnlockIfSilent();
      // On macOS (darwin), user consent is required, so gate stays locked
      expect(darwinGate.isUnlocked()).toBe(false);
    });

    it("should auto-unlock on win32 (silent platform)", async () => {
      mockPlatform("win32");
      jest.resetModules();
      const mod = await import("../keychainGate");
      const winGate = mod.default;

      winGate.autoUnlockIfSilent();
      // On Windows, no user consent needed — gate auto-unlocks
      expect(winGate.isUnlocked()).toBe(true);
    });
  });
});
