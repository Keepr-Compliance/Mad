/**
 * The Electron SecretStore implementation (BACKLOG-2962).
 *
 * WHY THIS SUITE CARRIES MORE WEIGHT THAN ITS SIZE SUGGESTS
 * ---------------------------------------------------------
 * Before the seam, every suite that exercised secret handling reached
 * `safeStorage` through the service under test, so a broken call to
 * `safeStorage` failed dozens of tests. After the seam those suites install a
 * fake `SecretStore` (see `tests/helpers/installTestSecretStore.js` for why),
 * which means **nothing else in the repository would notice if this class
 * forwarded to the wrong method, dropped an argument, or returned the wrong
 * value.** This file is the only thing that would.
 *
 * That is a deliberate trade, not an oversight, and it is why the assertions
 * below check argument identity and return-value identity rather than merely
 * "was called".
 */

const mockSafeStorage = {
  isEncryptionAvailable: jest.fn(),
  encryptString: jest.fn(),
  decryptString: jest.fn(),
};

jest.mock("electron", () => ({ safeStorage: mockSafeStorage }));

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { ElectronSecretStore } = require("../electronSecretStore");

describe("ElectronSecretStore", () => {
  let store: import("../electronSecretStore").ElectronSecretStore;

  beforeEach(() => {
    jest.clearAllMocks();
    store = new ElectronSecretStore();
  });

  describe("isEncryptionAvailable", () => {
    it.each([true, false])("returns safeStorage's answer verbatim (%s)", (answer) => {
      mockSafeStorage.isEncryptionAvailable.mockReturnValue(answer);

      expect(store.isEncryptionAvailable()).toBe(answer);
      expect(mockSafeStorage.isEncryptionAvailable).toHaveBeenCalledTimes(1);
    });

    it("does not swallow a throw — the callers own their fallbacks, not this class", () => {
      mockSafeStorage.isEncryptionAvailable.mockImplementation(() => {
        throw new Error("keychain locked");
      });

      expect(() => store.isEncryptionAvailable()).toThrow("keychain locked");
    });
  });

  describe("encryptString", () => {
    it("passes the plaintext through and returns safeStorage's buffer", () => {
      const sealed = Buffer.from("sealed-bytes");
      mockSafeStorage.encryptString.mockReturnValue(sealed);

      const result = store.encryptString("plaintext-in");

      expect(mockSafeStorage.encryptString).toHaveBeenCalledWith("plaintext-in");
      // Identity, not equality: a re-wrapped buffer would be a silent copy.
      expect(result).toBe(sealed);
    });

    it("never reaches decryptString", () => {
      mockSafeStorage.encryptString.mockReturnValue(Buffer.alloc(0));
      store.encryptString("x");
      expect(mockSafeStorage.decryptString).not.toHaveBeenCalled();
    });
  });

  describe("decryptString", () => {
    it("passes the buffer through and returns safeStorage's string", () => {
      const sealed = Buffer.from("sealed-bytes");
      mockSafeStorage.decryptString.mockReturnValue("plaintext-out");

      const result = store.decryptString(sealed);

      expect(mockSafeStorage.decryptString).toHaveBeenCalledWith(sealed);
      expect(result).toBe("plaintext-out");
    });

    it("never reaches encryptString", () => {
      mockSafeStorage.decryptString.mockReturnValue("");
      store.decryptString(Buffer.alloc(0));
      expect(mockSafeStorage.encryptString).not.toHaveBeenCalled();
    });
  });

  it("dispatches on safeStorage per call, so a reconfigured mock is honoured", () => {
    // If the implementation captured `safeStorage.encryptString` at construction
    // (or at module load) this would return the first buffer twice, and every
    // suite that reconfigures the electron mock between cases would silently
    // test the wrong behaviour.
    mockSafeStorage.encryptString.mockReturnValue(Buffer.from("first"));
    expect(store.encryptString("a").toString()).toBe("first");

    mockSafeStorage.encryptString.mockReturnValue(Buffer.from("second"));
    expect(store.encryptString("b").toString()).toBe("second");
  });

  it("round-trips through a keychain that actually seals", () => {
    const PREFIX = "sealed:";
    mockSafeStorage.encryptString.mockImplementation((s: string) =>
      Buffer.from(`${PREFIX}${s}`, "utf8"),
    );
    mockSafeStorage.decryptString.mockImplementation((b: Buffer) => {
      const text = b.toString("utf8");
      if (!text.startsWith(PREFIX)) throw new Error("not sealed by this keychain");
      return text.slice(PREFIX.length);
    });

    const sealed = store.encryptString("a-real-secret");
    // The prefix assertion is the point: a forwarder that returned the plaintext
    // buffer unchanged would still round-trip, and would still be broken.
    expect(sealed.toString("utf8")).toBe("sealed:a-real-secret");
    expect(store.decryptString(sealed)).toBe("a-real-secret");
  });
});

export {};
