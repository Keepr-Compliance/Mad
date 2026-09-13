// ============================================
// DIAGNOSTIC IPC HANDLERS
// Handles: health checks, diagnostics, database maintenance
// ============================================

import { ipcMain, app } from "electron";
import type { IpcMainInvokeEvent } from "electron";
import os from "os";
// These 2 services use require() instead of ES imports because
// the test mocks (system-handlers.test.ts) don't set __esModule: true.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const permissionService = require("../services/permissionService").default;
// eslint-disable-next-line @typescript-eslint/no-var-requires
const connectionStatusService = require("../services/connectionStatusService").default;
import databaseService from "../services/databaseService";
import logService from "../services/logService";
import { wrapHandler } from "../utils/wrapHandler";
import {
  CONTACT_EMAILS_BY_ADDRESS_SQL,
  EMAILS_BY_PARTICIPANT_SQL,
  USER_EMAIL_COUNT_SQL,
} from "../services/db/emailAddressDiagnosticSql";
import {
  ValidationError,
  validateUserId,
  validateString,
  validateProvider,
} from "../utils/validation";
import type { HealthIssue } from "../types/ipc/healthIssue";
import type { ConnectionError } from "../services/connectionStatusService";

/**
 * BACKLOG-3230 — the broken-token types the health banner speaks for.
 *
 * `NOT_CONNECTED` is deliberately absent: a provider that was never connected is
 * the setup prompt's job, not a health error, and it is the only connection error
 * whose action is `connect-*` rather than `reconnect-*`.
 *
 * Hoisted to module scope so `isBrokenTokenError` below can be the ONE place
 * where the runtime check and the type agree.
 */
const BROKEN_TOKEN_TYPES = new Set([
  "TOKEN_REFRESH_FAILED",
  "TOKEN_EXPIRED",
  "CONNECTION_CHECK_FAILED",
]);

/**
 * BACKLOG-3230 — narrow a connection error the banner should speak for.
 *
 * A type PREDICATE rather than an annotation, deliberately. `connectionStatusService`
 * is loaded through `require()` (see the top of this file), so everything it
 * returns arrives as `any`; annotating the status object would be an unchecked
 * assertion wearing an annotation's clothes — the same blindfold BACKLOG-3230
 * removes, just quieter. Here the runtime check IS the narrowing, so the two
 * cannot drift apart.
 */
function isBrokenTokenError(error: unknown): error is ConnectionError {
  if (typeof error !== "object" || error === null) return false;
  const type = (error as { type?: unknown }).type;
  return typeof type === "string" && BROKEN_TOKEN_TYPES.has(type);
}

// Type definitions
interface HealthCheckResponse {
  success: boolean;
  healthy?: boolean;
  permissions?: unknown;
  connection?: unknown;
  contactsLoading?: unknown;
  // BACKLOG-3230: was `unknown[]`, which accepted every shape and made a
  // producer-side rename invisible to `npm run type-check`. Typing it is half
  // the fix; deleting the renderer's cast is the other half.
  issues?: HealthIssue[];
  summary?: {
    totalIssues: number;
    criticalIssues: number;
    warnings: number;
  };
  error?:
    | string
    | {
        type: string;
        userMessage: string;
        details?: string;
      };
}

/**
 * BACKLOG-2142: build the reconnect-banner subtitle "No email captured since
 * <date>" from a provider's last successful email-sync timestamp. Returns
 * undefined when there is no prior sync (null/absent) or the value is
 * unparseable, so the caller omits the subtitle cleanly. Display-only.
 */
function formatSinceMessage(lastSyncAt: string | null | undefined): string | undefined {
  if (!lastSyncAt) return undefined;
  const date = new Date(lastSyncAt);
  if (isNaN(date.getTime())) return undefined;
  const formatted = date.toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
  return `No email captured since ${formatted}`;
}

