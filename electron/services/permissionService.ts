/**
 * Permission Service
 * Centralized permission checking and error handling
 */

import { promises as fs } from "fs";
import path from "path";
import os from "os";
import logService from "./logService";
import { CONTACTS_BASE_DIR } from "../constants";

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

      // ---------------------------------------------------------------------
      // BACKLOG-3213 — WHICH errno, not merely "it threw".
      // ---------------------------------------------------------------------
      // Mirrors `checkContactsPermission` below, which BACKLOG-3210 gave this
      // exact split for the address book. macOS TCC refuses a protected path
      // with EPERM; a `chat.db` that is simply not on this Mac fails with
      // ENOENT. Collapsing the two told a Mac that has never run Messages to
      // grant Full Disk Access — and granting it changed nothing, because the
      // permission was never the problem.
      //
      // THE DEFAULT IS DENIED, DELIBERATELY. Only the errnos that positively
      // mean "nothing is there" are carved out; an unknown errno, or a
      // rejection carrying no `code` at all, stays FULL_DISK_ACCESS_DENIED.
      // Defaulting the other way would tell a denied Mac it has no messages.
      //
      // MECHANISM UNTRACED — the denied-AND-absent intersection. A `chat.db`
      // that does not exist inside a TCC-protected `~/Library/Messages`, on a
      // Mac WITHOUT Full Disk Access, has not been measured: the two hand
      // measurements this split rests on (2026-09-07, macOS 15, a process
      // without FDA) covered a `chat.db` that EXISTS -> EPERM, and the
      // AddressBook path. Neither covers the intersection, and it is not
      // measurable on a development machine, whose `chat.db` exists and whose
      // process inherits Full Disk Access from its parent. Both fail
      // directions are acceptable: EPERM -> denied is today's behaviour;
      // ENOENT -> absent still REFUSES the import and still offers no false
      // permission instruction. The worst case is an under-informative
      // sentence, never a wrong instruction.
      //
      // An EMPTY `chat.db` is out of scope by construction: it passes
      // `fs.access`, so it never reaches this catch and is reported granted.
      const code = (error as NodeJS.ErrnoException).code;
      const storeIsAbsent = code === "ENOENT" || code === "ENOTDIR";

      return {
        // UNCHANGED on BOTH paths. This is the only field crossing
        // `window.api` that `checkAllPermissions`, the import preflight and
        // the support-ticket diagnostics branch on. This change moves the
        // diagnosis, never the verdict.
        hasPermission: false,
        error: (error as Error).message,
        errorCode: storeIsAbsent
          ? "MESSAGES_STORE_NOT_FOUND"
          : "FULL_DISK_ACCESS_DENIED",
        // The absent copy names the missing DATABASE, never "no history":
        // ENOENT proves the file is not there and says nothing about whether
        // Messages was ever used. It mentions no permission and no System
        // Settings, because neither is the fix.
        userMessage: storeIsAbsent
          ? "Keepr couldn't find a Messages database on this Mac."
          : "Full Disk Access permission is required to read iMessages.",
        // `action` is OMITTED on the absent path, and that omission is the
        // whole of the banner change: `SystemHealthMonitor` renders its button
        // as `{issue.action && (<button …>)}`, so keeping the denial's action
        // here would put the wrong instruction back as a live button.
        //
        // This DIVERGES from `checkContactsPermission`, which keeps its action
        // on both paths on purpose (see its comment). There, rewording was out
        // of scope. Here the wrong sentence IS the item. BACKLOG-3233
        // reconciles the two.
        ...(storeIsAbsent
          ? {}
          : {
              action:
                "Please grant Full Disk Access in System Settings > Privacy & Security > Full Disk Access",
            }),
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
      // -----------------------------------------------------------------
      // BACKLOG-3214 — PROBE WHAT THE READER READS.
      // -----------------------------------------------------------------
      // This used to be a hardcoded `.../AddressBook/Sources`, and that is a
      // SUBFOLDER macOS only creates once a network account has been added.
      // The reader walks the PARENT (`contactsService.ts:509`, via this same
      // constant) and also reads `AddressBook-v22.abcddb` sitting directly in
      // it — the "On My Mac" store.
      //
      // So a Mac whose contacts are all local had its address book read
      // perfectly while this probe returned ENOENT, and the user was told a
      // permission was missing. Granting it did not help: there was nothing
      // to grant, and the subfolder stayed absent.
      //
      // The consequence was never only cosmetic. `checkAllPermissions` turns
      // this into `allGranted: false`, which reaches `useAutoRefresh.ts:303`
      // — `isMacOS && hasPermissions && importSource === 'macos-native'` —
      // so a false reading here SWITCHES OFF macOS message sync.
      //
      // `CONTACTS_BASE_DIR` is imported rather than restated so the probe and
      // the reader answer from ONE path and cannot drift apart again.
      // `permissionService.probeReaderParity-3214.test.ts` sweeps the layouts
      // and asserts that invariant directly.
      const contactsDbPath = path.join(process.env.HOME!, CONTACTS_BASE_DIR);
      await fs.access(contactsDbPath, fs.constants.R_OK);

      this.permissionCache.contacts = true;
      this.permissionCache.cachedAt = Date.now();

      return {
        hasPermission: true,
      };
    } catch (error) {
      this.permissionCache.contacts = false;
      this.permissionCache.cachedAt = Date.now();

      // ---------------------------------------------------------------------
      // BACKLOG-3210 — WHICH errno, not merely "it threw".
      // ---------------------------------------------------------------------
      // macOS TCC refuses a protected path with EPERM. A path that simply is
      // not on this Mac fails with ENOENT. Collapsing the two into one
      // `errorCode` is what left `contacts:syncExternal` unable to tell a Full
      // Disk Access denial from an address book that genuinely holds nobody —
      // and it told the user the second thing while the first was true.
      //
      // Measured 2026-09-07 on macOS 15, from a process WITHOUT Full Disk
      // Access (so this is the denied state, not a description of it):
      //   ~/Library/Application Support/AddressBook          -> EPERM
      //   ~/Library/Application Support/AddressBook/Sources   -> EPERM
      //   a non-existent sibling of the same directory        -> ENOENT
      //
      // BACKLOG-3214 moved the probe to the FIRST of those. That measurement
      // covers it, so a denied Mac still classifies as denied — and it also
      // closes 3214's originally-filed bar, "denied AND `Sources/` absent",
      // because `AddressBook/` itself exists on a denied Mac and answers
      // EPERM where the subfolder answered ENOENT. The errno-injection legs
      // in `permissionService.contactsStoreShape-3214.test.ts` are the
      // control for that.
      //
      // STILL UNTRACED, and not closed by this change: denied AND
      // `AddressBook/` ITSELF absent. That is a different intersection, it
      // has never been measured, and it is not measurable on a development
      // machine — see the same note on `checkFullDiskAccess` above.
      //
      // THE DEFAULT IS DENIED, DELIBERATELY. Only the errnos that positively
      // mean "nothing is there" are carved out; an unknown errno, or a
      // rejection carrying no `code` at all, stays `CONTACTS_ACCESS_DENIED`.
      // Defaulting the other way would restate the bug being fixed here —
      // an unrecognised failure reported to the user as an empty address book.
      const code = (error as NodeJS.ErrnoException).code;
      const storeIsAbsent = code === "ENOENT" || code === "ENOTDIR";

      return {
        hasPermission: false,
        error: (error as Error).message,
        errorCode: storeIsAbsent
          ? "CONTACTS_STORE_NOT_FOUND"
          : "CONTACTS_ACCESS_DENIED",
        // `hasPermission` is UNCHANGED on both paths. It is the field that
        // crosses `window.api`, and `checkAllPermissions`, the health banner
        // and `classifyEmptyMacOSRead` all branch on it; this change moves
        // the diagnosis, never the verdict.
        //
        // BACKLOG-3233 — `userMessage` and `action` now DIVERGE by path, and
        // the divergence is the deliverable. The absent copy names the
        // missing DATABASE and mentions no permission, because naming one
        // would be BACKLOG-2392: telling someone to grant what she may
        // already hold. `action` is OMITTED rather than reworded —
        // `SystemHealthMonitor.tsx:368` renders its button as
        // `{issue.action && (…)}`, so omitting the field is what removes a
        // button that had no `actionHandler` behind it and fell through to
        // `default:` "Unknown action handler".
        //
        // This is the reconciliation `checkFullDiskAccess` above predicted
        // ("BACKLOG-3233 reconciles the two"): the two probes now answer an
        // absent store in the same shape.
        userMessage: storeIsAbsent
          ? "Keepr couldn't find a Contacts database on this Mac."
          : "Contacts permission is required to match phone numbers to names.",
        ...(storeIsAbsent
          ? {}
          : {
              action:
                "Full Disk Access in System Settings > Privacy & Security > Full Disk Access will grant access to Contacts",
            }),
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
