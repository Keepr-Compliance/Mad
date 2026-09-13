/**
 * BACKLOG-3219 / BACKLOG-3210 (part 2) — the Full Disk Access denial, as the
 * producers actually emit it.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS FILE EXISTS RATHER THAN A LITERAL IN EACH SUITE
 * ---------------------------------------------------------------------------
 * Three suites on both sides of the IPC boundary assert on this object:
 * the main-process transcription
 * (`electron/services/__tests__/permissionService.fdaDeniedShape-3219.test.ts`),
 * the health-check handler
 * (`electron/handlers/__tests__/diagnosticHandlers.fdaIssueAction-3219.test.ts`)
 * and the renderer banner
 * (`src/components/__tests__/SystemHealthMonitor.test.tsx`). If each wrote its
 * own literal, a producer change would move the real object while every suite
 * went on asserting the old one — green for the wrong reason, which is the
 * failure this repo has hit twice.
 *
 * BACKLOG-3213 re-pointed which leg of the transcription suite proves which
 * constant, because `checkFullDiskAccess` now reads the errno:
 *
 *   ABSENT (ENOENT/ENOTDIR)  `MESSAGES_STORE_NOT_FOUND_PERMISSION_RESULT`,
 *                            proved by the REAL filesystem leg — an empty temp
 *                            HOME produces a real ENOENT.
 *   DENIED (everything else) `FDA_DENIED_PERMISSION_RESULT`, proved two ways:
 *                            a real `chmod 000` fixture on POSIX, and an
 *                            errno-injected EPERM in
 *                            `permissionService.messagesErrno-3213.test.ts`,
 *                            which runs on every platform.
 *
 * Either way the tie to the real producer is kept, not loosened: drift a
 * constant and one of those legs reds FIRST, then everything fed from it.
 *
 * These are TEST FIXTURES ONLY. Nothing in `src/` or `electron/` imports this
 * file, so it never crosses the main/renderer boundary at runtime.
 */

/**
 * `permissionService.checkFullDiskAccess()` on a Mac that cannot read
 * `~/Library/Messages/chat.db`, minus `error` — that field carries the raw
 * errno message including an absolute path, which differs per machine and is
 * asserted as "a non-empty string" rather than pinned.
 *
 * NOTE WHAT IS ABSENT, because the whole of item 2 rests on it: there is no
 * `actionHandler`, no `title` and no `severity`. `SystemHealthMonitor` keys its
 * button entirely off `actionHandler`, so before BACKLOG-3219 this row's button
 * hit the `default:` branch and did nothing. The transcription suite asserts
 * the absence directly, so "the button was dead" is measured rather than read.
 */
export const FDA_DENIED_PERMISSION_RESULT = {
  hasPermission: false,
  errorCode: "FULL_DISK_ACCESS_DENIED",
  userMessage: "Full Disk Access permission is required to read iMessages.",
  action:
    "Please grant Full Disk Access in System Settings > Privacy & Security > Full Disk Access",
} as const;

/**
 * `permissionService.checkContactsPermission()` when macOS refuses the address
 * book. Same denial, second row — `~/Library/Application Support/AddressBook`
 * is behind the same permission, so a denied Mac raises both.
 */
export const CONTACTS_DENIED_PERMISSION_RESULT = {
  hasPermission: false,
  errorCode: "CONTACTS_ACCESS_DENIED",
  userMessage:
    "Contacts permission is required to match phone numbers to names.",
  action:
    "Full Disk Access in System Settings > Privacy & Security > Full Disk Access will grant access to Contacts",
} as const;

