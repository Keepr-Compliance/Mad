/**
 * Permission Service
 * Centralized permission checking and error handling
 */

import { promises as fs } from "fs";
import path from "path";
import os from "os";
import logService from "./logService";

interface PermissionResult {
  hasPermission: boolean;
  error?: string;
  errorCode?: string;
  userMessage?: string;
  action?: string;
}

/** BACKLOG-2404 — mirrors `LoadStatus.coverage`; see contactsService. */
type ContactsReadCoverage = "complete" | "partial" | "none";

interface ContactsIssue {
  type: string;
  title: string;
  message: string;
  details: string;
  action: string;
  actionHandler: string;
  severity: string;
}

interface ContactsLoadingResult {
  canLoadContacts: boolean;
  contactCount?: number;
  /**
   * BACKLOG-2404 — "read everything" / "read some" / "read nothing", kept
   * distinct from `canLoadContacts`.
   *
   * `canLoadContacts` answers "did we get any contacts at all", which is the
   * right question for the permissions prompt and the WRONG one for "is what
   * she is looking at complete". A user with iCloud and a locked Exchange store
   * can load contacts and is still missing half her address book; before this
   * field there was no way to say so.
   */
  coverage?: ContactsReadCoverage;
  /** BACKLOG-2404 — address books discovered. `2 of 3` needs both numbers. */
  booksFound?: number;
  /** BACKLOG-2404 — address books successfully read. */
  booksRead?: number;
  /** BACKLOG-2404 — address books discovered but unreadable. */
  booksFailed?: number;
  /**
   * BACKLOG-2404 — a non-blocking problem: the read WORKED, and something is
   * still wrong enough that the user should be told. Separate from `error`,
   * which means the read did not work at all. Collapsing the two is what
   * produced a Full Disk Access prompt for a permission the user already held.
   */
  warning?: ContactsIssue;
  error?: ContactsIssue;
}

interface AllPermissionsResult {
  allGranted: boolean;
  permissions: {
    fullDiskAccess?: PermissionResult;
    contacts?: PermissionResult;
  };
  errors: PermissionResult[];
}

interface PermissionCache {
  fullDiskAccess: boolean | null;
  contacts: boolean | null;
  cachedAt: number | null;
}

interface CachedPermissions {
  fullDiskAccess: boolean | null;
  contacts: boolean | null;
  cachedAt: number;
}

interface PermissionError {
  type: string;
  title: string;
  message: string;
  details: string;
  action: string;
  actionHandler?: string;
  severity: string;
}

class PermissionService {
  private lastPermissionCheck: number | null;
  private permissionCache: PermissionCache;

  constructor() {
    this.lastPermissionCheck = null;
    this.permissionCache = {
      fullDiskAccess: null,
      contacts: null,
      cachedAt: null,
    };
  }

  /**
   * Check Full Disk Access permission (macOS only)
   * @returns {Promise<{hasPermission: boolean, error?: string}>}
   */
  async checkFullDiskAccess(): Promise<PermissionResult> {
    // Windows/Linux: Full Disk Access is macOS-only, skip this check
    if (os.platform() !== "darwin") {
      logService.info(
        `Skipping Full Disk Access check on ${os.platform()} (macOS-only feature)`,
        "PermissionService",
      );
      return {
        hasPermission: true,
      };
    }

    try {
      const messagesDbPath = path.join(
        process.env.HOME!,
        "Library/Messages/chat.db",
      );
      await fs.access(messagesDbPath, fs.constants.R_OK);

      this.permissionCache.fullDiskAccess = true;
      this.permissionCache.cachedAt = Date.now();

      return {
        hasPermission: true,
      };
    } catch (error) {
      this.permissionCache.fullDiskAccess = false;
      this.permissionCache.cachedAt = Date.now();

      return {
        hasPermission: false,
        error: (error as Error).message,
        errorCode: "FULL_DISK_ACCESS_DENIED",
        userMessage:
          "Full Disk Access permission is required to read iMessages.",
        action:
          "Please grant Full Disk Access in System Settings > Privacy & Security > Full Disk Access",
      };
    }
  }

