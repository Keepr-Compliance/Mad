/**
 * Bundled signal terms — BACKLOG-4257 (M3) v1.
 *
 * Terms ship in the app for v1 and move to the published rule set at M4.
 * Bump SIGNAL_TERMS_VERSION on any change here so a measurement can say which
 * terms it ran with. All terms are lowercase; matching is whole-word
 * (see wholeWord.ts), never substring.
 */
import type { FilenameClass } from "./types";

export const SIGNAL_TERMS_VERSION = 1 as const;

export type StageName = "offer" | "counter" | "underContract" | "inspection" | "appraisal" | "closing";

export const STAGE_TERMS: Readonly<Record<StageName, readonly string[]>> = {
  offer: ["offer", "offers", "offer price", "purchase offer", "multiple offers", "highest and best"],
  counter: ["counter", "countered", "counteroffer", "counter offer", "counter-offer", "counter proposal"],
  underContract: [
    "under contract",
    "mutual acceptance",
    "mutually accepted",
    "accepted offer",
    "offer accepted",
    "fully executed",
    "pending sale",
  ],
  inspection: ["inspection", "inspections", "inspector", "inspection report", "inspection response"],
  appraisal: ["appraisal", "appraised", "appraiser", "appraisal report"],
  closing: [
    "closing",
    "closing date",
    "close of escrow",
    "closing disclosure",
    "settlement statement",
    "escrow",
    "closed escrow",
  ],
};

/**
 * RFC 3676 signature separator ("-- ") as a trimmed line, plus the bare
 * double dash many clients emit.
 */
export const SIGNATURE_SEPARATOR_LINES: readonly string[] = ["--", "-- "];

/** A whole line that is only a sign-off (optionally followed by , ! or .). */
export const SIGN_OFF_LINES: readonly string[] = [
  "best",
  "best regards",
  "regards",
  "kind regards",
  "warm regards",
  "warmly",
  "thanks",
  "thank you",
  "many thanks",
  "sincerely",
  "cheers",
  "respectfully",
  "all the best",
];

/** Phrases that mark bulk-mail footers. Whole-word. */
export const FOOTER_CUES: readonly string[] = [
  "unsubscribe",
  "manage preferences",
  "email preferences",
  "update your preferences",
  "view in browser",
  "view this email in your browser",
  "privacy policy",
  "all rights reserved",
  "you are receiving this",
  "you received this email",
  "this email was sent to",
  "opt out",
  "©",
  "copyright",
];

/**
 * Filename classes, strongest first. A filename is lowercased and split on
 * non-alphanumerics; a term matches whole-word against that token string.
 */
export const FILENAME_CLASSES: ReadonlyArray<readonly [Exclude<FilenameClass, "other" | "none">, readonly string[]]> = [
  ["purchaseAgreement", ["purchase agreement", "purchase and sale", "psa", "rpa", "sales contract", "purchase contract"]],
  ["counteroffer", ["counteroffer", "counter offer", "counter"]],
  ["addendum", ["addendum", "amendment", "addenda"]],
  ["inspection", ["inspection", "inspections"]],
  ["appraisal", ["appraisal"]],
  ["closing", ["closing disclosure", "settlement statement", "alta", "hud"]],
  ["disclosure", ["disclosure", "disclosures", "seller disclosure"]],
  ["listing", ["listing agreement", "listing", "mls"]],
];

/** Lines at the top of the own text that count as bodyTop: max(MIN, ceil(n * FRACTION)). */
export const BODY_TOP_MIN_LINES = 3;
export const BODY_TOP_FRACTION = 0.25;

/** The positional footer: the last max(MIN, ceil(n * FRACTION)) lines, only when n >= FOOTER_MIN_BODY_LINES. */
export const FOOTER_MIN_LINES = 3;
export const FOOTER_FRACTION = 0.2;
export const FOOTER_MIN_BODY_LINES = 8;

/** An address line within this many lines of a footer-cue line is "near" it. */
export const FOOTER_CUE_WINDOW = 3;
