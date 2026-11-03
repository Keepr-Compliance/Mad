/**
 * ChecklistLinkChip — BACKLOG-3476.
 *
 * One evidence group under a checklist item: an attachment, an email
 * thread, or (BACKLOG-3968) one or more texts. The label comes from main
 * (`link.label`, "Text · <date>" for texts); nothing here derives it.
 *
 * BACKLOG-3968 U2 (the approved mock): a text chip reads "Text · <contact
 * name>" over "<date> · N texts" once the tab has looked the name up
 * (`textContactNames`); until then it shows main's label. Its View opens the
 * conversation (`onViewText`). The mock's snippet is not shown: no renderer
 * read of one message exists (recorded on BACKLOG-3968).
 *
 * Staleness (SR condition 7): a group is stale only when NO member is still on
 * the transaction. A thread with some emails unlinked keeps its View, which
 * shows the emails still there, and says how many left.
 *
 * View (BACKLOG-3476) opens the linked item where the user is — the
 * attachment preview, or the linked emails as one thread — instead of jumping
 * to another tab. A fully stale chip offers no View: the evidence is no longer
 * on the transaction, so there is nothing here to open.
 */
import React, { useState } from "react";
import type { ChecklistLink } from "../../../../../electron/types/checklist";
import type { UnifiedAttachment } from "../../hooks/useTransactionAllAttachments";
import type { EmailThread } from "../EmailThreadCard";
import { chipState, plural } from "../../utils/checklistLinks";
import { formatDate, formatFileSize } from "../../../../utils/formatUtils";

/** What a chip needs to open its evidence; the tab owns the modals. */
export interface ChecklistLinkViewer {
  onViewAttachment: (attachment: UnifiedAttachment) => void;
  downloadingAttachmentId: string | null;
  onViewThread: (link: ChecklistLink) => Promise<void>;
  /** BACKLOG-3968 U2: open a text group's conversation. Absent: no View. */
  onViewText?: (link: ChecklistLink) => void;
  /** BACKLOG-3968 U2: contact names for text chips, keyed by `messages.id`. */
  textContactNames?: ReadonlyMap<string, string>;
}

interface ChecklistLinkChipProps {
  link: ChecklistLink;
  /** This transaction's attachments, for size and date. */
  attachmentsById: ReadonlyMap<string, UnifiedAttachment>;
  /** This transaction's email threads, for participants (empty until loaded). */
  threads: EmailThread[];
  readOnly: boolean;
  /** Preview one attachment (downloads it first when only its metadata is here). */
  onViewAttachment: (attachment: UnifiedAttachment) => void;
  /** The attachment whose on-demand download is in flight, if any. */
  downloadingAttachmentId: string | null;
  /** Open this email link's live members as one thread. Resolves when it opened. */
  onViewThread: (link: ChecklistLink) => Promise<void>;
  onRemove: (linkId: string) => Promise<void>;
  /**
   * BACKLOG-3968: the contact name of a text member's conversation, keyed by
   * `messages.id`, when the tab knows it. Absent or no entry: no name shown.
   */
  textContactNames?: ReadonlyMap<string, string>;
  /** BACKLOG-3968 U2: open this text group's conversation. Absent: no View. */
  onViewText?: (link: ChecklistLink) => void;
}

/** "Text · October 12, 2026" → "October 12, 2026" (main's label for a text group). */
function textLabelDate(label: string): string {
  const m = /^Text · (.+)$/.exec(label);
  return m ? m[1] : "";
}

/** The noun a group's members are counted in (unchanged "email" for the other kinds). */
function memberNoun(kind: ChecklistLink["kind"]): string {
  return kind === "text" ? "text" : "email";
}

const FILE_ICON =
  "M7 21h10a2 2 0 002-2V9.414a1 1 0 00-.293-.707l-5.414-5.414A1 1 0 0012.586 3H7a2 2 0 00-2 2v14a2 2 0 002 2z";

