/**
 * ChecklistLinkPicker — BACKLOG-3476, mock state 3.
 *
 * Link attachments and email threads that are ALREADY on this transaction to
 * one checklist item. The shell is AttachEmailsModal's (gradient header,
 * search, footer count, Cancel + primary).
 *
 * What it offers, and why only that:
 * - Attachments: this transaction's unified list, minus the legacy rows main
 *   would refuse (`linkableAttachments`).
 * - Email threads: the Emails tab's "Linked emails" list and nothing else
 *   (`linkableThreads`, SR condition 12). Emails waiting in Needs review are
 *   not evidence yet.
 * - No texts: texts are not a link target (out of scope).
 *
 * The emails load through `ensureEmailsLoaded`, which is SILENT (SR condition
 * 1). The loud loader flips the shared `loading` flag, and on a transaction
 * with no contacts that replaces the whole details modal with a spinner —
 * unmounting this picker and losing the selection.
 *
 * Main decides membership, all-or-nothing per group. A refused group stays
 * selectable-no-more and is marked "No longer on this transaction"; the rest
 * are kept.
 */
import React, { useEffect, useMemo, useState } from "react";
import { ResponsiveModal } from "../../../common/ResponsiveModal";
import { AttachmentPreviewModal } from "../modals/AttachmentPreviewModal";
import { EmailThreadViewModal } from "../modals/EmailThreadViewModal";
import type { EmailThread } from "../EmailThreadCard";
import type { UnifiedAttachment } from "../../hooks/useTransactionAllAttachments";
import type {
  ChecklistLinkOutcome,
  ChecklistLinkRequest,
} from "../../hooks/useTransactionChecklist";
import type { ChecklistItem, ChecklistLink } from "../../../../../electron/types/checklist";
import type { Communication } from "../../types";
import { linkableAttachments, linkableThreads, plural } from "../../utils/checklistLinks";
import { formatDate, formatFileSize } from "../../../../utils/formatUtils";
import logger from "../../../../utils/logger";

interface ChecklistLinkPickerProps {
  item: ChecklistItem;
  templateName: string;
  /** This item's existing groups — their targets show as already linked. */
  existingLinks: ChecklistLink[];
  attachments: UnifiedAttachment[];
  attachmentsLoading: boolean;
  emailCommunications: Communication[];
  /** Load the transaction's emails silently if the Emails tab has not yet. */
  ensureEmailsLoaded: () => Promise<void>;
  onLink: (requests: ChecklistLinkRequest[]) => Promise<ChecklistLinkOutcome[]>;
  /** Refetch attachments and emails after main refused something. */
  onRefreshTargets: () => void;
  onClose: () => void;
  onShowSuccess: (message: string) => void;
  onShowError: (message: string) => void;
  userEmail?: string;
  nameMap?: ReadonlyMap<string, string>;
}

type RowKey = string;
const attKey = (id: string): RowKey => `a:${id}`;
const threadKey = (id: string): RowKey => `t:${id}`;

interface PreviewAttachment {
  id: string;
  filename: string;
  mime_type: string | null;
  file_size_bytes: number | null;
  storage_path: string | null;
}

