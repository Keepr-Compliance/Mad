/**
 * Checklist block for the combined PDF's index page — BACKLOG-3767.
 *
 * Pure: no I/O. The export handler reads the transaction's LOCAL checklists and
 * the evidence rows they point at; the combined renderer supplies where each
 * included email/text landed in the document. This file decides what each
 * linked member prints and renders the HTML.
 *
 * Per member, in this order (SR plan review 3767, change 3 — by elimination,
 * never a second date comparison):
 *   1. an attachment on a text hidden from this transaction's export → prints
 *      nothing at all, not even its name
 *   2. no longer part of the transaction → counted only, never named
 *   3. its kind is excluded by the content selection → "Not in this export"
 *   4. not among the communications this export includes → "Not in this
 *      export — outside the audit dates"
 *   5. otherwise it is in the export → a "View →" link to its section (full
 *      mode only; the Summary PDF carries no links at all)
 *
 * A link's stored label is the FIRST member's subject or filename. It is
 * printed only when every member of the link passed steps 1 and 2; otherwise
 * each surviving member is named on its own, so the label can never name a
 * member that steps 1 or 2 removed.
 */

import type { Communication } from "../../types/models";
import type {
  ChecklistAttachmentTarget,
  ChecklistDetail,
  ChecklistLink,
  ChecklistLinkMember,
} from "../../types/checklist";

export type { ChecklistAttachmentTarget };
import { escapeHtml } from "../../utils/exportUtils";
import { isEmailMessage, isTextMessage } from "../../utils/channelHelpers";

/** Everything the block needs that the main process reads. Absent = toggle off. */
export interface ChecklistExportData {
  checklists: ChecklistDetail[];
  /** Keyed by attachment id. */
  attachmentTargets: Record<string, ChecklistAttachmentTarget>;
  /** Keyed by email id: the email's subject, for naming one member on its own. */
  emailSubjects: Record<string, string | null>;
  /** The plan's content selection. */
  includeEmails: boolean;
  includeTexts: boolean;
}

/** Where the included communications landed in the combined document. */
export interface ChecklistSectionIndex {
  /** email id → section id (full mode only). */
  emailSection: Map<string, string>;
  /** text message id → section id (full mode only). */
  textSectionById: Map<string, string>;
  /** text external id → section id (full mode only). */
  textSectionByExternalId: Map<string, string>;
}

export const NOT_IN_EXPORT_TEXT = "Not in this export";
export const OUTSIDE_DATES_TEXT = "Not in this export — outside the audit dates";
export const CHECKLIST_HEADING = "Checklist";

export function staleCountText(count: number): string {
  return count === 1
    ? "1 linked item is no longer part of this transaction"
    : `${count} linked items are no longer part of this transaction`;
}

type MemberStatus =
  | { kind: "omit" }
  | { kind: "stale" }
  | { kind: "excluded"; name: string }
  | { kind: "outside"; name: string }
  | { kind: "included"; name: string; target: string | null };

/** The ids of what this export includes, for step 4. */
interface IncludedSets {
  emailIds: Set<string>;
  textIds: Set<string>;
  textExternalIds: Set<string>;
}

export function buildIncludedSets(communications: Communication[]): IncludedSets {
  const emailIds = new Set<string>();
  const textIds = new Set<string>();
  const textExternalIds = new Set<string>();
  for (const comm of communications) {
    if (isEmailMessage(comm)) {
      if (comm.email_id) emailIds.add(comm.email_id);
      if (comm.id) emailIds.add(comm.id);
    } else if (isTextMessage(comm)) {
      if (comm.id) textIds.add(comm.id);
      if (comm.message_id) textIds.add(comm.message_id);
      const ext = (comm as { external_id?: string | null }).external_id;
      if (ext) textExternalIds.add(ext);
    }
  }
  return { emailIds, textIds, textExternalIds };
}

function classifyMember(
  member: ChecklistLinkMember,
  data: ChecklistExportData,
  included: IncludedSets,
  sections: ChecklistSectionIndex | null,
): MemberStatus {
  if (member.emailId) {
    if (!member.inTransaction) return { kind: "stale" };
    const name = data.emailSubjects[member.emailId] || "(no subject)";
    if (!data.includeEmails) return { kind: "excluded", name };
    if (!included.emailIds.has(member.emailId)) return { kind: "outside", name };
    return { kind: "included", name, target: sections?.emailSection.get(member.emailId) ?? null };
  }

  const target = member.attachmentId ? data.attachmentTargets[member.attachmentId] : undefined;
  // No row to judge it by: say nothing rather than guess.
  if (!target) return { kind: "omit" };
  // 1. hidden first, before anything that would print a name.
  if (target.hidden) return { kind: "omit" };
  // 2. no longer in the transaction: counted, never named.
  if (!member.inTransaction) return { kind: "stale" };
  const name = target.filename || "(unnamed file)";
  if (target.emailId) {
    if (!data.includeEmails) return { kind: "excluded", name };
    if (!included.emailIds.has(target.emailId)) return { kind: "outside", name };
    return { kind: "included", name, target: sections?.emailSection.get(target.emailId) ?? null };
  }
  if (!data.includeTexts) return { kind: "excluded", name };
  // Same arms as GET_CHECKLIST_LINK_MEMBERS_SQL: the message id, then the
  // Apple guid when the row belongs to another copy of the message.
  const externals = [target.externalMessageId, target.messageExternalId].filter(
    (v): v is string => !!v,
  );
  if (target.messageId && included.textIds.has(target.messageId)) {
    return {
      kind: "included",
      name,
      target: sections?.textSectionById.get(target.messageId) ?? null,
    };
  }
  const ext = externals.find((e) => included.textExternalIds.has(e));
  if (ext) {
    return { kind: "included", name, target: sections?.textSectionByExternalId.get(ext) ?? null };
  }
  return { kind: "outside", name };
}

