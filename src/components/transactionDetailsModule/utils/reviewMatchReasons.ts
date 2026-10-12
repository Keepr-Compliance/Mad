/**
 * BACKLOG-3925 — the Needs Review match kinds as the renderer shows them.
 *
 * ONE table drives the tabs, their counts and the pills. Adding a kind (BACKLOG-3926,
 * "folder") is one row here plus one member of `ReviewMatchReason`; nothing else in
 * the section is structured around the two kinds that exist today. Row order is the
 * tab order (after "All") AND the precedence order (folder > address > contact) —
 * a mirror of REVIEW_MATCH_REASON_PRECEDENCE in electron/types/ipc/reviewMatchReason.ts,
 * which the renderer cannot value-import; reviewMatchReasons.parity.test.ts pins the
 * two lists equal.
 *
 * Wording is DRAFT (founder open question on BACKLOG-3925) — built with mock v3's text.
 * Pill classes are mock v3's: blue = TransactionToolbar.tsx's blue pill, purple for
 * contact.
 */
import type { ReviewMatchReason } from "../../../../electron/types/ipc/reviewMatchReason";

export interface ReviewMatchKindView {
  reason: ReviewMatchReason;
  /** Tab label. */
  tabLabel: string;
  /** Pill text shown after the subject, All tab only. */
  pillLabel: string;
  /** Pill colour classes. */
  pillClass: string;
  /** "No <emptyNoun> emails need review" — the empty-tab title. */
  emptyNoun: string;
  /** The (i) popover line: bold label, then the explanation. */
  infoLabel: string;
  infoText: string;
}

export const REVIEW_MATCH_KINDS: readonly ReviewMatchKindView[] = [
  {
    reason: "address",
    tabLabel: "Address match",
    pillLabel: "Address matched",
    pillClass: "bg-blue-100 text-blue-700",
    emptyNoun: "address-match",
    infoLabel: "Address match:",
    infoText:
      "the email mentions this property's street number and name but isn't from a contact on the deal.",
  },
  {
    reason: "contact",
    tabLabel: "Contact match",
    pillLabel: "Contact match · no address",
    pillClass: "bg-purple-100 text-purple-700",
    emptyNoun: "contact-match",
    infoLabel: "Contact match:",
    infoText: "it's from a contact on the deal but doesn't mention the property address.",
  },
];

export type ReviewMatchFilter = "all" | ReviewMatchReason;

export function reviewMatchKind(reason: ReviewMatchReason): ReviewMatchKindView | undefined {
  return REVIEW_MATCH_KINDS.find((k) => k.reason === reason);
}

/**
 * The reason a THREAD shows (one card per thread): the strongest reason among its
 * items, by the table order above.
 */
export function strongestReason(reasons: readonly ReviewMatchReason[]): ReviewMatchReason {
  for (const k of REVIEW_MATCH_KINDS) {
    if (reasons.includes(k.reason)) return k.reason;
  }
  return "contact";
}
