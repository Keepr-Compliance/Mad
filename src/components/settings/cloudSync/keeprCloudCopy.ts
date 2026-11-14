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
    "Keepr will upload your deal details, the people on each deal, your checklists and todos, and your contact list (names, companies, email addresses and phone numbers of the people you saved) to Keepr Cloud as you work, before you submit. " +
    "Linked emails, texts and files are not uploaded yet. Your online copy belongs to your account. Your brokerage cannot see it. " +
    "AI apps you connect, like Claude or ChatGPT, can read it, and what they read is sent to that app's company. " +
    "When a later version also uploads linked emails, texts or files, or Gmail email, Keepr asks again. Saving pauses until you agree to the new notice. " +
    "Turning this off deletes the online copy from all your computers.",
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
  saveThisComputer: "Save this computer's deals",
  notNow: "Not now",
  statusSaved: (ago: string) => `Saved online · last saved ${ago}`,
  statusSaving: (n: number) => (n === 1 ? "Saving 1 deal" : `Saving ${n} deals`),
  statusOn: "Saved online",
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
  turnOffConfirmButton: "Turn off and delete",
  turnOffDone: "Keepr Cloud is off. Your online copy was deleted and AI apps were disconnected.",
  turnOffOffline: "Turning off. Your online copy will be deleted when Keepr can reach the internet.",
  forget: "Forget saving on this computer for the other Keepr Cloud",
  forgetConfirm: "This computer stops tracking what it saved to the other Keepr Cloud. Nothing online is deleted.",
  forgetButton: "Forget",
  aiAppsTitle: "AI apps",
  aiAppsDescription: "Connect Keepr to Claude or ChatGPT to ask about your deals. Connections are managed on the Keepr website.",
  manageAiApps: "Manage AI apps",
  actionFailed: "That did not work. Try again.",
} as const;
