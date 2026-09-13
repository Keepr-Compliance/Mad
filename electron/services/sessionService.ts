import { promises as fs } from "fs";
import path from "path";
import { app } from "electron";
import type { SecretStore } from "../capabilities/secretStore";
import { hostSecretStore } from "../capabilities/secretStoreProvider";
import * as Sentry from "@sentry/electron/main";
import type { User, OAuthProvider, Subscription } from "../types/models";
import logService from "./logService";

// ============================================
// TYPES & INTERFACES
// ============================================

interface SessionData {
  user: User;
  sessionToken: string;
  provider: OAuthProvider;
  subscription?: Subscription;
  expiresAt: number;
  createdAt: number;
  savedAt?: number;
  // Supabase auth tokens for SDK session restoration (TASK: BACKLOG-546 T&C fix)
  // These are persisted to allow RLS-protected operations for returning users
  supabaseTokens?: {
    access_token: string;
    refresh_token: string;
  };
  // TASK-2086: Timestamp of last successful server-side auth validation (SOC 2 CC6.1)
  // Used for offline grace period -- if missing, treated as "never validated"
  lastServerValidatedAt?: number;
}

/**
 * Wrapper format for encrypted session data stored on disk.
 * When encryption is available, session.json contains this structure
 * instead of raw SessionData JSON.
 */
interface EncryptedSessionFile {
  encrypted: string; // base64-encoded safeStorage-encrypted data
}

/**
 * Why a session could not be encrypted, and therefore was not written.
 *
 * Carried as a Sentry tag. The two are separable only there: at the API boundary
 * both surface as `false`.
 */
type EncryptionRefusalReason = "unavailable" | "encrypt-failed";

/**
 * Refusal reasons already reported to Sentry in this process.
 *
 * A host whose secret store cannot encrypt refuses every write, and writes are
 * routine -- token rotation and startup validation both call through here -- so
 * reporting each occurrence would bury a rare reason under a constant one. The
 * log line is emitted every time; only the report is deduplicated.
 */
const reportedRefusals = new Set<EncryptionRefusalReason>();

// ============================================
// SERVICE CLASS
// ============================================

/**
 * Session Service
 * Manages user session persistence using local file storage.
 * Session data is encrypted at rest using the host secret store
 * (OS Keychain on macOS, DPAPI on Windows, libsecret on Linux).
 *
 * Encryption is required, never optional:
 * - A session is written only when it can be encrypted. If it cannot, nothing is
 *   written, the write reports failure, and the user signs in again next launch.
 * - If decryption fails (e.g., keychain conflict), deletes session and forces re-login
 * - Sessions stored before encryption are migrated on first read; a session file
 *   that cannot be secured is removed rather than kept.
 */
export class SessionService {
  private sessionFilePath: string | null = null;
  private readonly secrets: SecretStore;


  // BACKLOG-2332: serialize all session.json mutations. Without this, updateSession's
  // read-modify-write (load -> merge -> save) can interleave with a concurrent write and
  // re-persist STALE tokens — e.g. the TOKEN_REFRESHED token writeback racing with
  // preAuthValidationHandler's updateSession({ lastServerValidatedAt }) at startup, which would
  // resurrect a used refresh token and get the family reuse-revoked on the next restart. The
  // queue guarantees the latest rotated tokens always win and writes never interleave.
  private writeLock: Promise<void> = Promise.resolve();

  /**
   * @param secrets - The host shell's secret store (BACKLOG-2962). Injected so
   *   the session-encryption paths can be exercised without Electron.
   */
  constructor(secrets: SecretStore) {
    this.secrets = secrets;
  }