/**
 * BACKLOG-3210 part 1's third outcome: the address book is not on this Mac at
 * all. Deliberately NOT decorated with an explainer action — sending this user
 * to grant a permission she may already hold is the BACKLOG-2392 bug.
 *
 * BACKLOG-3233 — NOTE WHAT IS ABSENT: there is no `action`, and the copy names
 * no permission. Until this item it carried the DENIAL's `userMessage` and the
 * denial's `action` text with no `actionHandler` behind it — a dead button,
 * pinned as "today's behaviour" by two suites.
 *
 * THOSE TWO SUITES COULD NOT SEE THE PRODUCER CHANGE. Both asserted
 * `row.action === CONTACTS_STORE_NOT_FOUND_PERMISSION_RESULT.action` through a
 * MOCKED `checkAllPermissions`, so both sides of the comparison came from this
 * file and the real producer never ran. Changing `checkContactsPermission` left
 * them green. That is the exact drift this file's header warns about, found by
 * running the mutation rather than by reading the tests.
 *
 * SO THIS CONSTANT IS NOW TETHERED: `permissionService.contactsStoreShape-3214.test.ts`
 * drives the REAL `checkContactsPermission` against a real temp HOME with no
 * address book — a real ENOENT — and asserts this exact key set. Drift the
 * producer and that suite reds FIRST, then everything fed from it.
 *
 * Four suites consume this constant: `diagnosticHandlers.oneRowPerCause-3237`,
 * `diagnosticHandlers.fdaIssueAction-3219`, `src/utils/__tests__/healthIssueIdentity`
 * (keys on `errorCode`, so it is unaffected by the copy) and the transcription
 * leg above.
 */
export const CONTACTS_STORE_NOT_FOUND_PERMISSION_RESULT = {
  hasPermission: false,
  errorCode: "CONTACTS_STORE_NOT_FOUND",
  userMessage: "Keepr couldn't find a Contacts database on this Mac.",
} as const;

/**
 * BACKLOG-3213's third outcome for the MESSAGES probe: `chat.db` is not on
 * this Mac at all.
 *
 * NOTE WHAT IS ABSENT: there is no `action`. `SystemHealthMonitor` renders its
 * button as `{issue.action && (<button …>)}`, so omitting the field is what
 * takes the "grant Full Disk Access" instruction off a row where granting it
 * would change nothing. The key set is asserted directly against the real
 * producer in `permissionService.fdaDeniedShape-3219.test.ts`, so the absence
 * is measured rather than described.
 *
 * BACKLOG-3233 CLOSED the divergence this note used to describe.
 * `CONTACTS_STORE_NOT_FOUND_PERMISSION_RESULT` above now has the same shape for
 * the same reason: an absent store, named honestly, with no `action`. The two
 * probes answer "it is not here" identically.
 */
export const MESSAGES_STORE_NOT_FOUND_PERMISSION_RESULT = {
  hasPermission: false,
  errorCode: "MESSAGES_STORE_NOT_FOUND",
  userMessage: "Keepr couldn't find a Messages database on this Mac.",
} as const;

/** The button label the health banner must show for an FDA denial. */
export const FDA_EXPLAINER_ACTION_LABEL = "Show me how";

/** The handler `SystemHealthMonitor` must recognise for an FDA denial. */
export const FDA_EXPLAINER_ACTION_HANDLER = "open-fda-explainer";

/**
 * What the renderer actually receives for an FDA denial after
 * `diagnosticHandlers` collapses and decorates it: the producer's object, with
 * a button label short enough to be a button, a handler that goes somewhere,
 * and — BACKLOG-3237 — the heading and consequence text of the SINGLE row that
 * now stands for the whole denial.
 *
 * `title` and `message` were added when BACKLOG-3237 collapsed the two denial
 * rows into one. Without them this constant would describe a shape the handler
 * can no longer emit, and `SystemHealthMonitor.test.tsx` — which renders from
 * it — would have gone on asserting `userMessage` as the heading, a heading
 * production stopped showing. That is the exact failure this file's header
 * warns about, so the two strings are tied to the handler's exported constants
 * in `diagnosticHandlers.oneRowPerCause-3237.test.ts`.
 *
 * `userMessage` is deliberately still here and still the producer's: the
 * collapse adds fields, it does not rewrite the ones other consumers read.
 */
export const FDA_COLLAPSED_TITLE_TEXT = "Full Disk Access Required";
export const FDA_COLLAPSED_MESSAGE_TEXT =
  "Without it, Keepr can't read your Messages history or match phone numbers to contact names.";

export const FDA_DENIED_BANNER_ISSUE = {
  ...FDA_DENIED_PERMISSION_RESULT,
  error: "EPERM: operation not permitted",
  title: FDA_COLLAPSED_TITLE_TEXT,
  message: FDA_COLLAPSED_MESSAGE_TEXT,
  action: FDA_EXPLAINER_ACTION_LABEL,
  actionHandler: FDA_EXPLAINER_ACTION_HANDLER,
} as const;