/**
 * BACKLOG-3219 / BACKLOG-3210 (part 2) — give a Full Disk Access denial a
 * button that does something.
 *
 * `permissionService.checkAllPermissions()` returns bare `PermissionResult`
 * objects: `{ hasPermission, error, errorCode, userMessage, action }`. They
 * carry no `actionHandler`, and the health banner keys its button entirely off
 * that field — `SystemHealthMonitor.handleAction` falls through to its
 * `default:` branch, logs "Unknown action handler" and does nothing. Until
 * BACKLOG-3219 nobody noticed, because `AppShell` gated the whole banner on
 * the permission being GRANTED, so this issue could never render.
 *
 * With that gate gone the row appears, and it needs two things it did not have:
 *
 *   - a button LABEL short enough to be a button. `action` is a 78-character
 *     sentence ("Please grant Full Disk Access in System Settings > ...") and
 *     is rendered directly as the label.
 *   - a HANDLER. `open-fda-explainer` opens the same explainer the Settings →
 *     Messages notice opens, rather than dropping the user straight into the
 *     macOS Privacy pane. The pane is still one click further in.
 *
 * Decorating HERE rather than in `permissionService` is deliberate: `action`
 * and `actionHandler` are health-banner presentation, this is where the
 * banner's issue list is assembled, and `checkAllPermissions` has three other
 * consumers (`systemHandlers`, `usePermissionsFlow` via `systemService`, and
 * the preload type mirror) that must not inherit a copy change.
 *
 * WHICH CODES. `FULL_DISK_ACCESS_DENIED` and `CONTACTS_ACCESS_DENIED` — both
 * ARE Full Disk Access denials (`~/Library/Application Support/AddressBook` is
 * FDA-protected, and the contacts error's own text already says Full Disk
 * Access is what grants it). On a denied Mac both fire, and leaving one row
 * with a dead button beside a live one would be its own defect.
 *
 * `CONTACTS_STORE_NOT_FOUND` is deliberately NOT decorated. Per the BACKLOG-3210
 * review, that code means the address book is absent, not refused; pointing
 * that user at a permission prompt is the BACKLOG-2392 bug — telling someone to
 * grant something she may already hold. It keeps today's behaviour untouched.
 *
 * Anything else is passed through byte-identical.
 */
export const FDA_EXPLAINER_ACTION = "Show me how";
export const FDA_EXPLAINER_ACTION_HANDLER = "open-fda-explainer";

/** Error codes that mean "macOS refused us, and Full Disk Access is the fix". */
const FDA_DENIAL_ERROR_CODES = new Set([
  "FULL_DISK_ACCESS_DENIED",
  "CONTACTS_ACCESS_DENIED",
]);

export function decorateFdaPermissionIssues(
  errors: ReadonlyArray<unknown>,
): unknown[] {
  return errors.map((issue) => {
    const errorCode = (issue as { errorCode?: unknown } | null)?.errorCode;
    if (typeof errorCode !== "string" || !FDA_DENIAL_ERROR_CODES.has(errorCode)) {
      return issue;
    }
    return {
      ...(issue as Record<string, unknown>),
      action: FDA_EXPLAINER_ACTION,
      actionHandler: FDA_EXPLAINER_ACTION_HANDLER,
    };
  });
}

/**
 * BACKLOG-3237 — ONE ROW PER ROOT CAUSE, NEVER ONE PER AFFECTED FEATURE.
 *
 * ---------------------------------------------------------------------------
 * WHAT THE USER SAW
 * ---------------------------------------------------------------------------
 * A Mac without Full Disk Access produced THREE stacked banner rows for one
 * missing permission:
 *
 *   1. "Full Disk Access permission is required to read iMessages."
 *      — `checkFullDiskAccess()`, `FULL_DISK_ACCESS_DENIED`
 *   2. "Contacts permission is required to match phone numbers to names."
 *      — `checkContactsPermission()`, `CONTACTS_ACCESS_DENIED`
 *   3. "Cannot Load Contacts / Could not load contacts from Contacts app"
 *      — `checkContactsLoading()`, `CONTACTS_LOADING_FAILED`
 *
 * None of that is new; BACKLOG-3219 only made it VISIBLE. `AppShell` had gated
 * the whole banner on the permission being granted, so a denied user saw zero
 * rows. Removing the gate turned zero into three.
 *
 * Row 3 deserves a specific note, because it is the worst of the three and it
 * does not look it. It is not action-less: it carries `actionHandler:
 * "open-system-settings"` and an `action` of "Grant Full Disk Access in System
 * Settings > Privacy & Security > Full Disk Access" — a 76-character sentence
 * that `SystemHealthMonitor` renders as a BUTTON LABEL, so it reads as loose
 * text. It drops the user in the raw macOS pane instead of the explainer. A
 * worse action, not a missing one.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS DOES
 * ---------------------------------------------------------------------------
 * `collapseFdaPermissionIssues` — the two denial codes become ONE row that
 * names the permission and lists the consequences as secondary text.
 *
 * `isDownstreamOfFdaDenial` — row 3 is SUPPRESSED while a denial is known,
 * because a denial fully explains it and the denial row says it better.
 *
 * `orderHealthIssues` — genuinely distinct causes are ordered so a row with a
 * working button always outranks one without.
 *
 * THE DISCRIMINATING CASE, and the reason suppression is conditional rather
 * than a deletion of the producer: with NO denial, row 3 is the only signal
 * there is — a corrupt or unreadable address book on a Mac that has granted
 * everything. `checkContactsLoading` cannot tell a denial from an absent
 * address book (proved in the BACKLOG-3210 review: byte-identical output for
 * both), which is exactly why it must not speak when something that CAN tell
 * them apart has already spoken — and must still speak when nothing has.
 */