  /**
   * Check Contacts permission (macOS only)
   * @returns {Promise<{hasPermission: boolean, error?: string}>}
   */
  async checkContactsPermission(): Promise<PermissionResult> {
    // Windows/Linux: Contacts app is macOS-only, skip this check
    if (os.platform() !== "darwin") {
      logService.info(
        `Skipping Contacts permission check on ${os.platform()} (macOS-only feature)`,
        "PermissionService",
      );
      return {
        hasPermission: true,
      };
    }

    try {
      const contactsDbPath = path.join(
        process.env.HOME!,
        "Library/Application Support/AddressBook/Sources",
      );
      await fs.access(contactsDbPath, fs.constants.R_OK);

      this.permissionCache.contacts = true;
      this.permissionCache.cachedAt = Date.now();

      return {
        hasPermission: true,
      };
    } catch (error) {
      this.permissionCache.contacts = false;
      this.permissionCache.cachedAt = Date.now();

      return {
        hasPermission: false,
        error: (error as Error).message,
        errorCode: "CONTACTS_ACCESS_DENIED",
        userMessage:
          "Contacts permission is required to match phone numbers to names.",
        action:
          "Full Disk Access in System Settings > Privacy & Security > Full Disk Access will grant access to Contacts",
      };
    }
  }

  /**
   * Check if contacts are actually loading from the Contacts app (macOS only)
   * This is a more thorough check than just checking directory access
   *
   * ---------------------------------------------------------------------------
   * BACKLOG-2404 — THREE OUTCOMES, NOT TWO
   * ---------------------------------------------------------------------------
   * This function decides what the user is told, so it is the place the silent
   * partial result actually costs someone. It now branches on the reader's
   * `coverage` rather than on a contact count:
   *
   *   none     -> a real failure. Full Disk Access advice, as before.
   *   partial  -> contacts ARE loading, and some address book did not open.
   *               `canLoadContacts: true` (she can work) + a `warning` (she is
   *               told what is missing). Previously indistinguishable from a
   *               clean run — she saw half her contacts, was shown nothing, and
   *               was then told her sync had succeeded when she filed a ticket.
   *   complete -> everything read.
   *
   * A ZERO CONTACT COUNT IS NO LONGER TREATED AS A FAILURE. It used to return
   * `canLoadContacts: false` with "You may need to grant Full Disk Access",
   * which is a wrong answer stated confidently: a successfully-read address
   * book that happens to be empty is not a permissions problem, and BACKLOG-2392
   * already had to fix one instance of this (a name-only book counted 0
   * reachable identifiers and produced a false Full Disk Access prompt for a
   * permission the user already held). "Found nothing" and "never looked" are
   * different answers; the coverage fields are what tell them apart, so the
   * count no longer has to stand in for a diagnosis it cannot make.
   */
  async checkContactsLoading(): Promise<ContactsLoadingResult> {
    // Windows/Linux: Contacts app is macOS-only, skip this check
    if (os.platform() !== "darwin") {
      logService.info(
        `Skipping Contacts loading check on ${os.platform()} (macOS-only feature)`,
        "PermissionService",
      );
      return {
        canLoadContacts: true,
        contactCount: 0,
      };
    }

    try {
      // Import contactsService here to avoid circular dependencies
      const { getContactNames } = await import("./contactsService");

      const result = await getContactNames();
      const status = result.status;

      // The coverage numbers travel on EVERY return below, including the
      // failure ones — "found 3, read 0" and "found 0, read 0" are different
      // diagnoses and a caller that only gets `canLoadContacts: false` cannot
      // tell them apart.
      const coverageFields = {
        coverage: status?.coverage,
        booksFound: status?.booksFound,
        booksRead: status?.booksRead,
        booksFailed: status?.booksFailed,
      };

      if (status && !status.success) {
        return {
          canLoadContacts: false,
          contactCount: 0,
          ...coverageFields,
          error: {
            type: "CONTACTS_LOADING_FAILED",
            title: "Cannot Load Contacts",
            message:
              status.userMessage ||
              "Could not load contacts from Contacts app",
            details: status.error || status.lastError || "Unknown error",
            action: status.action || "Grant Full Disk Access",
            actionHandler: "open-system-settings",
            severity: "error",
          },
        };
      }

      const contactCount =
        result.status?.contactCount || Object.keys(result.contactMap).length;

      // PARTIAL: some address book did not open. She can still work, so this is
      // a warning and not an error — but it must not be silent, which is the
      // entire ticket.
      if (status?.coverage === "partial") {
        const found = status.booksFound;
        const read = status.booksRead;
        const failed = status.booksFailed;
        // The two failure phases name different remedies; if every failure is
        // the corrupt-store signature, do not send her to Full Disk Access.
        const allCorrupt =
          status.failures.length > 0 &&
          status.failures.every((f) => f.reason === "load-error");

        logService.warn(
          `Contacts read was PARTIAL: read ${read} of ${found} address books`,
          "PermissionService",
          { booksFound: found, booksRead: read, booksFailed: failed },
        );

        return {
          canLoadContacts: true,
          contactCount,
          ...coverageFields,
          warning: {
            type: "CONTACTS_PARTIAL_READ",
            title: "Some Contacts Could Not Be Read",
            message:
              `Keepr read ${read} of ${found} address books. ` +
              `${failed} could not be opened, so some contacts may be missing.`,
            details: allCorrupt
              ? "An address book opened but failed mid-read — the store may be damaged."
              : "An address book could not be opened. Full Disk Access may be required.",
            action: allCorrupt ? "Open Contacts app to repair" : "Open System Settings",
            actionHandler: "open-system-settings",
            severity: "warning",
          },
        };
      }

      return {
        canLoadContacts: true,
        contactCount,
        ...coverageFields,
      };
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : "Unknown error";
      logService.error("Contacts loading check failed", "PermissionService", {
        error: errorMessage,
      });
      return {
        canLoadContacts: false,
        contactCount: 0,
        error: {
          type: "CONTACTS_CHECK_FAILED",
          title: "Contacts Check Failed",
          message: "Could not verify contacts access",
          details: (error as Error).message,
          action: "Grant Full Disk Access",
          actionHandler: "open-system-settings",
          severity: "error",
        },
      };
    }
  }

