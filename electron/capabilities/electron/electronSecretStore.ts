/**
 * Electron's implementation of {@link SecretStore} (BACKLOG-2962).
 *
 * THIS IS THE ONLY FILE IN THE REPOSITORY THAT MAY IMPORT `safeStorage`.
 * `scripts/ci/check-native-capabilities.mjs` enforces that by AST, and its
 * verification harness plants a violation on every CI run to prove the check
 * still fires.
 *
 * Every method dispatches on `safeStorage` at call time rather than capturing
 * the function. That is not style: the jest `electron` mock hands out
 * `jest.fn()`s that suites reconfigure per test case, and a captured reference
 * would freeze the first configuration.
 *
 * The methods are deliberately bare — no logging, no try/catch. Each of the
 * five callers already has its own error handling, its own log line and its own
 * fallback, and moving any of that in here would change behaviour inside a
 * refactor.
 *
 * @module electron/capabilities/electron/electronSecretStore
 */

import { safeStorage } from "electron";
import type { SecretStore } from "../secretStore";

/** {@link SecretStore} backed by Electron's `safeStorage`. */
export class ElectronSecretStore implements SecretStore {
  isEncryptionAvailable(): boolean {
    return safeStorage.isEncryptionAvailable();
  }

  encryptString(plaintext: string): Buffer {
    return safeStorage.encryptString(plaintext);
  }

  decryptString(encrypted: Buffer): string {
    return safeStorage.decryptString(encrypted);
  }
}