/** The collapsed row's heading. `SystemHealthMonitor` renders `title || userMessage`. */
export const FDA_COLLAPSED_TITLE = "Full Disk Access Required";

/**
 * The collapsed row's subtitle — the consequences that used to be their own
 * rows. `SystemHealthMonitor` renders `message` under the title.
 */
export const FDA_COLLAPSED_MESSAGE =
  "Without it, Keepr can't read your Messages history or match phone numbers to contact names.";

/**
 * Issue `type`s from `checkContactsLoading()` that a Full Disk Access denial
 * fully explains. Both are downstream symptoms: the first is "the read
 * returned nothing", the second is "the check itself threw". Under a denial
 * neither can add anything the denial row has not already said.
 */
const FDA_DOWNSTREAM_ISSUE_TYPES = new Set([
  "CONTACTS_LOADING_FAILED",
  "CONTACTS_CHECK_FAILED",
]);

function errorCodeOf(issue: unknown): string | undefined {
  const code = (issue as { errorCode?: unknown } | null)?.errorCode;
  return typeof code === "string" ? code : undefined;
}

/**
 * Is macOS refusing us, as far as the permission probes can tell?
 *
 * Derived from the error CODES rather than from `allGranted`, deliberately.
 * `allGranted` is false for any unmet permission — including
 * `CONTACTS_STORE_NOT_FOUND`, which is not a denial at all — so keying
 * suppression off it would hide the contacts row for a user who has granted
 * everything and simply has no address book.
 */
export function hasFdaDenial(errors: ReadonlyArray<unknown>): boolean {
  return errors.some((issue) => {
    const code = errorCodeOf(issue);
    return code !== undefined && FDA_DENIAL_ERROR_CODES.has(code);
  });
}

/**
 * Should this `checkContactsLoading()` issue stay silent, given a denial is
 * already being reported? Matches on `type`, which is the field that producer
 * sets; anything else it might grow in future is passed through rather than
 * silently swallowed.
 */
export function isDownstreamOfFdaDenial(issue: unknown): boolean {
  const type = (issue as { type?: unknown } | null)?.type;
  return typeof type === "string" && FDA_DOWNSTREAM_ISSUE_TYPES.has(type);
}

/** BACKLOG-3233 — the address book is ABSENT, which is not a denial. */
const CONTACTS_STORE_ABSENT_ERROR_CODES = new Set(["CONTACTS_STORE_NOT_FOUND"]);

/**
 * NARROWER than FDA_DOWNSTREAM_ISSUE_TYPES on purpose. An absent store fully
 * explains "we read zero books" (CONTACTS_LOADING_FAILED). It does NOT explain
 * the check itself THROWING (CONTACTS_CHECK_FAILED), so that row still speaks.
 */
const STORE_ABSENT_DOWNSTREAM_ISSUE_TYPES = new Set(["CONTACTS_LOADING_FAILED"]);

export function hasContactsStoreAbsent(errors: ReadonlyArray<unknown>): boolean {
  return errors.some((issue) => {
    const code = errorCodeOf(issue);
    return code !== undefined && CONTACTS_STORE_ABSENT_ERROR_CODES.has(code);
  });
}

export function isDownstreamOfContactsStoreAbsent(issue: unknown): boolean {
  const type = (issue as { type?: unknown } | null)?.type;
  return typeof type === "string" && STORE_ABSENT_DOWNSTREAM_ISSUE_TYPES.has(type);
}

