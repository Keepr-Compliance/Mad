/**
 * Every user-visible string of Settings › Keepr Cloud (BACKLOG-4243, plan §9).
 * One file so the wording can change without touching the component.
 *
 * NOTICE_TEXTS: the notice for each version this build can show. Main holds the
 * same version list (electron/services/cloudSync/notice.ts); a parity test
 * keeps them equal.
 */
export const NOTICE_TEXTS: Readonly<Record<number, string>> = Object.freeze({
  1:
    "Keepr Cloud keeps a copy of your deals online: details, prices, commission, checklists (including private ones), todos, and the people on each deal with their names, companies, email addresses, phone numbers and notes. " +
    "Your emails, texts, files and contact list are not uploaded. " +
    // BACKLOG-4263 PR-6: founder Q4 (b), 2026-11-17, character for character. v1 kept as the number (no one accepted v1 in production).
    "AI apps you connect, like Claude or ChatGPT, can read this copy and change your todos. That includes other people's contact details. What they read is sent to that app's company. " +
    "Turning Keepr Cloud off deletes the online copy and disconnects every AI app.",
});

export const KEEPR_CLOUD_COPY = {
  title: "Keepr Cloud",
  switchLabel: "Keepr Cloud",
  offDescription:
    "Save a copy of your deals online so AI apps you connect, like Claude or ChatGPT, can answer questions about them.",
  turnOn: "Turn on",
  cancel: "Cancel",
  // A new or reset computer when Keepr Cloud is already on (pending founder answer; default: ask).
  thisComputer: "Keepr Cloud is on for your account. Save this computer's deals too?",
  // BACKLOG-4263 PR-6 (PR-4a review): after a re-link, the online values win.
  thisComputerTodos: "If a todo was changed both here and online, the online version is kept.",
  saveThisComputer: "Save this computer's deals",
  notNow: "Not now",
  statusSaved: (ago: string) => `Saved online · last saved ${ago}`,
  statusSaving: (n: number) => (n === 1 ? "Saving 1 deal" : `Saving ${n} deals`),
  statusOn: "Saved online",
  statusNotSaved: (n: number) => (n === 1 ? "1 deal could not be saved online." : `${n} deals could not be saved online.`),
  pausedSignedOut: "Paused — sign in to continue saving",
  pausedOffline: "Paused — no internet connection",
  pausedNotActive: "Paused — your Keepr Cloud add-on is not active",
  pausedOtherProject: "Paused — this profile saves to a different Keepr Cloud",
  pausedOther: "Paused — Keepr will try again soon",
  errorLine: "Some changes could not be saved.",
  tryAgain: "Try again",
  updateNeeded: "Update Keepr to keep saving",
  turnOff: "Turn off and delete online copy",
  turnOffConfirmTitle: "Turn off Keepr Cloud?",
  turnOffConfirm:
    "Your online copy is deleted from Keepr Cloud for all your computers, and connected AI apps are disconnected. Your deals on this computer are not changed.",
  // BACKLOG-4263 PR-6 (plan §7, F6)
  turnOffLost: "Changes made by AI apps or on other devices that are not on this computer yet are lost.",
  turnOffArchive: "Deals you deleted in the last 30 days can no longer be restored.",
  turnOffTodos: "Todos removed in the last 30 days can no longer be restored.",
  turnOffConfirmButton: "Turn off and delete",
  turnOffDone: "Keepr Cloud is off. Your online copy was deleted and AI apps were disconnected.",
  turnOffOffline: "Turning off. Your online copy will be deleted when Keepr can reach the internet.",
  onlineNotHere: (n: number) => `Saved online but not on this computer: ${n === 1 ? "1 deal" : `${n} deals`}.`,
  otherInstalls: (n: number, when: string) =>
    `Deals saved from another computer or an earlier install: ${n}, last saved ${when}.`,
  deleteThem: "Delete them",
  deleteOnlineConfirmTitle: "Delete these online deals?",
  deleteOnlineConfirm: "They are deleted from Keepr Cloud. Your deals on this computer are not changed.",
  deleteInstallsConfirm:
    "The online copies saved from your other computers or an earlier install are deleted. Your deals on this computer are not changed.",
  deleteButton: "Delete",
  forget: "Forget saving on this computer for the other Keepr Cloud",
  forgetConfirm: "This computer stops tracking what it saved to the other Keepr Cloud. Nothing online is deleted.",
  forgetButton: "Forget",
  aiAppsTitle: "AI apps",
  aiAppsDescription: "Connect Keepr to Claude or ChatGPT to ask about your deals. Connections are managed on the Keepr website.",
  manageAiApps: "Manage AI apps",
  actionFailed: "That did not work. Try again.",

  // ---- BACKLOG-4263 PR-6
  installRemoved:
    "This computer's online copy was removed from another computer. Nothing from this computer is saved online until you save it again.",
  reclaim: "Save this computer's deals again",
  reclaimDone: "Saving this computer's deals again. If Keepr closes first, it finishes the next time Keepr opens.",
  parkedLocked: (n: number) =>
    n === 1
      ? "1 todo change from other devices or AI apps is waiting because its deal is locked. It applies if the deal is unlocked."
      : `${n} todo changes from other devices or AI apps are waiting because their deals are locked. They apply if the deals are unlocked.`,
  parkedOther: (n: number) =>
    `${n === 1 ? "1 todo change" : `${n} todo changes`} from other devices or AI apps could not be applied on this computer. Keepr tries again on its own.`,
  onlineOnly: (n: number) =>
    `Online only: ${n === 1 ? "1 deal" : `${n} deals`} you restored. AI apps can read them; they are not on this computer.`,
  removedTitle: "Removed in the last 30 days",
  removedRow: (address: string, when: string) => `${address} · deleted ${when}`,
  removedOnlineRow: (address: string, when: string) => `${address} · removed online ${when}`,
  noAddress: "Deal without an address",
  restore: "Restore",
  deleteForGood: "Delete for good",
  deleting: "Deleting…",
  deletingOffline: "Will finish deleting when Keepr is online.",
  rejectedRow: (address: string) => `${address} is marked Rejected on this computer. Choose Restore to Active on the deal to save it online again.`,
  removedFootnote:
    "Deleted deals are kept for 30 days, counted by this computer's clock. A backup made before a deal was deleted for good can still bring it back.",
  removedOnlineUnavailable: "Deals removed online show here when Keepr is online.",
  deleteForGoodTitle: "Delete this deal for good?",
  deleteForGoodConfirm:
    "It is erased now from Keepr Cloud and from this computer, with its todos and their history. This cannot be undone. A copy saved online before this computer was set up again is not erased.",
  restored: "Restored.",
  restoredSkipped: (n: number) =>
    `Restored. ${n === 1 ? "1 link" : `${n} links`} to emails or texts that no longer exist could not come back.`,
  restoredOtherDeal: "Restored. There is another deal at this address.",
  restoreRefused: {
    not_found: "Already restored.",
    not_owner: "This deal can't be restored from this account.",
    purge_owed: "This deal is being deleted for good.",
    deal_exists: "This deal is already back on this computer.",
    cloud_off: "Turn on Keepr Cloud to restore deals.",
    restore_failed: "This deal could not be restored on this computer. Try again.",
    signed_out: "Sign in to restore this deal.",
    archive_not_understood: "Update Keepr to restore this deal.",
    offline: "Restoring this deal needs an internet connection.",
    not_restorable: "This deal can no longer be restored.",
  } as Readonly<Record<string, string>>,
  deletedForGood: "Deleted for good.",
  // Delete for good, not_found: the deal was restored or already deleted (SR review 2, required 6)
  deleteNotListed: "This deal is no longer in this list.",
  restoredElsewhere: "This deal was restored elsewhere; it was not deleted.",
} as const;
