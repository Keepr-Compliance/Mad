/**
 * Keychain Gate Service
 *
 * Single gatekeeper that controls ALL access to macOS Keychain / Windows DPAPI.
 * Prevents keychain prompts from appearing before user is ready.
 *
 * RULE: No code should reach the OS secret store directly. All calls go through
 * this gate, and the gate itself goes through the SecretStore capability
 * (BACKLOG-2962) rather than importing Electron.
 *
 * Flow (first run):
 * 1. App starts with gate LOCKED
 * 2. User sees login, terms, phone selection (no keychain needed)
 * 3. User reaches "Secure Storage" step, sees explanation
 * 4. User clicks "Continue" -> renderer calls unlock()
 * 5. Gate UNLOCKED -> keychain prompt appears
 * 6. All subsequent safeStorage calls work normally
 *
 * Flow (every later launch):
 * 1. App starts with gate LOCKED — this state is per-process and does not
 *    persist, so a returning user begins locked exactly like a new one
 * 2. Startup calls unlockIfProvisioned(); secure storage was set up in an
 *    earlier session, so the gate opens without a prompt or a question
 *
 * That second flow is the whole reason unlockIfProvisioned exists. Step 3 of
 * the first-run flow is the *only* thing that ever called unlock(), and a
 * returning user never sees it — so before BACKLOG-2430 the gate stayed shut
 * for the entire session and every gated call failed. Support access was the
 * only consumer, which is why nothing else appeared broken.
 *
 * @module electron/services/keychainGate
 */

import type { SecretStore } from "../capabilities/secretStore";
import { hostSecretStore } from "../capabilities/secretStoreProvider";
import logService from "./logService";

export class KeychainGateService {
  private _unlocked = false;
  private _platform: NodeJS.Platform;
  private readonly secrets: SecretStore;

  /**
   * @param secrets - The host shell's secret store. Injected so this class can
   *   be constructed under any shell, and so tests need no Electron mock.
   */
  constructor(secrets: SecretStore) {
    this.secrets = secrets;
    this._platform = process.platform;
  }

  /**
   * Check if the gate is unlocked (keychain access allowed)
   */
  isUnlocked(): boolean {
    return this._unlocked;
  }

  /**
   * Unlock the gate - allows keychain access
   * Should ONLY be called when user explicitly allows it (clicks Continue on secure storage step)
   */
  unlock(): void {
    if (this._unlocked) {
      logService.debug("[KeychainGate] Already unlocked", "KeychainGate");
      return;
    }

    logService.info("[KeychainGate] Unlocking keychain access", "KeychainGate");
    this._unlocked = true;
  }

  /**
   * Unlock because secure storage was provisioned in an earlier session
   * (BACKLOG-2430).
   *
   * The gate's `_unlocked` flag lives on a module singleton, so it is per
   * process: every launch starts locked. The only caller of `unlock()` is the
   * onboarding secure-storage step, which a returning user never sees again.
   * The result was a gate that stayed shut for the whole session on every
   * launch after the first.
   *
   * The predicate is the existing no-prompt file check for the database key
   * store. If that file is on disk the user has already agreed to secure
   * storage once and the OS already holds the key — so this raises no prompt
   * and asks no question that was not already answered. It also cannot re-open
   * a gate for someone who never passed the step, because then there is no
   * file.
   *
   * Fails closed. A predicate that returns false, or throws, leaves the gate
   * locked; the caller learns nothing was unlocked from the return value.
   *
   * @param isProvisioned - True when secure storage already exists on disk.
   * @returns Whether the gate is unlocked after this call.
   */
  unlockIfProvisioned(isProvisioned: () => boolean): boolean {
    if (this._unlocked) return true;

    let provisioned: boolean;
    try {
      provisioned = isProvisioned();
    } catch (error) {
      logService.error(
        "[KeychainGate] Could not determine whether secure storage is provisioned; staying locked",
        "KeychainGate",
        { error: error instanceof Error ? error.message : String(error) },
      );
      return false;
    }

    if (!provisioned) {
      logService.info(
        "[KeychainGate] Secure storage is not provisioned yet; staying locked until the user completes the secure storage step",
        "KeychainGate",
      );
      return false;
    }

    logService.info(
      "[KeychainGate] Secure storage was provisioned in an earlier session; unlocking for this session",
      "KeychainGate",
    );
    this._unlocked = true;
    return true;
  }

  /**
   * Lock the gate - blocks keychain access
   * Used for testing or reset scenarios
   */
  lock(): void {
    logService.info("[KeychainGate] Locking keychain access", "KeychainGate");
    this._unlocked = false;
  }

  /**
   * Check if encryption is available (safe to call without keychain prompt)
   * This doesn't actually access the keychain, just checks if the API is available
   */
  isEncryptionAvailable(): boolean {
    try {
      return this.secrets.isEncryptionAvailable();
    } catch (error) {
      logService.error("[KeychainGate] Error checking encryption availability", "KeychainGate", {
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  }

  /**
   * Encrypt a string using OS keychain
   * @throws Error if gate is locked
   */
  encryptString(plaintext: string): Buffer {
    if (!this._unlocked) {
      const error = new Error("[KeychainGate] Cannot encrypt - keychain access not yet allowed. User must complete secure storage step first.");
      logService.error(error.message, "KeychainGate");
      throw error;
    }

    return this.secrets.encryptString(plaintext);
  }

  /**
   * Decrypt a buffer using OS keychain
   * @throws Error if gate is locked
   */
  decryptString(encrypted: Buffer): string {
    if (!this._unlocked) {
      const error = new Error("[KeychainGate] Cannot decrypt - keychain access not yet allowed. User must complete secure storage step first.");
      logService.error(error.message, "KeychainGate");
      throw error;
    }

    return this.secrets.decryptString(encrypted);
  }

  /**
   * Check if this platform requires user consent before keychain access
   * Windows DPAPI is silent, macOS Keychain prompts user
   */
  requiresUserConsent(): boolean {
    return this._platform === "darwin";
  }

  /**
   * Auto-unlock for platforms that don't need user consent (Windows)
   * Call this during app startup for non-macOS platforms
   */
  autoUnlockIfSilent(): void {
    if (!this.requiresUserConsent()) {
      logService.info("[KeychainGate] Auto-unlocking for silent platform (Windows/Linux)", "KeychainGate");
      this._unlocked = true;
    }
  }
}

// Singleton instance
const keychainGate = new KeychainGateService(hostSecretStore);
export default keychainGate;