/**
 * Collapse every Full Disk Access denial into ONE decorated row, in the
 * position of the first one. Everything else — `CONTACTS_STORE_NOT_FOUND`
 * above all — is passed through BYTE-IDENTICAL, same object, same order.
 *
 * `CONTACTS_STORE_NOT_FOUND` must never be folded in: it means the address
 * book is absent, not refused, and telling that user to grant a permission she
 * may already hold is the BACKLOG-2392 bug.
 *
 * `userMessage` is left exactly as the producer wrote it. The renderer prefers
 * `title`, so the collapsed heading displays; the untouched `userMessage`
 * keeps this row identical, field for field, to what `usePermissionsFlow` and
 * `systemHandlers` see from the same producer.
 */
export function collapseFdaPermissionIssues(
  errors: ReadonlyArray<unknown>,
): unknown[] {
  const decorated = decorateFdaPermissionIssues(errors);

  // Prefer FULL_DISK_ACCESS_DENIED as the base when both fired: it is the
  // denial named after the permission, and its `userMessage` is the one that
  // survives on the collapsed object.
  const denialIndices = decorated
    .map((issue, index) => ({ issue, index }))
    .filter(({ issue }) => {
      const code = errorCodeOf(issue);
      return code !== undefined && FDA_DENIAL_ERROR_CODES.has(code);
    });

  if (denialIndices.length === 0) {
    return decorated;
  }

  const preferred =
    denialIndices.find(
      ({ issue }) => errorCodeOf(issue) === "FULL_DISK_ACCESS_DENIED",
    ) ?? denialIndices[0];

  const collapsed = {
    ...(preferred.issue as Record<string, unknown>),
    title: FDA_COLLAPSED_TITLE,
    message: FDA_COLLAPSED_MESSAGE,
  };

  // The collapsed row takes the slot of the FIRST denial, so it keeps the
  // position the denial already had relative to any unrelated issue.
  const firstDenialIndex = denialIndices[0].index;
  const out: unknown[] = [];
  decorated.forEach((issue, index) => {
    if (index === firstDenialIndex) {
      out.push(collapsed);
      return;
    }
    const code = errorCodeOf(issue);
    if (code !== undefined && FDA_DENIAL_ERROR_CODES.has(code)) {
      return; // the other denials are now part of the collapsed row
    }
    out.push(issue);
  });
  return out;
}

/**
 * Sort tier for one issue. LOWER SORTS FIRST.
 *
 *   0  blocking and user-fixable  — a real button that does something
 *   1  blocking, not user-fixable — nothing the user can press
 *   2  degraded                   — severity "warning"
 *   3  informational              — severity "info"
 *
 * TWO THINGS THIS DELIBERATELY DOES NOT DO.
 *
 * It does not read `action`. `CONTACTS_STORE_NOT_FOUND` carries action TEXT
 * with no handler behind it — `SystemHealthMonitor.handleAction` falls through
 * to `default:` and logs "Unknown action handler". Keying on the text would
 * rank a dead button as actionable, which is the defect this file already had
 * to fix once.
 *
 * It does not write a severity back onto the row. A permission result carries
 * no `severity` at all, and the renderer turns that absence into amber on
 * purpose. The tier computed here is SORT-LOCAL: an absent severity is treated
 * as blocking for ORDERING, and the row keeps its colour.
 */
export function healthIssueTier(issue: unknown): number {
  const record = issue as { severity?: unknown; actionHandler?: unknown } | null;
  const severity = record?.severity;
  if (severity === "info") return 3;
  if (severity === "warning") return 2;
  const handler = record?.actionHandler;
  return typeof handler === "string" && handler.length > 0 ? 0 : 1;
}

/**
 * Order the assembled issues by tier, so a row the user can act on is never
 * outranked by one she cannot.
 *
 * WITHIN A TIER, INSERTION ORDER IS KEPT, and that is a decision rather than
 * an omission. The obvious tiebreak — most recently detected first — is not
 * available: every health check rebuilds all issues from scratch in one
 * `Promise.all`, and no first-seen timestamp exists in this process or in the
 * renderer. Synthesising one here would produce a value identical for every
 * row in a run, which sorts by nothing while looking like it sorts by time.
 */
export function orderHealthIssues<T>(issues: ReadonlyArray<T>): T[] {
  return issues
    .map((issue, index) => ({ issue, index }))
    .sort((a, b) => healthIssueTier(a.issue) - healthIssueTier(b.issue) || a.index - b.index)
    .map(({ issue }) => issue);
}

/**
 * Register all diagnostic IPC handlers
 */
