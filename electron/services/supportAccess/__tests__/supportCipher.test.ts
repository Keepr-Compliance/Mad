/**
 * BACKLOG-3443 — the platform word in the keychain-unavailable message.
 *
 * `createKeychainKeyProvider` rejects when the OS cannot protect a secret at
 * rest. That is macOS Keychain on a Mac and **DPAPI on Windows**, so the
 * guaranteed reader of this message is as likely to be a Windows user as a Mac
 * one. Naming a platform the reader may not be on reads as a message meant for
 * somebody else.
 *
 * The message reaches the screen verbatim: the throw is surfaced by
 * `wrapHandler` as `{ success: false, error: error.message }`, rethrown by
 * `src/services/supportAccessService.ts`, and shown by
 * `SupportAccessSettings.tsx` via `notify.error(safeErrorMessage(error))`,
 * which returns `value.message` unchanged for an `Error`.
 *
 * The negative alone is satisfiable by deleting the sentence, so it is paired
 * with a positive on the clause that tells the user which machine is at fault.
 */

import {
  createKeychainKeyProvider,
  SupportCipherUnavailableError,
} from "../supportCipher";

/**
 * Secure storage unavailable. The throw precedes every filesystem call, so
 * `baseDir` is never read and the seal/open stubs must never run — they throw
 * rather than return, so a reordering that reached them would fail loudly
 * instead of quietly passing.
 */
function providerWithNoSecureStorage() {
  return createKeychainKeyProvider({
    baseDir: "/nonexistent/keepr-support-access-3443",
    isEncryptionAvailable: () => false,
    sealString: () => {
      throw new Error("sealString reached although secure storage is unavailable");
    },
    openString: () => {
      throw new Error("openString reached although secure storage is unavailable");
    },
  });
}

/** A fresh provider each time, so the in-flight/cached key cannot blur the result. */
async function rejectionFromUnavailableSecureStorage(): Promise<SupportCipherUnavailableError> {
  try {
    await providerWithNoSecureStorage()();
  } catch (error) {
    expect(error).toBeInstanceOf(SupportCipherUnavailableError);
    return error as SupportCipherUnavailableError;
  }
  throw new Error(
    "createKeychainKeyProvider resolved a key although secure storage is unavailable",
  );
}

describe("createKeychainKeyProvider", () => {
  describe("the platform word", () => {
    it("names no platform the user may not be on", async () => {
      const error = await rejectionFromUnavailableSecureStorage();
      expect(error.message).not.toMatch(/\bmac\b|macos/i);
    });

    it("still says which machine cannot protect the data", async () => {
      const error = await rejectionFromUnavailableSecureStorage();
      expect(error.message).toContain("This computer cannot protect");
    });
  });
});