interface RenderedLink {
  html: string;
  stale: number;
}

function viewLinks(targets: (string | null)[], linksAllowed: boolean): string {
  if (!linksAllowed) return "";
  const distinct = Array.from(new Set(targets.filter((t): t is string => !!t)));
  return distinct
    .map(
      (t) =>
        `<a class="view-full-link" href="#${escapeHtml(t)}">View &rarr;</a>`,
    )
    .join("");
}

function reasonHtml(text: string): string {
  return `<span style="color:#6b7280;font-size:12px;margin-left:8px;">${escapeHtml(text)}</span>`;
}

function memberLine(name: string, status: MemberStatus[], linksAllowed: boolean): string {
  const targets = status.flatMap((s) => (s.kind === "included" ? [s.target] : []));
  const reasons: string[] = [];
  // Reasons print in both modes; only the links are full-mode-only.
  if (status.some((s) => s.kind === "excluded")) reasons.push(NOT_IN_EXPORT_TEXT);
  if (status.some((s) => s.kind === "outside")) reasons.push(OUTSIDE_DATES_TEXT);
  return (
    `<div class="cl-evidence" style="font-size:12px;color:#374151;margin-top:4px;">` +
    `<span>${escapeHtml(name)}</span>` +
    viewLinks(targets, linksAllowed) +
    reasons.map(reasonHtml).join("") +
    `</div>`
  );
}

function renderLink(
  link: ChecklistLink,
  data: ChecklistExportData,
  included: IncludedSets,
  sections: ChecklistSectionIndex | null,
  linksAllowed: boolean,
): RenderedLink {
  const statuses = link.members.map((m) => classifyMember(m, data, included, sections));
  const stale = statuses.filter((s) => s.kind === "stale").length;
  const live = statuses.filter(
    (s): s is Exclude<MemberStatus, { kind: "omit" } | { kind: "stale" }> =>
      s.kind !== "omit" && s.kind !== "stale",
  );
  if (live.length === 0) return { html: "", stale };
  const allClean = live.length === statuses.length;
  if (allClean) {
    return { html: memberLine(link.label, live, linksAllowed), stale };
  }
  // A member was removed: name each survivor on its own, never the group label.
  return {
    html: live.map((s) => memberLine(s.name, [s], linksAllowed)).join(""),
    stale,
  };
}

/**
 * The checklist block, as one `<div class="section">` for the index page.
 * Empty string when there is nothing to show.
 *
 * `sections` is null in summary mode; `linksAllowed` is false there too, so
 * the block adds no href, no reason line and no anchor id.
 */
export function generateChecklistIndexHTML(
  data: ChecklistExportData,
  includedCommunications: Communication[],
  sections: ChecklistSectionIndex | null,
  summaryOnly: boolean,
): string {
  if (data.checklists.length === 0) return "";
  const linksAllowed = !summaryOnly;
  const included = buildIncludedSets(includedCommunications);

  const blocks = data.checklists.map((detail) => {
    const rows = detail.items.map((item) => {
      const links = detail.linksByItemId[item.id] ?? [];
      const rendered = links.map((l) => renderLink(l, data, included, sections, linksAllowed));
      const stale = rendered.reduce((sum, r) => sum + r.stale, 0);
      const status = item.isChecked ? "Complete" : "Not complete";
      const statusColor = item.isChecked ? "#047857" : "#b45309";
      return (
        `<div class="cl-item" style="padding:10px 12px;border-bottom:1px solid #e5e7eb;page-break-inside:avoid;">` +
        `<div style="font-size:13px;">` +
        `<span style="font-weight:600;color:${statusColor};margin-right:8px;">${status}</span>` +
        (item.isRequired
          ? `<span style="font-size:11px;color:#6b7280;margin-right:8px;">Required</span>`
          : "") +
        `<span style="color:#111827;">${escapeHtml(item.title)}</span>` +
        `</div>` +
        (item.note
          ? `<div class="cl-note" style="font-size:12px;color:#374151;white-space:pre-wrap;margin-top:4px;">${escapeHtml(item.note)}</div>`
          : "") +
        rendered.map((r) => r.html).join("") +
        (stale > 0
          ? `<div style="font-size:12px;color:#6b7280;margin-top:4px;">${escapeHtml(staleCountText(stale))}</div>`
          : "") +
        `</div>`
      );
    });
    const progress =
      detail.requiredTotal > 0
        ? ` (${detail.requiredDone} of ${detail.requiredTotal} required complete)`
        : "";
    return (
      `<div class="section cl-checklist">` +
      `<h3>${CHECKLIST_HEADING}: ${escapeHtml(detail.checklist.templateName)}${progress}</h3>` +
      `<div style="border:1px solid #e5e7eb;border-radius:8px;">${rows.join("")}</div>` +
      `</div>`
    );
  });

  return blocks.join("\n");
}

/**
 * Place the block on the index page after the indexes, before the footer.
 * The footer is always rendered; the Text Threads Index is not.
 */
export function insertChecklistBlock(indexHtml: string, block: string): string {
  if (!block) return indexHtml;
  const marker = `<div class="footer">`;
  const at = indexHtml.lastIndexOf(marker);
  if (at < 0) {
    const bodyEnd = indexHtml.lastIndexOf("</body>");
    if (bodyEnd < 0) return indexHtml + block;
    return indexHtml.slice(0, bodyEnd) + block + indexHtml.slice(bodyEnd);
  }
  return indexHtml.slice(0, at) + block + "\n  " + indexHtml.slice(at);
}