export function registerDiagnosticHandlers(): void {
  // ===== HEALTH CHECK =====
  // Note: This handler preserves its original try/catch because it returns
  // structured error objects (type/userMessage/details) which is incompatible
  // with wrapHandler's flat error string format.

  /**
   * Get system health status (all checks combined)
   */
  ipcMain.handle(
    "system:health-check",
    async (
      event: IpcMainInvokeEvent,
      userId: string | null = null,
      provider: string | null = null,
    ): Promise<HealthCheckResponse> => {
      try {
        // Validate inputs (both optional)
        const validatedUserId = userId ? validateUserId(userId) : null;
        const validatedProvider = provider ? validateProvider(provider) : null;

        // Skip permission checks on Windows (macOS-only features)
        const isMacOS = os.platform() === "darwin";

        // BACKLOG-2127: check ALL stored mailbox connections, not just the
        // login provider. SystemHealthMonitor only ever passes the login
        // provider, so the previous single-provider check missed a broken
        // Outlook mailbox when the user logged in with Google. The `provider`
        // arg is now advisory (used only to populate the `connection` field
        // for backward compatibility).
        const [permissions, allConnections, contactsLoading] = await Promise.all([
          isMacOS
            ? permissionService.checkAllPermissions()
            : { allGranted: true, permissions: {}, errors: [] },
          validatedUserId
            ? connectionStatusService.checkAllConnections(validatedUserId)
            : null,
          isMacOS
            ? permissionService.checkContactsLoading()
            : { canLoadContacts: true, contactCount: 0 },
        ]);

        // BACKLOG-3230: typed, so the literal built below is checked and the
        // two narrowing seams are forced to be explicit rather than implicit.
        const issues: HealthIssue[] = [];

        // Add permission issues.
        // BACKLOG-3219: decorated on the way in so the Full Disk Access row
        // has a short label and a handler that goes somewhere — see
        // decorateFdaPermissionIssues above. Non-FDA issues pass through
        // unchanged.
        // BACKLOG-3237: and the two denial codes are ONE row, not two — same
        // permission, same fix, so the consequences ride along as secondary
        // text instead of stacking.
        if (!permissions.allGranted) {
          // BACKLOG-3230 seam: `collapseFdaPermissionIssues` is declared
          // `: unknown[]` by BACKLOG-3237's design (anything it does not
          // recognise is passed through rather than swallowed), so the shape has
          // to be asserted here. BACKLOG-3233 owns those helpers and can retype
          // them, which would delete this cast.
          issues.push(...(collapseFdaPermissionIssues(permissions.errors) as HealthIssue[]));
        }

        // Add contacts loading issue.
        //
        // BACKLOG-3237: SUPPRESSED while a Full Disk Access denial is already
        // being reported. This probe cannot distinguish "macOS refused us"
        // from "there is no address book here" — it emits byte-identical
        // output for both — so under a denial it is a downstream symptom, with
        // worse wording and a button that opens the raw Privacy pane.
        //
        // With NO denial it is the ONLY signal a user gets that her contacts
        // are unreadable, so it still appears. `fdaDenied` reads the error
        // CODES rather than `allGranted`, which is also false for
        // CONTACTS_STORE_NOT_FOUND — an absent address book must not silence
        // this row.
        const fdaDenied = hasFdaDenial(permissions.errors);
        const storeAbsent = hasContactsStoreAbsent(permissions.errors);
        const contactsResult = contactsLoading as { canLoadContacts: boolean; error?: unknown };
        if (!contactsResult.canLoadContacts && contactsResult.error) {
          const explainedAlready =
            (fdaDenied && isDownstreamOfFdaDenial(contactsResult.error)) ||
            (storeAbsent && isDownstreamOfContactsStoreAbsent(contactsResult.error));
          if (!explainedAlready) {
            // BACKLOG-3230 seam, the second of two: `checkContactsLoading` reaches
            // this handler through the `require()` at the top of the file, so its
            // result arrives as `any` and the shape has to be asserted here. The
            // producer types it `ContactsIssue` (`permissionService.ts:22-30`),
            // which is the contacts variant of `HealthIssue` field for field.
            // BACKLOG-3289 (require -> ES import) is what would delete this cast.
            issues.push(contactsResult.error as HealthIssue);
          }
        }

        // BACKLOG-2127: Raise a reconnect issue for ANY provider whose stored
        // token is broken (TOKEN_REFRESH_FAILED / TOKEN_EXPIRED /
        // CONNECTION_CHECK_FAILED). Skip pure NOT_CONNECTED — a provider that
        // was never connected is the setup prompt's job, not a health error.
        // BACKLOG-3230: the allow-list moved to module scope as
        // BROKEN_TOKEN_TYPES, paired with the `isBrokenTokenError` predicate, so
        // the runtime check and the narrowed type are one fact instead of two.
        const providerStatuses: Array<[
          "google" | "microsoft",
          { error: unknown; lastSyncAt?: string | null } | undefined,
        ]> = allConnections
          ? [
              ["google", allConnections.google],
              ["microsoft", allConnections.microsoft],
            ]
          : [];
        for (const [providerName, status] of providerStatuses) {
          const connError = status?.error;
          if (isBrokenTokenError(connError)) {
            // BACKLOG-2142: when a prior successful email sync exists, add a
            // "No email captured since <date>" subtitle to the reconnect banner.
            // Display-only — composed here so the discriminator stays `type` and
            // no new renderer plumbing is needed (SystemHealthMonitor renders
            // `issue.message` as the subtitle). Omitted cleanly when null.
            const sinceMessage = formatSinceMessage(status?.lastSyncAt);
            // BACKLOG-3230: `type` is NOT set here. It arrives from the spread
            // below — `isBrokenTokenError` has already established that
            // `connError.type` is a broken-token type, so the spread always
            // supplies it. A literal `type` written above the spread would be
            // silently overwritten by it, which is what used to happen here;
            // once `connError` is typed the compiler says so directly (TS2783).
            //
            // The spread is of a TYPED value now. It used to be
            // `connError as unknown as Record<string, unknown>`, and that cast
            // was load-bearing in the wrong direction: an index-signature spread
            // erases the field names, so neither the overwrite above nor a
            // renamed field here could be seen by the compiler.
            issues.push({
              provider: providerName,
              severity: "error",
              ...connError,
              ...(sinceMessage ? { message: sinceMessage } : {}),
            });
          }
        }

        // Backward-compat `connection` field: the single login-provider status.
        const connection = allConnections
          ? validatedProvider === "google"
            ? allConnections.google
            : validatedProvider === "microsoft"
              ? allConnections.microsoft
              : null
          : null;

        // BACKLOG-3237: the renderer maps this array in order and never
        // sorts, so ordering is decided here — a row with a working button
        // ahead of one without. Ordering only; no row is rewritten.
        const orderedIssues = orderHealthIssues(issues);

        return {
          success: true,
          healthy: orderedIssues.length === 0,
          permissions,
          connection,
          contactsLoading,
          issues: orderedIssues,
          summary: {
            totalIssues: orderedIssues.length,
            criticalIssues: orderedIssues.filter(
              (i) => (i as { severity?: string }).severity === "error",
            ).length,
            warnings: orderedIssues.filter(
              (i) => (i as { severity?: string }).severity === "warning",
            ).length,
          },
        };
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : "Unknown error";
        logService.error("System health check failed", "Diagnostics", {
          error: errorMessage,
        });
        if (error instanceof ValidationError) {
          return {
            success: false,
            healthy: false,
            error: {
              type: "VALIDATION_ERROR",
              userMessage: "Invalid input parameters",
              details: error.message,
            },
          };
        }
        return {
          success: false,
          healthy: false,
          error: {
            type: "HEALTH_CHECK_FAILED",
            userMessage: "Could not check system status",
            details: errorMessage,
          },
        };
      }
    },
  );

  // ===== DIAGNOSTICS =====

  /**
   * Get diagnostic information for support requests
   */
  ipcMain.handle(
    "system:get-diagnostics",
    wrapHandler(async (): Promise<{
      success: boolean;
      diagnostics?: string;
      error?: string;
    }> => {
      const diagnostics = {
        app: {
          version: app.getVersion(),
          name: app.getName(),
          locale: app.getLocale(),
        },
        system: {
          platform: process.platform,
          arch: process.arch,
          osVersion: os.release(),
          osType: os.type(),
          nodeVersion: process.version,
          electronVersion: process.versions.electron,
        },
        memory: {
          total: `${Math.round(os.totalmem() / 1024 / 1024 / 1024)}GB`,
          free: `${Math.round(os.freemem() / 1024 / 1024 / 1024)}GB`,
        },
        timestamp: new Date().toISOString(),
      };

      const diagnosticString = Object.entries(diagnostics)
        .map(([category, values]) => {
          if (typeof values === "object") {
            const items = Object.entries(values as Record<string, unknown>)
              .map(([key, val]) => `  ${key}: ${val}`)
              .join("\n");
            return `${category.toUpperCase()}:\n${items}`;
          }
          return `${category}: ${values}`;
        })
        .join("\n\n");

      return { success: true, diagnostics: diagnosticString };
    }, { module: "Diagnostics" }),
  );

  // ============================================
  // DATA DIAGNOSTIC HANDLERS
  // ============================================

  ipcMain.handle(
    "diagnostic:message-health-report",
    wrapHandler(async (_event: IpcMainInvokeEvent, userId: string) => {
      validateUserId(userId);
      return await databaseService.diagnosticMessageHealthReport(userId);
    }, { module: "Diagnostics" }),
  );

  ipcMain.handle(
    "diagnostic:messages-null-thread-id",
    wrapHandler(async (_event: IpcMainInvokeEvent, userId: string) => {
      validateUserId(userId);
      return await databaseService.diagnosticGetMessagesWithNullThreadId(userId);
    }, { module: "Diagnostics" }),
  );

  ipcMain.handle(
    "diagnostic:messages-garbage-text",
    wrapHandler(async (_event: IpcMainInvokeEvent, userId: string) => {
      validateUserId(userId);
      return await databaseService.diagnosticGetMessagesWithGarbageText(userId);
    }, { module: "Diagnostics" }),
  );

  ipcMain.handle(
    "diagnostic:threads-for-contact",
    wrapHandler(async (_event: IpcMainInvokeEvent, userId: string, phoneDigits: string) => {
      validateUserId(userId);
      validateString(phoneDigits, "phoneDigits");
      return await databaseService.diagnosticGetThreadsForContact(userId, phoneDigits);
    }, { module: "Diagnostics" }),
  );

  ipcMain.handle(
    "diagnostic:null-thread-id-analysis",
    wrapHandler(async (_event: IpcMainInvokeEvent, userId: string) => {
      validateUserId(userId);
      return await databaseService.diagnosticNullThreadIdAnalysis(userId);
    }, { module: "Diagnostics" }),
  );

  ipcMain.handle(
    "diagnostic:unknown-recipient-messages",
    wrapHandler(async (_event: IpcMainInvokeEvent, userId: string) => {
      validateUserId(userId);
      return await databaseService.diagnosticUnknownRecipientMessages(userId);
    }, { module: "Diagnostics" }),
  );

  // Diagnostic: Check email data for a specific contact email
  ipcMain.handle(
    "diagnostic:check-email-data",
    wrapHandler(async (_event: IpcMainInvokeEvent, userId: string, emailAddress: string) => {
      validateUserId(userId);
      validateString(emailAddress, "emailAddress", { required: true, maxLength: 255 });

      const db = databaseService.getRawDatabase();

      // Check contact_emails junction table
      const contactEmails = db
        .prepare(CONTACT_EMAILS_BY_ADDRESS_SQL)
        .all(userId, emailAddress);

      // BACKLOG-506 / BACKLOG-1722 — why this reads the junction rather than
      // scanning `emails` is documented with the statement in db/.
      const communications = db
        .prepare(EMAILS_BY_PARTICIPANT_SQL)
        .all(userId, emailAddress.toLowerCase().trim());

      // Count total emails for this user
      const totalEmails = db
        .prepare(USER_EMAIL_COUNT_SQL)
        .get(userId) as { count: number };

      return {
        success: true,
        emailAddress,
        contactEmailsFound: contactEmails.length,
        contactEmails,
        communicationsFound: communications.length,
        communications,
        totalEmailsInDb: totalEmails.count,
      };
    }, { module: "Diagnostics" }),
  );

  // ============================================
  // DATABASE MAINTENANCE HANDLERS
  // ============================================

  /**
   * Reindex the database for performance optimization
   * Rebuilds all performance indexes and runs ANALYZE
   */
  ipcMain.handle(
    "system:reindex-database",
    wrapHandler(async (): Promise<{
      success: boolean;
      indexesRebuilt?: number;
      durationMs?: number;
      error?: string;
    }> => {
      logService.info("Database reindex requested via UI", "Diagnostics");
      const result = await databaseService.reindexDatabase();
      return result;
    }, { module: "Diagnostics" }),
  );
}