  /**
   * Run `op` exclusively after any in-flight session.json mutation completes. Errors are isolated
   * so one failed op never wedges the chain. Public mutators (saveSession/updateSession/
   * clearSession) go through this; the internal `_write*`/`_clear*` primitives do NOT (so
   * updateSession's own load/save inside the critical section can't deadlock on re-entry).
   */
  private runSerialized<T>(op: () => Promise<T>): Promise<T> {
    const result = this.writeLock.then(op);
    this.writeLock = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private getSessionFilePath(): string {
    if (!this.sessionFilePath) {
      this.sessionFilePath = path.join(app.getPath("userData"), "session.json");
    }
    return this.sessionFilePath;
  }

  /**
   * Check if safeStorage encryption is available.
   * This is independent of keychainGate -- safeStorage is available after app.ready.
   */
  private isEncryptionAvailable(): boolean {
    try {
      return this.secrets.isEncryptionAvailable();
    } catch {
      return false;
    }
  }

  /**
   * Record that a session could not be encrypted, and answer the caller with the
   * value that means "there is nothing to write".
   *
   * Logged at error level every time, because the session did not persist.
   * Reported to Sentry once per reason per process -- see {@link reportedRefusals}.
   */
  private refuseEncryption(
    reason: EncryptionRefusalReason,
    detail?: string,
  ): null {
    logService.error(
      "Session not saved: the session could not be encrypted",
      "SessionService",
      detail ? { reason, error: detail } : { reason },
    );

    if (!reportedRefusals.has(reason)) {
      reportedRefusals.add(reason);
      Sentry.captureException(
        new Error(`Session not saved: could not encrypt (${reason})`),
        {
          tags: {
            service: "session-service",
            operation: "saveSession",
            reason,
          },
        },
      );
    }

    return null;
  }

  /**
   * Encrypt a JSON string for storage.
   *
   * @returns the EncryptedSessionFile JSON to write, or `null` when the session
   *   cannot be encrypted -- in which case the caller writes nothing at all.
   */
  private encryptSessionData(jsonString: string): string | null {
    if (!this.isEncryptionAvailable()) {
      return this.refuseEncryption("unavailable");
    }

    try {
      const encryptedBuffer = this.secrets.encryptString(jsonString);
      const wrapper: EncryptedSessionFile = {
        encrypted: encryptedBuffer.toString("base64"),
      };
      return JSON.stringify(wrapper);
    } catch (error) {
      return this.refuseEncryption(
        "encrypt-failed",
        error instanceof Error ? error.message : "Unknown error",
      );
    }
  }

  /**
   * Decrypt session file content.
   * Handles three cases:
   * 1. Encrypted wrapper format ({"encrypted": "<base64>"}) -> decrypt
   * 2. Plaintext JSON (legacy/migration) -> parse directly, re-encrypt on next save
   * 3. Corrupted/unreadable -> return null (forces re-login)
   *
   * @returns Parsed SessionData or null if decryption/parsing fails
   */
  private decryptSessionData(
    fileContent: string,
  ): { session: SessionData; needsMigration: boolean } | null {
    // First, try to parse as JSON (covers both encrypted wrapper and plaintext)
    let parsed: unknown;
    try {
      parsed = JSON.parse(fileContent);
    } catch {
      // Not valid JSON at all -- corrupted file
      logService.warn(
        "Session file is not valid JSON, will be deleted",
        "SessionService",
      );
      return null;
    }

    // Check if this is an encrypted wrapper
    if (
      parsed &&
      typeof parsed === "object" &&
      "encrypted" in parsed &&
      typeof (parsed as EncryptedSessionFile).encrypted === "string"
    ) {
      // Encrypted format -- decrypt it
      if (!this.isEncryptionAvailable()) {
        logService.warn(
          "Session is encrypted but safeStorage not available, forcing re-login",
          "SessionService",
        );
        return null;
      }

      try {
        const buffer = Buffer.from(
          (parsed as EncryptedSessionFile).encrypted,
          "base64",
        );
        const decrypted = this.secrets.decryptString(buffer);
        const session: SessionData = JSON.parse(decrypted);
        return { session, needsMigration: false };
      } catch (error) {
        // Decrypt failure -- keychain conflict (DMG/dev switch), corrupted data, etc.
        logService.warn(
          "Failed to decrypt session (possible keychain conflict), forcing re-login",
          "SessionService",
          { error: error instanceof Error ? error.message : "Unknown error" },
        );
        return null;
      }
    }

    // Not encrypted -- this is a plaintext session (pre-upgrade migration case)
    // Validate it has expected session properties
    if (parsed && typeof parsed === "object" && "sessionToken" in parsed) {
      logService.info(
        "Found plaintext session, will migrate to encrypted format",
        "SessionService",
      );
      return { session: parsed as SessionData, needsMigration: true };
    }

    // Unknown format
    logService.warn(
      "Session file has unrecognized format, will be deleted",
      "SessionService",
    );
    return null;
  }

  /**
   * Save session data to disk, encrypted with the host secret store.
   *
   * @param sessionData - Session data to save
   * @returns `true` when the session was written.
   *
   *   `false` means **nothing was written and the session did not persist** --
   *   the user will sign in again next launch. It does not mean "written, but
   *   less securely": no file is produced on this path.
   *
   *   `false` is deliberately **overloaded**. It is returned both when the
   *   session could not be encrypted and when the file write itself failed, and
   *   the two are indistinguishable here -- they are separable only by the
   *   `reason` tag on the logged and reported event. A caller reading only
   *   `Promise<boolean>` learns neither, which is a contract the compiler cannot
   *   express and therefore cannot enforce: a caller that needs to tell them
   *   apart must read the log, not the return value.
   */
  async saveSession(sessionData: SessionData): Promise<boolean> {
    return this.runSerialized(() => this._writeSession(sessionData));
  }

  /** Internal, NON-serialized write. Only call from inside a runSerialized() critical section. */
  private async _writeSession(sessionData: SessionData): Promise<boolean> {
    try {
      const now = Date.now();
      const data: SessionData = {
        ...sessionData,
        createdAt: sessionData.createdAt || now,
        savedAt: now,
      };
      const jsonString = JSON.stringify(data, null, 2);
      const fileContent = this.encryptSessionData(jsonString);
      if (fileContent === null) {
        // Nothing to write. Answering before the write keeps the refusal ahead of
        // the file system, so no session file can be produced on this path.
        return false;
      }
      await fs.writeFile(this.getSessionFilePath(), fileContent, "utf8");
      await logService.info("Session saved successfully", "SessionService");
      return true;
    } catch (error) {
      await logService.error("Error saving session", "SessionService", {
        error: error instanceof Error ? error.message : "Unknown error",
      });
      Sentry.captureException(error, {
        tags: { service: "session-service", operation: "saveSession" },
      });
      return false;
    }
  }

  /**
   * Load session data from disk (decrypts if encrypted, migrates plaintext)
   * @returns Session data or null if not found/expired/corrupted
   */
  async loadSession(): Promise<SessionData | null> {
    try {
      const fileContent = await fs.readFile(this.getSessionFilePath(), "utf8");
      const result = this.decryptSessionData(fileContent);

      if (!result) {
        // Decryption or parsing failed -- delete the corrupt/unreadable file.
        // Use the internal clear (loadSession is not itself serialized; going through the public
        // clearSession would deadlock when loadSession runs inside updateSession's critical section).
        await logService.warn(
          "Deleting unreadable session file, user will need to re-login",
          "SessionService",
        );
        await this._clearSessionInternal();
        return null;
      }

      const { session, needsMigration } = result;

      // Check if session is expired (absolute timeout)
      if (session.expiresAt && Date.now() > session.expiresAt) {
        await logService.info("Session expired, clearing...", "SessionService");
        await this._clearSessionInternal();
        return null;
      }

      // Migrate plaintext session to encrypted format (internal write for the same reason).
      // If the re-save does not succeed the file cannot be secured, so it is removed
      // rather than left in place, and the user signs in again. The boolean does not
      // say why the write did not happen and it does not need to: the outcome is the
      // same either way.
      if (needsMigration) {
        const migrated = await this._writeSession(session);
        if (!migrated) {
          await logService.warn(
            "Session file could not be secured, removing it and forcing re-login",
            "SessionService",
          );
          await this._clearSessionInternal();
          return null;
        }
        await logService.info(
          "Plaintext session migrated to encrypted format",
          "SessionService",
        );
      }

      await logService.info("Session loaded successfully", "SessionService");
      return session;
    } catch (error: unknown) {
      if (error instanceof Error && (error as NodeJS.ErrnoException).code === "ENOENT") {
        await logService.info("No existing session found", "SessionService");
        return null;
      }
      await logService.error("Error loading session", "SessionService", {
        error: error instanceof Error ? error.message : "Unknown error",
      });
      Sentry.captureException(error, {
        tags: { service: "session-service", operation: "loadSession" },
      });
      return null;
    }
  }

  /**
   * Clear session data
   */
  async clearSession(): Promise<boolean> {
    return this.runSerialized(() => this._clearSessionInternal());
  }

  /** Internal, NON-serialized clear. Only call from inside a runSerialized() critical section
   *  or from loadSession (which is itself read-only / not queued). */
  private async _clearSessionInternal(): Promise<boolean> {
    try {
      await fs.unlink(this.getSessionFilePath());
      await logService.info("Session cleared successfully", "SessionService");
      return true;
    } catch (error: unknown) {
      if (error instanceof Error && (error as NodeJS.ErrnoException).code === "ENOENT") {
        // File doesn't exist, that's fine
        return true;
      }
      await logService.error("Error clearing session", "SessionService", {
        error: error instanceof Error ? error.message : "Unknown error",
      });
      Sentry.captureException(error, {
        tags: { service: "session-service", operation: "clearSession" },
      });
      return false;
    }
  }

  /**
   * Check if a valid session exists
   */
  async hasValidSession(): Promise<boolean> {
    const session = await this.loadSession();
    return session !== null;
  }

  /**
   * Update session data (merge with existing)
   * @param updates - Partial session data to update
   */
  async updateSession(updates: Partial<SessionData>): Promise<boolean> {
    // Serialize the ENTIRE load -> merge -> write so it cannot interleave with another write and
    // re-persist stale data. loadSession/_writeSession here are the internal (non-serialized)
    // path, so holding the lock across them does not deadlock.
    return this.runSerialized(async () => {
      try {
        const currentSession = await this.loadSession();
        if (!currentSession) {
          // BACKLOG-3147: INFO, not ERROR. Having no session here is a NORMAL outcome, not a
          // failure — it is what an ordinary signed-out startup looks like, and it is also what
          // supabaseService's fire-and-forget token persist (supabaseService.ts:436) hits when
          // the SDK rotates tokens before the first save or after the session has been cleared.
          // Nothing was lost: there was nothing to update. Logging it at ERROR put a red line in
          // the log on a routine path, which trains people to ignore the error level.
          // (debug would be invisible: logService's default minLevel is "info".)
          await logService.info("No session to update", "SessionService");
          return false;
        }

        const updatedSession: SessionData = {
          ...currentSession,
          ...updates,
          savedAt: Date.now(),
        };

        return await this._writeSession(updatedSession);
      } catch (error) {
        await logService.error("Error updating session", "SessionService", {
          error: error instanceof Error ? error.message : "Unknown error",
        });
        Sentry.captureException(error, {
          tags: { service: "session-service", operation: "updateSession" },
        });
        return false;
      }
    });
  }

  /**
   * Get the session expiration time in milliseconds (24 hours)
   */
  getSessionExpirationMs(): number {
    return 24 * 60 * 60 * 1000; // 24 hours
  }
}

export default new SessionService(hostSecretStore);
