/**
 * OS-backed secret storage, as an interface (BACKLOG-2962).
 *
 * WHY THIS EXISTS
 * ---------------
 * Epic 9 is "one core, many shells": the core must not know which platform it
 * is running on. Before this file, five modules opened with
 * `import { safeStorage } from "electron"` and called it directly — 14 call
 * expressions across three methods. A module that does that cannot be loaded by
 * a non-Electron shell at all, whatever it does at runtime, because the import
 * fails first.
 *
 * WHAT THIS IS *NOT*
 * ------------------
 * It is not a speculative platform abstraction. The three methods below are
 * exactly the three `safeStorage` methods this codebase calls — no more. If a
 * fourth is ever needed, it is added here when the first caller needs it, not
 * before.
 *
 * `Buffer` in the signatures is deliberate: it is what `safeStorage` already
 * returns and takes, and every current caller round-trips it (base64 for
 * tokens, a JSON key store on disk for the database key). Changing that shape
 * would be a behaviour change smuggled inside a refactor.
 *
 * @module electron/capabilities/secretStore
 */

/**
 * Encrypt and decrypt short secrets using whatever facility the host OS/shell
 * provides — Electron's `safeStorage` (macOS Keychain, Windows DPAPI, Linux
 * Secret Service) today; the Android Keystore or a Capacitor plugin later.
 *
 * Implementations MUST be synchronous, because every existing caller is.
 */
export interface SecretStore {
  /**
   * Whether secrets can be encrypted at all right now.
   *
   * Implementations return `false` rather than throwing when the facility is
   * simply absent; they may throw only when asked something they cannot answer.
   */
  isEncryptionAvailable(): boolean;

  /** Encrypt `plaintext`. Throws when encryption is unavailable or fails. */
  encryptString(plaintext: string): Buffer;

  /** Decrypt a buffer produced by {@link encryptString}. Throws on failure. */
  decryptString(encrypted: Buffer): string;
}

/** Raised by {@link UnavailableSecretStore} for every method. */
export class SecretStoreUnavailableError extends Error {
  constructor(operation: string) {
    super(
      `No secret store is installed, so ${operation} cannot run. The host shell ` +
        "must install one at its composition root before any code reaches this " +
        "capability (Electron does so in electron/bootstrap/installNativeCapabilities.ts).",
    );
    this.name = "SecretStoreUnavailableError";
  }
}

/**
 * A {@link SecretStore} that throws on every method.
 *
 * This is the item's own stated control, made executable: *"a stub
 * implementation that throws on every method compiles and type-checks against
 * every caller. If it does not, a caller is still reaching past the
 * interface."* It is also the default the provider holds before a shell
 * installs anything, so "nobody installed a secret store" fails loudly at the
 * first call instead of silently degrading to plaintext.
 */
export class UnavailableSecretStore implements SecretStore {
  isEncryptionAvailable(): boolean {
    throw new SecretStoreUnavailableError("isEncryptionAvailable");
  }

  encryptString(_plaintext: string): Buffer {
    throw new SecretStoreUnavailableError("encryptString");
  }

  decryptString(_encrypted: Buffer): string {
    throw new SecretStoreUnavailableError("decryptString");
  }
}
