/**
 * BACKLOG-3925 — the Needs Review match kinds as the renderer shows them.
 *
 * ONE table drives the tabs, their counts and the pills. Adding a kind is one row
 * here plus one member of `ReviewMatchReason`. Row order is the TAB order (after
 * "All"), mock v5: Address, Contact, Folder / label.
 *
 * PRECEDENCE is a separate list (BACKLOG-3926): folder > address > contact, while the
 * Folder / label tab sits last. REVIEW_MATCH_PRECEDENCE below mirrors
 * REVIEW_MATCH_REASON_PRECEDENCE in electron/types/ipc/reviewMatchReason.ts, which the
 * renderer cannot value-import; reviewMatchTabs-3925.test.tsx pins the two equal.
 *
 * Wording is mock v3's text, approved by the founder on BACKLOG-3925 (2026-10-12).
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
  {
    // BACKLOG-3926, mock v5 (founder 2026-10-12): emerald pill; the folder / label
    // name itself is shown on the title row (ReviewMatchFolderNote).
    reason: "folder",
    tabLabel: "Folder / label",
    pillLabel: "Folder / label match",
    pillClass: "bg-emerald-100 text-emerald-700",
    emptyNoun: "folder / label match",
    infoLabel: "Folder / label match:",
    infoText: "you filed it in an Outlook folder or Gmail label named after this property.",
  },
];

/** Precedence, strongest first — mirror of REVIEW_MATCH_REASON_PRECEDENCE (pinned). */
export const REVIEW_MATCH_PRECEDENCE: readonly ReviewMatchReason[] = ["folder", "address", "contact"];

export type ReviewMatchFilter = "all" | ReviewMatchReason;

export function reviewMatchKind(reason: ReviewMatchReason): ReviewMatchKindView | undefined {
  return REVIEW_MATCH_KINDS.find((k) => k.reason === reason);
}

/**
 * The reason a THREAD shows (one card per thread): the strongest reason among its
 * items, by REVIEW_MATCH_PRECEDENCE (not the tab order).
 */
export function strongestReason(reasons: readonly ReviewMatchReason[]): ReviewMatchReason {
  for (const r of REVIEW_MATCH_PRECEDENCE) {
    if (reasons.includes(r)) return r;
  }
  return "contact";
}
