/**
 * BACKLOG-3363: the one place the Windows-on-ARM "unsupported" copy lives.
 * Every screen that shows it imports from here — edit the words here only.
 *
 * Heading: the founder's words, verbatim.
 * Body: DRAFT awaiting founder sign-off (pm_comments on BACKLOG-3363).
 *
 * (The main process's install refusal returns the heading as its error string
 * in electron/services/appleDriverService.ts; no screen shows that string.)
 */
export const WINDOWS_ARM64_UNSUPPORTED_HEADING =
  "iPhone USB sync isn't supported on this PC";

export const WINDOWS_ARM64_UNSUPPORTED_BODY =
  "This PC has an ARM-based processor (such as Snapdragon). Apple's iPhone USB driver doesn't work on ARM-based Windows PCs, so Keepr can't read an iPhone connected to this computer. Email and everything else in Keepr work normally.";
