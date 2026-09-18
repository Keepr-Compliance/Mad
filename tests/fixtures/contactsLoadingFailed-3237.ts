/**
 * BACKLOG-3237 — the third banner row, as the producer actually emits it.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS FILE EXISTS
 * ---------------------------------------------------------------------------
 * On a Mac without Full Disk Access the health banner stacked three rows for
 * one missing permission. The third came from
 * `permissionService.checkContactsLoading()`, and the whole of BACKLOG-3237
 * turns on two claims about it that must be MEASURED, not asserted from a
 * hand-written literal:
 *
 *   - under a denial it says nothing the denial row does not say better, so it
 *     is suppressed;
 *   - with NO denial it is the only signal there is, so it must still appear.
 *
 * A fixture invented to fit those claims would pass for the wrong reason. So
 * `CONTACTS_LOADING_FAILED_ISSUE` below is pinned against the output of the
 * REAL `checkContactsLoading()` in
 * `electron/services/__tests__/permissionService.contactsLoadingRow-3237.test.ts`.
 * Drift the producer and that suite reds FIRST, then everything fed from it.
 *
 * TEST FIXTURES ONLY. Nothing in `src/` or `electron/` imports this file.
 */

/**
 * The `status` half of `getContactNames()`'s failure return, transcribed from
 * `electron/services/contactsService.ts:652-670` (the catch block). "found 3,
 * read 0" is the denied-Mac diagnosis: three address books are on disk and
 * none of them opened.
 *
 * `userMessage` and `action` are the producer's own strings — note that
 * `action` is a 76-character sentence, which `SystemHealthMonitor` renders as
 * a BUTTON LABEL. That is why the row reads as loose text.
 */
export const CONTACTS_LOAD_FAILED_STATUS = {
  success: false,
  contactCount: 0,
  booksFound: 3,
  booksRead: 0,
  booksFailed: 3,
  coverage: "none",
  failures: [
    { path: "AddressBook-v22.abcddb", reason: "read-error" },
    { path: "Sources/0CA70…/AddressBook-v22.abcddb", reason: "read-error" },
    { path: "Sources/1DB81…/AddressBook-v22.abcddb", reason: "read-error" },
  ],
  error: "No contacts could be loaded from any database",
  userMessage: "Could not load contacts from Contacts app",
  action:
    "Grant Full Disk Access in System Settings > Privacy & Security > Full Disk Access",
} as const;

/**
 * What `checkContactsLoading()` hands the health check when it is given the
 * status above — the third row, exactly as the user saw it.
 *
 * NOTE `actionHandler`: this row is NOT action-less. It has a button, and the
 * button goes to the raw macOS Privacy pane rather than the explainer. A worse
 * action than the Full Disk Access row's, not a missing one.
 */
export const CONTACTS_LOADING_FAILED_ISSUE = {
  type: "CONTACTS_LOADING_FAILED",
  title: "Cannot Load Contacts",
  message: "Could not load contacts from Contacts app",
  details: "No contacts could be loaded from any database",
  action:
    "Grant Full Disk Access in System Settings > Privacy & Security > Full Disk Access",
  actionHandler: "open-system-settings",
  severity: "error",
} as const;

/**
 * The same producer's other failure row: the check itself threw. Equally
 * downstream of a denial, so it is suppressed on the same terms — see
 * `FDA_DOWNSTREAM_ISSUE_TYPES` in `diagnosticHandlers.ts`.
 */
export const CONTACTS_CHECK_FAILED_ISSUE = {
  type: "CONTACTS_CHECK_FAILED",
  title: "Contacts Check Failed",
  message: "Could not verify contacts access",
  details: "boom",
  action: "Grant Full Disk Access",
  actionHandler: "open-system-settings",
  severity: "error",
} as const;

/**
 * A broken mailbox token, as `diagnosticHandlers` assembles it from
 * `connectionStatusService`. Present here so the ordering control has a SECOND
 * genuinely distinct cause to rank — one with a live handler.
 */
export const OAUTH_RECONNECT_CONNECTION_ERROR = {
  type: "TOKEN_REFRESH_FAILED",
  severity: "error",
  userMessage: "Your Outlook connection needs to be renewed.",
  action: "Reconnect",
  actionHandler: "reconnect-microsoft",
} as const;
