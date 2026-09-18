/**
 * BACKLOG-3230 — the shape of a `system:health-check` issue row.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS FILE EXISTS
 * ---------------------------------------------------------------------------
 * The channel declared `issues?: string[]` in three places while the producer
 * emitted OBJECTS. Nothing broke, because the only consumer cast the payload to
 * a local all-optional interface and read fields off it. That cast is what made
 * the disagreement survivable — and a weak type (every property optional) is
 * mutually comparable with `string`, so `string[] as SystemIssue[]` compiled
 * with ZERO diagnostics. The contract could not fail, which is another way of
 * saying it was not a contract.
 *
 * Each variant below therefore carries at least one REQUIRED field. That is the
 * whole mechanism: it is what makes the union non-weak, and a `string[]` cast
 * against it now fails with TS2352.
 *
 * ---------------------------------------------------------------------------
 * WHY A UNION AND NOT ONE INTERFACE
 * ---------------------------------------------------------------------------
 * `diagnosticHandlers.ts` assembles this array from three different producers
 * with three genuinely different shapes, and NO field is common to all three:
 *
 *   1. permission probes    -> `errorCode`, never `type`      (permissionService)
 *   2. contacts-load probe  -> `type`, never `errorCode`      (permissionService)
 *   3. broken mailbox token -> `type` AND `provider`          (connectionStatusService)
 *
 * Flattening them into one optional-everything interface is exactly the weak
 * type this item exists to remove.
 *
 * The `?: undefined` witness fields are not decoration. TypeScript only permits
 * a property read across a union when the property exists on EVERY member, and
 * the renderer derives a row's identity with `errorCode ?? type`. Declaring the
 * absent discriminants as `?: undefined` makes that read type-check without
 * narrowing, while still making a wrong assignment an error.
 */

import type { ConnectionErrorType } from "../../services/connectionStatusService";

/** Severity as the producer actually emits it. */
export type HealthIssueSeverity = "error" | "warning";

/**
 * A permission probe that came back refused.
 *
 * `permissionService.checkAllPermissions()` pushes bare `PermissionResult`
 * objects into `errors`. `diagnosticHandlers` may then decorate them with an
 * `action`/`actionHandler` pair, and may collapse several into one row carrying
 * `title`/`message` (BACKLOG-3219, BACKLOG-3237).
 *
 * `severity` is OPTIONAL and must stay so. A permission result carries none, the
 * renderer turns that absence into amber deliberately, and
 * `diagnosticHandlers.oneRowPerCause-3237.test.ts:331` asserts
 * `not.toHaveProperty("severity")` on exactly these rows. This is a type-level
 * optional only: it adds no runtime property.
 */
export interface HealthPermissionIssue {
  hasPermission: false;
  /** The identity of this row. Every `hasPermission: false` path sets it. */
  errorCode?: string;
  error?: string;
  userMessage?: string;
  severity?: HealthIssueSeverity;
  title?: string;
  message?: string;
  details?: string;
  action?: string;
  actionHandler?: string;
  type?: undefined;
  provider?: undefined;
}

/**
 * `permissionService.checkContactsLoading()` reporting that the address book
 * could not be read. Every field is set by that producer.
 */
export interface HealthContactsIssue {
  /** The identity of this row, e.g. "CONTACTS_LOADING_FAILED". */
  type: string;
  title: string;
  message: string;
  details: string;
  action: string;
  actionHandler: string;
  severity: HealthIssueSeverity;
  userMessage?: string;
  errorCode?: undefined;
  provider?: undefined;
}

/**
 * A mailbox whose stored token is broken.
 *
 * `provider` is REQUIRED, and it is what the renderer keys dismissal on. Both
 * mailboxes can be broken at once with an identical `type`, so `type` alone
 * cannot tell the two rows apart.
 */
export interface HealthConnectionIssue {
  type: ConnectionErrorType;
  provider: "google" | "microsoft";
  severity: HealthIssueSeverity;
  userMessage: string;
  message?: string;
  details?: string;
  title?: string;
  action?: string;
  actionHandler?: string;
  errorCode?: undefined;
}

/** One row of the health banner, as `system:health-check` actually emits it. */
export type HealthIssue =
  | HealthPermissionIssue
  | HealthContactsIssue
  | HealthConnectionIssue;
