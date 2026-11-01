/**
 * BACKLOG-3764 — checklist evidence a submission would not send, found BEFORE
 * anything is sent.
 *
 * A checklist group's members are matched to the uploaded rows by local id
 * (`submissionChecklistSnapshot.ts`). A member that is not uploaded used to be
 * dropped by the cloud copy with nothing but an info log: the agent saw a chip
 * on the item, the broker saw nothing. Founder decision (pm_comments on
 * BACKLOG-3764): never drop a link silently.
 *
 * Every member of every group is compared with what this submission sends
 * (the gathered emails and the sendable attachments). Each group with a member
 * that is not sent becomes ONE line for the submit pre-flight:
 *
 *   outside_audit_dates  a missing member is dated outside the deal's audit
 *                        dates and the agent never said to include the group.
 *                        The pre-flight asks; "Include it" sets the flag
 *                        (`checklists:include-link-outside-dates`). Leaving
 *                        it out does not set anything, so the question comes
 *                        back at the next submit (unlike "Don't link" at link
 *                        time, which makes no group at all).
 *   not_included         anything else (a hidden or duplicate text's file, a
 *                        file with no local copy, a file the pre-flight cannot
 *                        send, evidence no longer on the deal). A yes cannot
 *                        change these, so the line only says so.
 *
 * The same `sent` sets decide which local ids the snapshot sends, so the
 * pre-flight list and what the broker is missing cannot disagree.
 *
 * BACKLOG-3968 — texts. A text member is sent when its message is among the
 * texts this submission uploads (`sentTextIds` = the gathered, date-filtered
 * messages — not the wider export selection). There is no "Include it" for a
 * text: the message upload has no outside-the-dates arm, so a text outside the
 * dates is `not_included` and the dates question is never asked for it. While
 * `TEXT_LINKS_HELD_UNTIL_CLOUD_MIGRATION` holds, EVERY text member is
 * `not_included` (the cloud copy cannot take a text link yet).
 */

import { createHash } from "crypto";

import { outsideAuditDates } from "./db/checklistDbService";
import { TEXT_LINKS_HELD_UNTIL_CLOUD_MIGRATION } from "./checklistTextLinkHold";
import type {
  ChecklistsForTransaction,
  ChecklistLinkKind,
  ChecklistLinkMember,
} from "../types/checklist";
import type { NotIncludedItem } from "./submissionPreflight";

export type ChecklistLinkGapReason = "outside_audit_dates" | "not_included";

/** Why a `not_included` member is not sent, as far as the submit knows. */
export type ChecklistLinkGapDetail =
  /** The evidence was unlinked from the deal after it was linked. */
  | "not_on_transaction"
  /** The file is in the pre-flight's own "can't be sent" list. */
  | "cannot_be_sent"
  /** A file whose message is not part of this submission. */
  | "message_not_sent"
  /** An email, or a text (BACKLOG-3968), that is not part of this submission. */
  | "not_sent";

export interface ChecklistLinkGap {
  /**
   * Stable for the same group, reason and missing members, and different
   * otherwise: an answer given for one list is never taken for another.
   */
  key: string;
  linkId: string;
  itemTitle: string;
  label: string;
  kind: ChecklistLinkKind;
  reason: ChecklistLinkGapReason;
  detail: ChecklistLinkGapDetail | null;
  /** Local ids of the members that would not be sent. */
  missingIds: string[];
  /** outside_audit_dates: the earliest date outside the dates. */
  sentAt: string | null;
  /** The deal's dates as stored, for the question's wording. */
  auditStart: string | null;
  auditEnd: string | null;
}

export interface ChecklistLinkGapInput {
  checklists: ChecklistsForTransaction;
  sentEmailIds: ReadonlySet<string>;
  sentAttachmentIds: ReadonlySet<string>;
  /** BACKLOG-3968: ids of the texts this submission uploads (the gathered messages). */
  sentTextIds: ReadonlySet<string>;
  /** The pre-flight's own list, to say which files are in it. */
  notIncluded: readonly NotIncludedItem[];
  startedAt: string | null;
  closedAt: string | null;
}

/** The local id a member is matched by, for its link's kind. */
export function memberLocalId(kind: ChecklistLinkKind, member: ChecklistLinkMember): string | null {
  if (kind === "email") return member.emailId;
  if (kind === "text") return member.messageId;
  return member.attachmentId;
}

export function findChecklistLinkGaps(input: ChecklistLinkGapInput): ChecklistLinkGap[] {
  const cannotBeSent = new Set(
    input.notIncluded
      .map((item) => item.localAttachmentId)
      .filter((id): id is string => typeof id === "string")
  );
  const gaps: ChecklistLinkGap[] = [];
  for (const detail of input.checklists.checklists) {
    for (const item of detail.items) {
      for (const link of detail.linksByItemId[item.id] ?? []) {
        const kind = link.kind;
        const sent =
          kind === "email"
            ? input.sentEmailIds
            : kind === "text"
              ? input.sentTextIds
              : input.sentAttachmentIds;
        const held = kind === "text" && TEXT_LINKS_HELD_UNTIL_CLOUD_MIGRATION;
        const missing = link.members.filter((member) => {
          const id = memberLocalId(kind, member);
          if (!id) return false;
          return held || !sent.has(id);
        });
        if (missing.length === 0) continue;
        const missingIds = missing.map((member) => memberLocalId(kind, member) as string).sort();

        // A text is never asked about the dates (no "Include it" arm exists
        // for messages), so it is not_included whatever its date.
        const outside =
          kind === "text" || link.includeOutsideDates
            ? []
            : outsideAuditDates(
                kind,
                missing
                  .filter((member) => member.inTransaction)
                  .map((member) => memberLocalId(kind, member) as string),
                input.startedAt,
                input.closedAt
              );
        const reason: ChecklistLinkGapReason =
          outside.length > 0 ? "outside_audit_dates" : "not_included";

        let gapDetail: ChecklistLinkGapDetail | null = null;
        if (reason === "not_included") {
          if (missing.some((member) => !member.inTransaction)) gapDetail = "not_on_transaction";
          else if (kind === "email" || kind === "text") gapDetail = "not_sent";
          else if (missingIds.some((id) => cannotBeSent.has(id))) gapDetail = "cannot_be_sent";
          else gapDetail = "message_not_sent";
        }

        gaps.push({
          // Hashed: a thread can hold many emails, and the submit handler
          // refuses keys longer than 300 characters.
          key: `link:${link.id}:${reason}:${createHash("sha256").update(missingIds.join(",")).digest("hex").slice(0, 16)}`,
          linkId: link.id,
          itemTitle: item.title,
          label: link.label,
          kind: link.kind,
          reason,
          detail: gapDetail,
          missingIds,
          sentAt: outside[0]?.sentAt ?? null,
          auditStart: input.startedAt,
          auditEnd: input.closedAt,
        });
      }
    }
  }
  return gaps;
}

/** `linkId:localId` for every member a set of gaps covers. */
export function gapMemberKeys(gaps: readonly ChecklistLinkGap[]): Set<string> {
  const keys = new Set<string>();
  for (const gap of gaps) for (const id of gap.missingIds) keys.add(`${gap.linkId}:${id}`);
  return keys;
}