  /**
   * Check all required permissions
   * @returns {Promise<{allGranted: boolean, permissions: Object, errors: Array}>}
   */
  async checkAllPermissions(): Promise<AllPermissionsResult> {
    const results: AllPermissionsResult = {
      allGranted: true,
      permissions: {},
      errors: [],
    };

    // Check Full Disk Access
    const fullDiskAccess = await this.checkFullDiskAccess();
    results.permissions.fullDiskAccess = fullDiskAccess;
    if (!fullDiskAccess.hasPermission) {
      results.allGranted = false;
      results.errors.push(fullDiskAccess);
    }

    // Check Contacts
    const contacts = await this.checkContactsPermission();
    results.permissions.contacts = contacts;
    if (!contacts.hasPermission) {
      results.allGranted = false;
      results.errors.push(contacts);
    }

    return results;
  }

  /**
   * Get cached permission status (to avoid repeated file system checks)
   * @param {number} maxAge - Maximum cache age in milliseconds (default: 30 seconds)
   * @returns {Object|null} Cached permissions or null if expired
   */
  getCachedPermissions(maxAge: number = 30000): CachedPermissions | null {
    if (!this.permissionCache.cachedAt) {
      return null;
    }

    const age = Date.now() - this.permissionCache.cachedAt;
    if (age > maxAge) {
      return null;
    }

    return {
      fullDiskAccess: this.permissionCache.fullDiskAccess,
      contacts: this.permissionCache.contacts,
      cachedAt: this.permissionCache.cachedAt,
    };
  }

  /**
   * Clear permission cache
   */
  clearCache(): void {
    this.permissionCache = {
      fullDiskAccess: null,
      contacts: null,
      cachedAt: null,
    };
  }

  /**
   * Get user-friendly error message for permission errors
   * @param {Error} error
   * @returns {Object} Structured error with user message and actions
   */
  getPermissionError(error: Error): PermissionError {
    const errorMessage = error.message.toLowerCase();

    // Full Disk Access errors
    if (errorMessage.includes("eacces") || errorMessage.includes("eperm")) {
      return {
        type: "PERMISSION_DENIED",
        title: "Permission Required",
        message:
          "Keepr needs Full Disk Access to read your iMessages and Contacts.",
        details: error.message,
        action: "Open System Settings",
        actionHandler: "open-system-settings",
        severity: "error",
      };
    }

    // File not found (Messages database)
    if (errorMessage.includes("enoent") && errorMessage.includes("messages")) {
      return {
        type: "MESSAGES_NOT_FOUND",
        title: "Messages Database Not Found",
        message:
          "Could not find the iMessages database. Make sure Messages app is configured.",
        details: error.message,
        action: "Open Messages App",
        actionHandler: "open-messages-app",
        severity: "warning",
      };
    }

    // Generic database error
    if (errorMessage.includes("sqlite") || errorMessage.includes("database")) {
      return {
        type: "DATABASE_ERROR",
        title: "Database Error",
        message: "An error occurred while accessing the database.",
        details: error.message,
        action: "Check Console Logs",
        severity: "error",
      };
    }

    // Generic permission error
    return {
      type: "UNKNOWN_ERROR",
      title: "An Error Occurred",
      message: "Something went wrong. Please try again.",
      details: error.message,
      action: "Retry",
      actionHandler: "retry",
      severity: "error",
    };
  }
}

export default new PermissionService();