export function ChecklistLinkChip({
  link,
  attachmentsById,
  threads,
  readOnly,
  onViewAttachment,
  downloadingAttachmentId,
  onViewThread,
  onRemove,
  textContactNames,
  onViewText,
}: ChecklistLinkChipProps): React.ReactElement {
  const [confirmingRemove, setConfirmingRemove] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [openingThread, setOpeningThread] = useState(false);
  const { stale, staleCount, viewTarget } = chipState(link);
  const attachment =
    link.kind === "attachment" && viewTarget?.attachmentId
      ? attachmentsById.get(viewTarget.attachmentId)
      : undefined;

  const textName =
    link.kind === "text" && viewTarget?.messageId ? textContactNames?.get(viewTarget.messageId) : undefined;
  const title = textName ? `Text · ${textName}` : link.label;
  let sub: string;
  if (stale) {
    sub = "No longer on this transaction";
  } else if (link.kind === "attachment") {
    sub = attachment
      ? `${formatFileSize(attachment.file_size_bytes)} · ${formatDate(attachment.source_date)}`
      : "";
  } else if (link.kind === "text") {
    sub = [textName ? textLabelDate(link.label) : "", plural(link.members.length, "text")]
      .filter(Boolean)
      .join(" · ");
  } else {
    const thread = threads.find((t) => t.emails.some((e) => e.id === viewTarget?.emailId));
    const who = thread ? thread.participants.slice(0, 2).join(", ") : "";
    sub = [who, plural(link.members.length, "email")].filter(Boolean).join(" · ");
  }

  const downloading = !!attachment && downloadingAttachmentId === attachment.id;
  const busy = downloading || openingThread;
  // An attachment chip can only open a row this transaction's list holds.
  // A text chip opens its conversation when the tab wired a viewer.
  const hasView = link.kind !== "text" || !!onViewText;
  const canView = !stale && (link.kind !== "attachment" || !!attachment);

  const view = async () => {
    if (link.kind === "text") {
      onViewText?.(link);
      return;
    }
    if (link.kind === "attachment") {
      if (attachment) onViewAttachment(attachment);
      return;
    }
    setOpeningThread(true);
    try {
      await onViewThread(link);
    } finally {
      setOpeningThread(false);
    }
  };

  const remove = async () => {
    setRemoving(true);
    try {
      await onRemove(link.id);
    } finally {
      setRemoving(false);
      setConfirmingRemove(false);
    }
  };

  return (
    <div
      className={`flex items-center gap-2.5 rounded-lg border px-2.5 py-2 ${
        stale ? "bg-gray-50 border-gray-200 opacity-70" : "bg-white border-gray-200 hover:border-gray-300"
      }`}
      data-testid={`checklist-link-${link.id}`}
      data-stale={stale ? "true" : "false"}
    >
      {link.kind === "attachment" ? (
        <span className="w-8 h-8 rounded-lg inline-flex items-center justify-center flex-shrink-0 text-red-500 bg-red-50">
          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d={FILE_ICON} />
          </svg>
        </span>
      ) : link.kind === "text" ? (
        <span
          className="w-8 h-8 rounded-lg inline-flex items-center justify-center flex-shrink-0 text-[10px] font-bold text-success-700 bg-success-50"
          aria-hidden="true"
          data-testid="checklist-link-text-icon"
        >
          TXT
        </span>
      ) : (
        <span className="w-8 h-8 rounded-full inline-flex items-center justify-center flex-shrink-0 font-semibold text-sm bg-primary-50 text-primary-700">
          {(link.label.trim()[0] ?? "?").toUpperCase()}
        </span>
      )}
      <span className="flex-1 min-w-0">
        <span className="block text-sm font-medium text-gray-900 truncate">{title}</span>
        {sub && <span className="block text-xs text-gray-400 truncate">{sub}</span>}
        {!stale && staleCount > 0 && (
          <span className="block text-xs text-gray-400 truncate" data-testid="checklist-link-partly-stale">
            {staleCount} of {plural(link.members.length, memberNoun(link.kind))} no longer on this transaction
          </span>
        )}
      </span>
      {link.kind === "email" && (
        <span className="inline-flex items-center px-1.5 py-0.5 rounded-full text-[10px] font-medium bg-indigo-50 text-indigo-600 flex-shrink-0">
          Thread
        </span>
      )}
      {!stale && hasView && (
        <button
          type="button"
          onClick={() => void view()}
          disabled={!canView || busy}
          aria-busy={busy || undefined}
          aria-label={`View ${title}`}
          className="text-xs font-medium text-primary-700 hover:text-primary-800 whitespace-nowrap flex-shrink-0 disabled:opacity-60 disabled:cursor-wait"
          data-testid="checklist-link-view"
        >
          {busy ? "Opening…" : "View"}
        </button>
      )}
      {!readOnly && !confirmingRemove && (
        <button
          type="button"
          onClick={() => setConfirmingRemove(true)}
          aria-label={`Remove link ${title}`}
          className="text-gray-400 hover:text-gray-600 flex-shrink-0 p-1"
          data-testid="checklist-link-remove"
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      )}
      {!readOnly && confirmingRemove && (
        <span className="flex items-center gap-2 flex-shrink-0 text-xs">
          <span className="text-gray-500">Remove link?</span>
          <button
            type="button"
            onClick={() => void remove()}
            disabled={removing}
            className="font-medium text-red-600 hover:text-red-800"
            data-testid="checklist-link-remove-confirm"
          >
            Remove
          </button>
          <button
            type="button"
            onClick={() => setConfirmingRemove(false)}
            disabled={removing}
            className="font-medium text-gray-600 hover:text-gray-800"
          >
            Cancel
          </button>
        </span>
      )}
    </div>
  );
}

export default ChecklistLinkChip;