export function ChecklistLinkPicker({
  item,
  templateName,
  existingLinks,
  attachments,
  attachmentsLoading,
  emailCommunications,
  ensureEmailsLoaded,
  onLink,
  onRefreshTargets,
  onClose,
  onShowSuccess,
  onShowError,
  userEmail,
  nameMap,
}: ChecklistLinkPickerProps): React.ReactElement {
  const [emailsLoading, setEmailsLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<Set<RowKey>>(new Set());
  const [refused, setRefused] = useState<Set<RowKey>>(new Set());
  const [linking, setLinking] = useState(false);
  const [previewing, setPreviewing] = useState<PreviewAttachment | null>(null);
  const [viewingThread, setViewingThread] = useState<EmailThread | null>(null);

  useEffect(() => {
    let cancelled = false;
    void ensureEmailsLoaded().finally(() => {
      if (!cancelled) setEmailsLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [ensureEmailsLoaded]);

  const offeredAttachments = useMemo(() => linkableAttachments(attachments), [attachments]);
  const offeredThreads = useMemo(() => linkableThreads(emailCommunications), [emailCommunications]);

  const linkedAttachmentIds = useMemo(() => {
    const s = new Set<string>();
    for (const l of existingLinks) {
      if (l.kind !== "attachment") continue;
      for (const m of l.members) if (m.attachmentId) s.add(m.attachmentId);
    }
    return s;
  }, [existingLinks]);
  const linkedEmailIds = useMemo(() => {
    const s = new Set<string>();
    for (const l of existingLinks) {
      if (l.kind !== "email") continue;
      for (const m of l.members) if (m.emailId) s.add(m.emailId);
    }
    return s;
  }, [existingLinks]);

  const q = search.trim().toLowerCase();
  const visibleAttachments = useMemo(
    () => offeredAttachments.filter((a) => !q || a.filename.toLowerCase().includes(q)),
    [offeredAttachments, q],
  );
  const visibleThreads = useMemo(
    () =>
      offeredThreads.filter(
        (t) =>
          !q ||
          t.subject.toLowerCase().includes(q) ||
          t.participants.some((p) => p.toLowerCase().includes(q)),
      ),
    [offeredThreads, q],
  );

  const attachmentDisabled = (a: UnifiedAttachment) =>
    linkedAttachmentIds.has(a.id) || refused.has(attKey(a.id));
  const threadLinked = (t: EmailThread) => t.emails.every((e) => linkedEmailIds.has(e.id));
  const threadDisabled = (t: EmailThread) => threadLinked(t) || refused.has(threadKey(t.id));

  const toggle = (key: RowKey) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  /** Select all enabled, visible rows of one section; again to clear them. */
  const selectAll = (keys: RowKey[]) =>
    setSelected((prev) => {
      const next = new Set(prev);
      const allOn = keys.length > 0 && keys.every((k) => next.has(k));
      for (const k of keys) {
        if (allOn) next.delete(k);
        else next.add(k);
      }
      return next;
    });

  const enabledAttachmentKeys = visibleAttachments.filter((a) => !attachmentDisabled(a)).map((a) => attKey(a.id));
  const enabledThreadKeys = visibleThreads.filter((t) => !threadDisabled(t)).map((t) => threadKey(t.id));

  const handleLink = async () => {
    if (selected.size === 0 || linking) return;
    const requests: Array<{ key: RowKey; request: ChecklistLinkRequest }> = [];
    for (const a of offeredAttachments) {
      if (selected.has(attKey(a.id))) requests.push({ key: attKey(a.id), request: { kind: "attachment", targetIds: [a.id] } });
    }
    for (const t of offeredThreads) {
      if (selected.has(threadKey(t.id))) {
        // Every email in the conversation, as one group: `emails.id`, which is
        // what Communication.id carries for an email row.
        requests.push({ key: threadKey(t.id), request: { kind: "email", targetIds: t.emails.map((e) => e.id) } });
      }
    }
    if (requests.length === 0) return;

    setLinking(true);
    let outcomes: ChecklistLinkOutcome[];
    try {
      outcomes = await onLink(requests.map((r) => r.request));
    } catch (err) {
      logger.error("Linking checklist evidence failed:", err);
      onShowError("Could not link to this checklist item.");
      setLinking(false);
      return;
    }
    setLinking(false);

    let added = 0;
    let itemGone = false;
    let failedMessage: string | null = null;
    const newlyRefused = new Set<RowKey>();
    outcomes.forEach((outcome, i) => {
      const key = requests[i].key;
      if (!outcome.result.success || !outcome.result.data) {
        failedMessage = outcome.result.error ?? "Could not link to this checklist item.";
        return;
      }
      const data = outcome.result.data;
      switch (data.status) {
        case "added":
          added += 1;
          break;
        case "no_item":
          itemGone = true;
          break;
        case "targets_not_in_transaction":
          newlyRefused.add(key);
          break;
        case "no_targets":
          // Unreachable from here: every request carries at least one id, and
          // IPC refuses an empty list. Treated as a refusal, never a success.
          newlyRefused.add(key);
          break;
        default: {
          const exhaustive: never = data;
          return exhaustive;
        }
      }
    });

    if (itemGone) {
      onShowError("This checklist changed while you were linking. Nothing more was added.");
      onClose();
      return;
    }
    if (newlyRefused.size > 0 || failedMessage) {
      setRefused((prev) => new Set([...prev, ...newlyRefused]));
      setSelected((prev) => {
        const next = new Set(prev);
        outcomes.forEach((o, i) => {
          if (o.result.success && o.result.data?.status === "added") next.delete(requests[i].key);
        });
        for (const k of newlyRefused) next.delete(k);
        return next;
      });
      if (newlyRefused.size > 0) onRefreshTargets();
      if (failedMessage && added === 0 && newlyRefused.size === 0) onShowError(failedMessage);
      else onShowError(`${added} of ${plural(requests.length, "link")} added.`);
      return;
    }
    onShowSuccess(added === 1 ? "Linked to checklist item" : `${added} links added`);
    onClose();
  };

  const openAttachmentWithSystem = async (storagePath: string) => {
    try {
      const result = await window.api.transactions.openAttachment(storagePath);
      if (!result.success) logger.error("Failed to open attachment:", result.error);
    } catch (err) {
      logger.error("Error opening attachment:", err);
    }
  };

  const rowClass = (checked: boolean, disabled: boolean) =>
    `flex items-center gap-3 px-3 py-2.5 rounded-lg border text-left ${
      disabled
        ? "bg-gray-50 border-gray-200 opacity-60 cursor-not-allowed"
        : checked
          ? "bg-blue-50 border-blue-400 cursor-pointer"
          : "bg-white border-gray-200 hover:bg-gray-50 cursor-pointer"
    }`;

  const box = (checked: boolean) => (
    <span
      className={`w-5 h-5 rounded border-2 flex items-center justify-center flex-shrink-0 ${
        checked ? "bg-blue-500 border-blue-500" : "border-gray-300 bg-white"
      }`}
      aria-hidden="true"
    >
      {checked && (
        <svg className="w-3 h-3 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" />
        </svg>
      )}
    </span>
  );

  const count = selected.size;

  return (
    <>
      <ResponsiveModal onClose={onClose} zIndex="z-[70]" testId="checklist-link-picker" panelClassName="max-w-3xl sm:max-h-[80vh]">
        <div className="flex-shrink-0 bg-gradient-to-r from-blue-500 to-indigo-600 px-3 sm:px-6 pt-6 sm:pt-4 pb-3 sm:pb-4 sm:rounded-t-xl shadow-lg">
          <div className="flex items-center justify-between gap-2">
            <div className="min-w-0">
              <h3 className="text-lg font-bold text-white">Link to checklist item</h3>
              <p className="text-blue-100 text-sm truncate">
                {item.title} &middot; {templateName}
              </p>
            </div>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close link picker"
              className="text-white hover:bg-white hover:bg-opacity-20 rounded-full p-1 transition-all flex-shrink-0"
            >
              <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
        </div>

        <div className="flex-shrink-0 p-4 border-b border-gray-200">
          <input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search attachments and conversations"
            aria-label="Search attachments and conversations"
            className="w-full px-3 py-2.5 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 text-gray-900 bg-white min-h-[44px]"
            data-testid="checklist-picker-search"
          />
        </div>

        <div className="flex-1 overflow-y-auto p-4 space-y-6">
          <section data-testid="checklist-picker-attachments">
            <div className="flex items-center justify-between mb-2">
              <h4 className="text-sm font-semibold text-gray-700">Attachments on this transaction</h4>
              {enabledAttachmentKeys.length > 0 && (
                <button
                  type="button"
                  onClick={() => selectAll(enabledAttachmentKeys)}
                  className="text-xs font-medium text-blue-600 hover:text-blue-800"
                  data-testid="checklist-picker-select-all-attachments"
                >
                  Select all
                </button>
              )}
            </div>
            {attachmentsLoading ? (
              <p className="text-sm text-gray-500">Loading attachments&hellip;</p>
            ) : visibleAttachments.length === 0 ? (
              <p className="text-sm text-gray-500">No attachments on this transaction.</p>
            ) : (
              <div className="space-y-2">
                {visibleAttachments.map((a) => {
                  const key = attKey(a.id);
                  const linked = linkedAttachmentIds.has(a.id);
                  const wasRefused = refused.has(key);
                  const disabled = linked || wasRefused;
                  const checked = linked || selected.has(key);
                  return (
                    <div
                      key={a.id}
                      role="checkbox"
                      aria-checked={checked}
                      aria-disabled={disabled}
                      tabIndex={disabled ? -1 : 0}
                      onClick={() => !disabled && toggle(key)}
                      onKeyDown={(e) => {
                        if (!disabled && (e.key === " " || e.key === "Enter")) {
                          e.preventDefault();
                          toggle(key);
                        }
                      }}
                      className={rowClass(checked, disabled)}
                      data-testid={`checklist-picker-attachment-${a.id}`}
                    >
                      {box(checked)}
                      <span className="flex-1 min-w-0">
                        <span className="block text-sm font-medium text-gray-900 truncate">{a.filename}</span>
                        <span className="block text-xs text-gray-500">
                          {wasRefused
                            ? "No longer on this transaction"
                            : linked
                              ? "Linked"
                              : `${formatFileSize(a.file_size_bytes)} | ${formatDate(a.source_date)}`}
                        </span>
                      </span>
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          setPreviewing({
                            id: a.id,
                            filename: a.filename,
                            mime_type: a.mime_type,
                            file_size_bytes: a.file_size_bytes,
                            storage_path: a.storage_path,
                          });
                        }}
                        className="text-sm font-medium text-blue-600 hover:text-blue-800 flex-shrink-0"
                        aria-label={`View ${a.filename}`}
                      >
                        View
                      </button>
                    </div>
                  );
                })}
              </div>
            )}
          </section>

          <section data-testid="checklist-picker-threads">
            <div className="flex items-center justify-between mb-2">
              <h4 className="text-sm font-semibold text-gray-700">Email threads on this transaction</h4>
              {enabledThreadKeys.length > 0 && (
                <button
                  type="button"
                  onClick={() => selectAll(enabledThreadKeys)}
                  className="text-xs font-medium text-blue-600 hover:text-blue-800"
                  data-testid="checklist-picker-select-all-threads"
                >
                  Select all
                </button>
              )}
            </div>
            {emailsLoading ? (
              <p className="text-sm text-gray-500" data-testid="checklist-picker-emails-loading">Loading emails&hellip;</p>
            ) : visibleThreads.length === 0 ? (
              <p className="text-sm text-gray-500">No email threads on this transaction.</p>
            ) : (
              <div className="space-y-2">
                {visibleThreads.map((t) => {
                  const key = threadKey(t.id);
                  const linked = threadLinked(t);
                  const wasRefused = refused.has(key);
                  const disabled = linked || wasRefused;
                  const checked = linked || selected.has(key);
                  return (
                    <div
                      key={t.id}
                      role="checkbox"
                      aria-checked={checked}
                      aria-disabled={disabled}
                      tabIndex={disabled ? -1 : 0}
                      onClick={() => !disabled && toggle(key)}
                      onKeyDown={(e) => {
                        if (!disabled && (e.key === " " || e.key === "Enter")) {
                          e.preventDefault();
                          toggle(key);
                        }
                      }}
                      className={rowClass(checked, disabled)}
                      data-testid={`checklist-picker-thread-${t.id}`}
                    >
                      {box(checked)}
                      <span className="flex-1 min-w-0">
                        <span className="block text-sm font-medium text-gray-900 truncate">{t.subject}</span>
                        <span className="block text-xs text-gray-500 truncate">
                          {wasRefused
                            ? "No longer on this transaction"
                            : linked
                              ? "Linked"
                              : `${t.participants.slice(0, 2).join(", ")} | ${plural(t.emailCount, "email")}`}
                        </span>
                      </span>
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          setViewingThread(t);
                        }}
                        className="text-sm font-medium text-blue-600 hover:text-blue-800 flex-shrink-0"
                        aria-label={`View ${t.subject}`}
                      >
                        View
                      </button>
                    </div>
                  );
                })}
              </div>
            )}
            <p className="mt-2 text-xs text-gray-500">
              Linking a conversation links every email in it. <strong>View</strong> opens it without selecting it.
            </p>
          </section>
        </div>

        <div className="flex-shrink-0 px-3 sm:px-6 py-3 sm:py-4 bg-gray-50 rounded-b-xl flex items-center gap-3 justify-end sm:justify-between border-t border-gray-200">
          <span className="text-sm text-gray-600 hidden sm:inline" data-testid="checklist-picker-count">
            {count > 0 ? `${count} selected` : "Select attachments or conversations"}
          </span>
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={onClose}
              disabled={linking}
              className="px-4 py-2 text-gray-700 hover:bg-gray-200 rounded-lg font-medium transition-all disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => void handleLink()}
              disabled={count === 0 || linking}
              className={`px-6 py-2 rounded-lg font-semibold transition-all ${
                count === 0 || linking
                  ? "bg-gray-300 text-gray-500 cursor-not-allowed"
                  : "bg-gradient-to-r from-blue-500 to-indigo-600 text-white hover:from-blue-600 hover:to-indigo-700 shadow-md"
              }`}
              data-testid="checklist-picker-link"
            >
              {linking ? "Linking…" : `Link ${plural(count, "item")}`}
            </button>
          </div>
        </div>
      </ResponsiveModal>

      {previewing && (
        <AttachmentPreviewModal
          attachment={previewing}
          onClose={() => setPreviewing(null)}
          onOpenWithSystem={(p) => void openAttachmentWithSystem(p)}
        />
      )}
      {viewingThread && (
        <EmailThreadViewModal
          thread={viewingThread}
          onClose={() => setViewingThread(null)}
          userEmail={userEmail}
          nameMap={nameMap}
        />
      )}
    </>
  );
}

export default ChecklistLinkPicker;
