/**
 * Token Encryption Service
 * Encrypts/decrypts OAuth tokens with the host shell's SecretStore capability
 * (BACKLOG-2962), which under Electron is `safeStorage` — the OS keychain
 * (macOS Keychain, Windows DPAPI, Linux Secret Service).
 */

import * as os from "os";
import type { SecretStore } from "../capabilities/secretStore";
import { hostSecretStore } from "../capabilities/secretStoreProvider";
import logService from "./logService";

/**
 * Error class for encryption-related failures with platform-specific guidance
 */
export class EncryptionError extends Error {
  readonly platform: NodeJS.Platform;
  readonly guidance: string;

  constructor(message: string, guidance: string) {
    super(message);
    this.name = "EncryptionError";
    this.platform = os.platform();
    this.guidance = guidance;
  }
}

/**
 * Platform-specific guidance for encryption issues
 */
const PLATFORM_GUIDANCE: Record<string, string> = {
  linux: `Linux requires a secret service (like gnome-keyring or KWallet) to be running.
To fix this:
1. Install gnome-keyring: sudo apt install gnome-keyring
2. Ensure it's running: eval $(gnome-keyring-daemon --start --components=secrets)
3. Or install KWallet if using KDE: sudo apt install kwalletmanager`,
  darwin: `macOS Keychain should be available by default.
If you're seeing this error:
1. Open Keychain Access app
2. Check if your login keychain is unlocked
3. Try locking and unlocking the keychain`,
  win32: `Windows DPAPI should be available by default.
If you're seeing this error:
1. Try restarting the application
2. Run as administrator if the issue persists
3. Check Windows Event Viewer for credential-related errors`,
  default: `Secure storage is not available on this platform.
Please ensure your operating system's credential storage service is running.`,
};

export class TokenEncryptionService {
  private _encryptionChecked = false;
  private _encryptionAvailable = false;
  private readonly secrets: SecretStore;

  /**
   * @param secrets - The host shell's secret store. Injected so this class can
   *   be constructed under any shell, and so tests need no Electron mock.
   */
  constructor(secrets: SecretStore) {
    this.secrets = secrets;
  }

  /**
   * Reset internal state (for testing purposes only)
   * @internal
   */
  _resetState(): void {
    this._encryptionChecked = false;
    this._encryptionAvailable = false;
  }

  /**
   * Get platform-specific guidance for encryption issues
   */
  private getPlatformGuidance(): string {
    const platform = os.platform();
    return PLATFORM_GUIDANCE[platform] || PLATFORM_GUIDANCE.default;
  }

  /**
   * Check if encryption is available
   * @returns {boolean}
   */
  isEncryptionAvailable(): boolean {
    try {
      this._encryptionAvailable = this.secrets.isEncryptionAvailable();
      this._encryptionChecked = true;
      return this._encryptionAvailable;
    } catch (error) {
      logService.error(
        "Error checking encryption availability",
        "TokenEncryption",
        {
          error: error instanceof Error ? error.message : String(error),
        },
      );
      this._encryptionChecked = true;
      this._encryptionAvailable = false;
      return false;
    }
  }

  /**
   * Get detailed status about encryption availability
   * Useful for diagnostics and user-facing error messages
   */
  getEncryptionStatus(): {
    available: boolean;
    platform: NodeJS.Platform;
    guidance: string;
    checked: boolean;
  } {
    // Ensure we've checked availability
    if (!this._encryptionChecked) {
      this.isEncryptionAvailable();
    }

    return {
      available: this._encryptionAvailable,
      platform: os.platform(),
      guidance: this._encryptionAvailable ? "" : this.getPlatformGuidance(),
      checked: this._encryptionChecked,
    };
  }

  /**
   * Create an appropriate error for encryption unavailability
   */
  private createUnavailableError(
    operation: "encrypt" | "decrypt",
  ): EncryptionError {
    const platform = os.platform();
    const guidance = this.getPlatformGuidance();

    let message: string;
    if (platform === "linux") {
      message = `Cannot ${operation} token: No Linux secret service available (gnome-keyring or KWallet required).`;
    } else if (platform === "darwin") {
      message = `Cannot ${operation} token: macOS Keychain is not accessible.`;
    } else if (platform === "win32") {
      message = `Cannot ${operation} token: Windows DPAPI is not available.`;
    } else {
      message = `Cannot ${operation} token: OS-level encryption is not available on this platform.`;
    }

    return new EncryptionError(message, guidance);
  }

  /**
   * Encrypt a plaintext string
   * @param {string} plaintext - The string to encrypt
   * @returns {string} Base64-encoded encrypted data
   * @throws {EncryptionError} If encryption is not available or fails
   */
  encrypt(plaintext: string): string {
    if (!this.isEncryptionAvailable()) {
      const error = this.createUnavailableError("encrypt");
      logService.error("Encryption not available", "TokenEncryption", {
        message: error.message,
        platform: error.platform,
        guidance: error.guidance,
      });
      throw error;
    }

    try {
      const buffer = this.secrets.encryptString(plaintext);
      return buffer.toString("base64");
    } catch (error) {
      logService.error("Encryption operation failed", "TokenEncryption", {
        error: error instanceof Error ? error.message : String(error),
      });
      throw new EncryptionError(
        "Failed to encrypt token",
        "The encryption operation failed unexpectedly. Please try again or restart the application.",
      );
    }
  }

  /**
   * Decrypt base64-encoded encrypted data
   * @param {string} encryptedBase64 - Base64-encoded encrypted data
   * @returns {string} Decrypted plaintext
   * @throws {EncryptionError} If decryption is not available or fails
   */
  decrypt(encryptedBase64: string): string {
    if (!this.isEncryptionAvailable()) {
      const error = this.createUnavailableError("decrypt");
      logService.error("Decryption not available", "TokenEncryption", {
        message: error.message,
        platform: error.platform,
        guidance: error.guidance,
      });
      throw error;
    }

    try {
      const buffer = Buffer.from(encryptedBase64, "base64");
      return this.secrets.decryptString(buffer);
    } catch (error) {
      logService.error("Decryption operation failed", "TokenEncryption", {
        error: error instanceof Error ? error.message : String(error),
      });
      throw new EncryptionError(
        "Failed to decrypt token",
        "The decryption operation failed. The token may be corrupted or the encryption key has changed.",
      );
    }
  }

  /**
   * Encrypt an object (converts to JSON first)
   * @param {Object} data - The object to encrypt
   * @returns {string} Base64-encoded encrypted data
   */
  encryptObject(data: unknown): string {
    const json = JSON.stringify(data);
    return this.encrypt(json);
  }

  /**
   * Decrypt and parse JSON object
   * @param {string} encryptedBase64 - Base64-encoded encrypted data
   * @returns {Object} Decrypted object
   */
  decryptObject<T = unknown>(encryptedBase64: string): T {
    const json = this.decrypt(encryptedBase64);
    return JSON.parse(json) as T;
  }
}

// Export singleton instance
export default new TokenEncryptionService(hostSecretStore);
