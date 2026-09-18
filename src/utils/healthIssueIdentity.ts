/**
 * BACKLOG-3229 — a stable identity for one health-banner row.
 *
 * ---------------------------------------------------------------------------
 * WHY
 * ---------------------------------------------------------------------------
 * `SystemHealthMonitor` used to remember dismissals as a set of ARRAY INDICES.
 * Indices are positional and the issue list is rebuilt on every health check, so
 * "row 1 is dismissed" really meant "whatever is in slot 1 next time is
 * dismissed". The list does not need to be reordered for that to bite — it only
 * needs to CHANGE:
 *
 *   poll 1: [Full Disk Access]      user dismisses it        -> dismissed = {0}
 *   poll 2: [mailbox needs reconnecting]                     -> slot 0 again
 *
 * The length went 1 -> 1, never through 0, so the old "clear when the list is
 * empty" mitigation never fired, and the reconnect banner was filtered out by a
 * dismissal of something entirely unrelated. The user is never told her mailbox
 * is broken.
 *
 * ---------------------------------------------------------------------------
 * WHY IT IS COMPUTED HERE AND NOT STAMPED ON THE PAYLOAD
 * ---------------------------------------------------------------------------
 * The obvious fix — have the handler put an `id` on each issue — is blocked by
 * an existing guard: `diagnosticHandlers.oneRowPerCause-3237.test.ts:220`
 * asserts `toEqual` on the contacts row, so ANY field added to an emitted issue
 * breaks it. Identity is a renderer concern, so it is derived in the renderer
 * from fields the producer already sets, and the wire contract is not widened.
 *
 * ---------------------------------------------------------------------------
 * THE FIELDS, PER VARIANT
 * ---------------------------------------------------------------------------
 * No field is common to all three producers, so this has to branch:
 *
 *   permission probe  -> `errorCode`   ("FULL_DISK_ACCESS_DENIED", ...)
 *   contacts probe    -> `type`        ("CONTACTS_LOADING_FAILED", ...)
 *   broken mailbox    -> `provider`    (see below)
 *
 * Each result is PREFIXED so a future `errorCode` can never collide with a
 * `type` that happens to share its spelling.
 */

import type { HealthIssue } from "../../electron/types/ipc/healthIssue";

/**
 * A mailbox row is identified by its PROVIDER, not by its error type.
 *
 * Every broken-token error the banner can show for one provider carries the
 * same button: `connectionStatusService` emits `TOKEN_REFRESH_FAILED` (:193,
 * :325) and `CONNECTION_CHECK_FAILED` (:230, :362), and all four sites set
 * `actionHandler: "reconnect-<provider>"`. `NOT_CONNECTED` — the only
 * connection error with a different action — never reaches the banner, because
 * `diagnosticHandlers` filters on BROKEN_TOKEN_TYPES. One provider, one row, one
 * button, whichever error produced it.
 *
 * Keying on `type` instead would let a dismissed row come BACK: BACKLOG-3244
 * documents that the classifier cannot reliably separate revoked from expired
 * (it substring-matches error text), so the type can flap between polls while
 * the row the user sees is identical.
 *
 * BOUNDARY FOR BACKLOG-3244 — read this before changing the connection rows.
 * This holds only while every same-provider row shares one `actionHandler`. If
 * 3244 introduces an under-scoped case whose fix is "re-authorize" rather than
 * "reconnect", two different rows for one provider would collapse to one
 * identity and dismissing one would hide the other. At that point the identity
 * must include the action, or the variant must split.
 */
function connectionIdentity(provider: "google" | "microsoft"): string {
  return `connection:${provider}`;
}

/**
 * The stable identity of an issue, or `null` when it has none.
 *
 * `null` means NOT DISMISSABLE, and that is deliberate. Every `hasPermission:
 * false` path in `permissionService` sets an `errorCode` today, but the field is
 * optional in the type, so a future path could omit it. Giving such rows a
 * shared fallback string would make them collide — dismissing one would hide the
 * others, which is the exact defect this function exists to remove. Refusing to
 * dismiss fails toward SHOWING the user information.
 */
export function identityOf(issue: HealthIssue): string | null {
  // Checked first: a connection issue carries `type` as well, and provider is
  // the discriminator that matters for it.
  if (issue.provider) return connectionIdentity(issue.provider);
  if (issue.errorCode) return `permission:${issue.errorCode}`;
  if (issue.type) return `probe:${issue.type}`;
  return null;
}
