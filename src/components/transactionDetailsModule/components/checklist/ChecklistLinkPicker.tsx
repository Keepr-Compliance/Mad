/**
 * ChecklistLinkPicker — BACKLOG-3476, mock state 3.
 *
 * Link attachments and email threads that are ALREADY on this transaction to
 * one checklist item. The shell follows AttachEmailsModal (header,
 * search, footer count, Cancel + primary).
 *
 * What it offers, and why only that:
 * - Attachments: this transaction's unified list, minus the legacy rows main
 *   would refuse (`linkableAttachments`).
 * - Email threads: the Emails tab's "Linked emails" list and nothing else
 *   (`linkableThreads`, SR condition 12). Emails waiting in Needs review are
 *   not evidence yet.
 * - Texts (BACKLOG-3968 U2): this deal's texts, a page at a time, through the
 *   paged text reader (`usePickerTexts`). Several texts picked at once become
 *   ONE group ("Link 2 texts"), written by `checklistService.linkText`. A text
 *   is never asked the outside-the-dates question: main refuses "Include it"
 *   for texts, and the submit pre-flight says when a text is not sent.
 *
 * Emails, Texts and Attachments are tabs (the approved mock). Every tab's
 * panel stays mounted, so a pick can mix tabs; the Texts tab reads nothing
 * until it is first opened.
 *
 * The emails load through `ensureEmailsLoaded`, which is SILENT (SR condition
 * 1). The loud loader flips the shared `loading` flag, and on a transaction
 * with no contacts that replaces the whole details modal with a spinner —
 * unmounting this picker and losing the selection.
 *
 * Main decides membership, all-or-nothing per group. A refused group stays
 * selectable-no-more and is marked "No longer on this transaction"; the rest
 * are kept.
 *
 * BACKLOG-3764: main also answers `outside_dates` for a group with evidence
 * dated outside the deal's audit dates, and writes nothing. The picker then
 * asks once for every such group in the pick (founder's sentence): "Include
 * it" repeats those requests with `includeOutsideDates`; "Don't link" links
 * none of them. The picker never compares dates itself.
 */
import React, { useEffect, useMemo, useRef, useState } from "react";
import { ResponsiveModal } from "../../../common/ResponsiveModal";
import { EmailThreadViewModal } from "../modals/EmailThreadViewModal";
import type { EmailThread } from "../EmailThreadCard";
import type { UnifiedAttachment } from "../../hooks/useTransactionAllAttachments";
import { AttachmentPreviewHost, useAttachmentPreview } from "../../hooks/useAttachmentPreview";
import type {
  ChecklistLinkOutcome,
  ChecklistLinkRequest,
} from "../../hooks/useTransactionChecklist";
import type {
  AddChecklistLinkResult,
  ChecklistItem,
  ChecklistLink,
} from "../../../../../electron/types/checklist";
import type { ChecklistWriteApiResult } from "../../../../services/checklistService";
import { usePickerTexts } from "../../hooks/useChecklistTexts";
import type { Communication } from "../../types";
import { linkableAttachments, linkableThreads, plural } from "../../utils/checklistLinks";
import { formatDate, formatFileSize } from "../../../../utils/formatUtils";
import {
  includeAnywayQuestion,
  outsideDatesPluralSentence,
  outsideDatesSentence,
  shortDay,
  type OutsideEvidenceKind,
} from "../../utils/outsideAuditDatesCopy";
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
  /**
   * BACKLOG-3968 U2: the Texts tab. Absent: no Texts tab. `onLink` writes the
   * picked texts (`messages.id`) as one group and passes main's refusal
   * (`dealLocked`) through.
   */
  texts?: {
    transactionId: string;
    userId?: string;
    onLink: (messageIds: string[]) => Promise<ChecklistWriteApiResult<AddChecklistLinkResult>>;
  };
}

type RowKey = string;
type PickerTab = "emails" | "texts" | "attachments";

/** BACKLOG-3764: one group main refused as outside the audit dates. */
interface OutsidePending {
  key: RowKey;
  request: ChecklistLinkRequest;
  label: string;
  evidence: OutsideEvidenceKind;
  sentAt: string | null;
  auditStart: string | null;
  auditEnd: string | null;
}

/** BACKLOG-3764: the question on screen, and where the pick stood when it was asked. */
interface OutsideQuestion {
  pending: OutsidePending[];
  added: number;
  total: number;
}
const attKey = (id: string): RowKey => `a:${id}`;
const threadKey = (id: string): RowKey => `t:${id}`;
const textKey = (id: string): RowKey => `x:${id}`;

/** BACKLOG-3968 U2: the short reason a text link was not written. */
export function textLinkRefusal(result: ChecklistWriteApiResult<AddChecklistLinkResult>): string {
  if (result.dealLocked) return result.error || "This deal is locked, so nothing was linked.";
  if (result.success && result.data?.status === "targets_not_in_transaction") {
    return "Some of these texts are no longer on this deal. Nothing was linked.";
  }
  if (result.success && result.data?.status === "no_item") {
    return "This checklist changed while you were linking. Nothing was linked.";
  }
  return result.error || "Could not link these texts.";
}

function shortTextDate(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
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
  texts,
}: ChecklistLinkPickerProps): React.ReactElement {
  const [tab, setTab] = useState<PickerTab>("emails");
  // The Texts tab reads nothing until it is first opened.
  const [textsOpened, setTextsOpened] = useState(false);
  const pickerTexts = usePickerTexts(texts?.transactionId ?? "", texts?.userId, !!texts && textsOpened);
  // Texts shown as linked while their write is in flight; cleared on refusal.
  const [optimisticTexts, setOptimisticTexts] = useState<Set<string>>(new Set());
  const tabRefs = useRef<Record<PickerTab, HTMLButtonElement | null>>({ emails: null, texts: null, attachments: null });
  const [emailsLoading, setEmailsLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<Set<RowKey>>(new Set());
  const [refused, setRefused] = useState<Set<RowKey>>(new Set());
  const [linking, setLinking] = useState(false);
  const [question, setQuestion] = useState<OutsideQuestion | null>(null);
  // View goes through the shared open flow, so a metadata-only email
  // attachment is downloaded before it is previewed (BACKLOG-3476).
  const attachmentPreview = useAttachmentPreview(onRefreshTargets);
  const { downloadingId, message: previewMessage } = attachmentPreview;
  useEffect(() => {
    if (previewMessage) onShowError(previewMessage);
  }, [previewMessage, onShowError]);
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

  const linkedTextIds = useMemo(() => {
    const s = new Set<string>();
    for (const l of existingLinks) {
      if (l.kind !== "text") continue;
      for (const m of l.members) if (m.messageId) s.add(m.messageId);
    }
    return s;
  }, [existingLinks]);

  const q = search.trim().toLowerCase();
  const visibleTexts = useMemo(
    () =>
      pickerTexts.texts.filter(
        (t) => !q || t.name.toLowerCase().includes(q) || t.snippet.toLowerCase().includes(q),
      ),
    [pickerTexts.texts, q],
  );
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
  const textLinked = (id: string) => linkedTextIds.has(id) || optimisticTexts.has(id);
  const textDisabled = (id: string) => textLinked(id) || refused.has(textKey(id));

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
  const enabledTextKeys = visibleTexts.filter((t) => !textDisabled(t.id)).map((t) => textKey(t.id));

  /** What the agent sees for one requested group (label + what kind of thing it is). */
  const describe = (key: RowKey, request: ChecklistLinkRequest): { label: string; evidence: OutsideEvidenceKind } => {
    if (request.kind === "attachment") {
      const a = offeredAttachments.find((x) => attKey(x.id) === key);
      return { label: a?.filename ?? "", evidence: "file" };
    }
    const t = offeredThreads.find((x) => threadKey(x.id) === key);
    return { label: t?.subject ?? "", evidence: request.targetIds.length > 1 ? "conversation" : "email" };
  };

  /**
   * Send these requests and settle the outcome. `priorAdded` / `total` carry
   * the pick across the outside-the-dates question, so the final message
   * counts the whole pick.
   */
  const runLink = async (
    requests: Array<{ key: RowKey; request: ChecklistLinkRequest }>,
    priorAdded: number,
    total: number,
  ) => {
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

    let added = priorAdded;
    let itemGone = false;
    let failedMessage: string | null = null;
    const newlyRefused = new Set<RowKey>();
    const outside: OutsidePending[] = [];
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
        case "outside_dates":
          if (requests[i].request.includeOutsideDates) {
            // Already answered yes; main cannot ask again. Never a success.
            failedMessage = "Could not link to this checklist item.";
            break;
          }
          outside.push({
            key,
            request: requests[i].request,
            ...describe(key, requests[i].request),
            sentAt: data.outside[0]?.sentAt ?? null,
            auditStart: data.auditStart,
            auditEnd: data.auditEnd,
          });
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
      else onShowError(`${added} of ${plural(total, "link")} added.`);
      return;
    }
    if (outside.length > 0) {
      setQuestion({ pending: outside, added, total });
      return;
    }
    onShowSuccess(added === 1 ? "Linked to checklist item" : `${added} links added`);
    onClose();
  };

  /**
   * BACKLOG-3968 U2: the picked texts, as ONE group (the set model, SR
   * 56b8dcd9). Shown as linked at once; a refusal puts them back and says why.
   * Returns false when nothing more should be sent.
   */
  const linkPickedTexts = async (): Promise<boolean | "linked"> => {
    if (!texts) return true;
    const ids = pickerTexts.texts.filter((t) => selected.has(textKey(t.id))).map((t) => t.id);
    if (ids.length === 0) return true;
    setOptimisticTexts((prev) => new Set([...prev, ...ids]));
    setLinking(true);
    let result: ChecklistWriteApiResult<AddChecklistLinkResult>;
    try {
      result = await texts.onLink(ids);
    } catch (err) {
      logger.error("Linking texts to a checklist item failed:", err);
      result = { success: false, error: "Could not link these texts." };
    }
    setLinking(false);
    if (result.success && result.data?.status === "added") {
      setSelected((prev) => {
        const next = new Set(prev);
        for (const id of ids) next.delete(textKey(id));
        return next;
      });
      return "linked";
    }
    // Refused: nothing was written. The rows go back to how they were.
    setOptimisticTexts((prev) => {
      const next = new Set(prev);
      for (const id of ids) next.delete(id);
      return next;
    });
    if (result.success && result.data?.status === "no_item") {
      onShowError(textLinkRefusal(result));
      onClose();
      return false;
    }
    if (result.success && result.data?.status === "targets_not_in_transaction") {
      setRefused((prev) => new Set([...prev, ...ids.map(textKey)]));
      setSelected((prev) => {
        const next = new Set(prev);
        for (const id of ids) next.delete(textKey(id));
        return next;
      });
    }
    onShowError(textLinkRefusal(result));
    return false;
  };

  const handleLink = async () => {
    if (selected.size === 0 || linking) return;
    const textOutcome = await linkPickedTexts();
    if (textOutcome === false) return;
    const textsAdded = textOutcome === "linked" ? 1 : 0;
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
    if (requests.length === 0) {
      if (textsAdded > 0) {
        onShowSuccess("Linked to checklist item");
        onClose();
      }
      return;
    }
    await runLink(requests, textsAdded, requests.length + textsAdded);
  };

  /** BACKLOG-3764: "Include it" — the same groups again, with the answer. */
  const includeOutside = async () => {
    if (!question || linking) return;
    const { pending, added, total } = question;
    setQuestion(null);
    await runLink(
      pending.map((p) => ({ key: p.key, request: { ...p.request, includeOutsideDates: true } })),
      added,
      total,
    );
  };

  /** BACKLOG-3764: "Don't link" — none of the outside groups is linked. */
  const declineOutside = () => {
    if (!question) return;
    const { added } = question;
    setQuestion(null);
    onShowSuccess(added === 0 ? "Not linked" : added === 1 ? "Linked to checklist item" : `${added} links added`);
    onClose();
  };

  const rowClass = (checked: boolean, disabled: boolean) =>
    `flex items-center gap-3 px-3 py-2.5 rounded-lg border text-left ${
      disabled
        ? "bg-gray-50 border-gray-200 opacity-60 cursor-not-allowed"
        : checked
          ? "bg-primary-50 border-primary-400 cursor-pointer"
          : "bg-white border-gray-200 hover:bg-gray-50 cursor-pointer"
    }`;

  const box = (checked: boolean) => (
    <span
      className={`w-5 h-5 rounded border-2 flex items-center justify-center flex-shrink-0 ${
        checked ? "bg-primary-600 border-primary-600" : "border-gray-300 bg-white"
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

  /** Space or Enter toggles a row (the rows are checkboxes). */
  const rowKeyDown = (key: RowKey, disabled: boolean) => (e: React.KeyboardEvent) => {
    if (!disabled && (e.key === " " || e.key === "Enter")) {
      e.preventDefault();
      toggle(key);
    }
  };

  const count = selected.size;
  const onlyTexts = count > 0 && [...selected].every((k) => k.startsWith("x:"));

  const tabs: Array<{ id: PickerTab; label: string }> = [
    { id: "emails", label: "Emails" },
    ...(texts ? [{ id: "texts" as const, label: "Texts" }] : []),
    { id: "attachments", label: "Attachments" },
  ];
  const openTab = (id: PickerTab) => {
    setTab(id);
    if (id === "texts") setTextsOpened(true);
  };
  /** Arrow keys move between tabs (WAI-ARIA tabs pattern); the panel follows. */
  const tabKeyDown = (e: React.KeyboardEvent) => {
    const i = tabs.findIndex((t) => t.id === tab);
    let next = -1;
    if (e.key === "ArrowRight") next = (i + 1) % tabs.length;
    else if (e.key === "ArrowLeft") next = (i - 1 + tabs.length) % tabs.length;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = tabs.length - 1;
    if (next < 0) return;
    e.preventDefault();
    openTab(tabs[next].id);
    tabRefs.current[tabs[next].id]?.focus();
  };

  const selectAllButton = (keys: RowKey[], testId: string) =>
    keys.length > 0 && (
      <button
        type="button"
        onClick={() => selectAll(keys)}
        className="text-xs font-medium text-primary-700 hover:text-primary-800"
        data-testid={testId}
      >
        Select all
      </button>
    );

  return (
    <>
      <ResponsiveModal onClose={onClose} zIndex="z-[70]" testId="checklist-link-picker" panelClassName="max-w-3xl sm:max-h-[80vh]">
        <div className="flex-shrink-0 bg-white px-3 sm:px-6 pt-6 sm:pt-4 pb-3 sm:pb-4 sm:rounded-t-xl border-b border-gray-200">
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <h3 className="text-lg font-semibold text-gray-900">Link to checklist item</h3>
              <p className="text-gray-500 text-sm truncate">
                {item.title} &middot; {templateName}
              </p>
            </div>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close link picker"
              className="text-gray-400 hover:text-gray-600 hover:bg-gray-100 rounded-full p-1 transition-all flex-shrink-0"
            >
              <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
        </div>

        <div
          role="tablist"
          aria-label="What to link"
          className="flex-shrink-0 flex gap-1 px-3 sm:px-5 border-b border-gray-200 overflow-x-auto"
          onKeyDown={tabKeyDown}
          data-testid="checklist-picker-tabs"
        >
          {tabs.map((t) => (
            <button
              key={t.id}
              ref={(el) => {
                tabRefs.current[t.id] = el;
              }}
              type="button"
              role="tab"
              id={`checklist-picker-tab-${t.id}`}
              aria-selected={tab === t.id}
              aria-controls={`checklist-picker-panel-${t.id}`}
              tabIndex={tab === t.id ? 0 : -1}
              onClick={() => openTab(t.id)}
              className={`px-3 py-2.5 text-sm font-medium whitespace-nowrap border-b-2 -mb-px ${
                tab === t.id
                  ? "border-primary-600 text-primary-700"
                  : "border-transparent text-gray-500 hover:text-gray-700"
              }`}
              data-testid={`checklist-picker-tab-${t.id}`}
            >
              {t.label}
            </button>
          ))}
        </div>

        <div className="flex-shrink-0 p-4 border-b border-gray-200">
          <input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search"
            aria-label="Search attachments, conversations and texts"
            className="w-full px-3 py-2.5 border border-gray-300 rounded-lg focus:ring-2 focus:ring-primary-500 focus:border-primary-500 text-gray-900 bg-white min-h-[44px]"
            data-testid="checklist-picker-search"
          />
        </div>

        <div className="flex-1 overflow-y-auto p-4">
          <section
            role="tabpanel"
            id="checklist-picker-panel-attachments"
            aria-labelledby="checklist-picker-tab-attachments"
            hidden={tab !== "attachments"}
            data-testid="checklist-picker-attachments"
          >
            <div className="flex items-center justify-between mb-2">
              <h4 className="text-sm font-semibold text-gray-700">Attachments on this transaction</h4>
              {selectAllButton(enabledAttachmentKeys, "checklist-picker-select-all-attachments")}
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
                      onKeyDown={rowKeyDown(key, disabled)}
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
                          void attachmentPreview.open(a);
                        }}
                        disabled={downloadingId === a.id}
                        aria-busy={downloadingId === a.id || undefined}
                        className="text-sm font-medium text-primary-700 hover:text-primary-800 flex-shrink-0 disabled:opacity-60 disabled:cursor-wait"
                        aria-label={`View ${a.filename}`}
                      >
                        {downloadingId === a.id ? "Opening…" : "View"}
                      </button>
                    </div>
                  );
                })}
              </div>
            )}
          </section>

          <section
            role="tabpanel"
            id="checklist-picker-panel-emails"
            aria-labelledby="checklist-picker-tab-emails"
            hidden={tab !== "emails"}
            data-testid="checklist-picker-threads"
          >
            <div className="flex items-center justify-between mb-2">
              <h4 className="text-sm font-semibold text-gray-700">Email threads on this transaction</h4>
              {selectAllButton(enabledThreadKeys, "checklist-picker-select-all-threads")}
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
                      onKeyDown={rowKeyDown(key, disabled)}
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
                        className="text-sm font-medium text-primary-700 hover:text-primary-800 flex-shrink-0"
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

          {texts && (
            <section
              role="tabpanel"
              id="checklist-picker-panel-texts"
              aria-labelledby="checklist-picker-tab-texts"
              hidden={tab !== "texts"}
              data-testid="checklist-picker-texts"
            >
              <div className="flex items-center justify-between mb-2">
                <h4 className="text-sm font-semibold text-gray-700">Texts on this transaction</h4>
                {selectAllButton(enabledTextKeys, "checklist-picker-select-all-texts")}
              </div>
              {pickerTexts.error ? (
                <p className="text-sm text-gray-500" data-testid="checklist-picker-texts-error">{pickerTexts.error}</p>
              ) : pickerTexts.loading && pickerTexts.texts.length === 0 ? (
                <p className="text-sm text-gray-500" data-testid="checklist-picker-texts-loading">Loading texts&hellip;</p>
              ) : visibleTexts.length === 0 ? (
                <p className="text-sm text-gray-500">No texts on this transaction.</p>
              ) : (
                <div className="space-y-2">
                  {visibleTexts.map((t) => {
                    const key = textKey(t.id);
                    const linked = textLinked(t.id);
                    const wasRefused = refused.has(key);
                    const disabled = linked || wasRefused;
                    const checked = linked || selected.has(key);
                    const day = shortTextDate(t.sentAt);
                    return (
                      <div
                        key={t.id}
                        role="checkbox"
                        aria-checked={checked}
                        aria-disabled={disabled}
                        aria-label={`${t.name}${day ? `, ${day}` : ""}`}
                        tabIndex={disabled ? -1 : 0}
                        onClick={() => !disabled && toggle(key)}
                        onKeyDown={rowKeyDown(key, disabled)}
                        className={rowClass(checked, disabled)}
                        data-testid={`checklist-picker-text-${t.id}`}
                      >
                        {box(checked)}
                        <span
                          className="w-8 h-8 rounded-lg inline-flex items-center justify-center flex-shrink-0 text-[10px] font-bold bg-success-50 text-success-700"
                          aria-hidden="true"
                        >
                          TXT
                        </span>
                        <span className="flex-1 min-w-0">
                          <span className="block text-sm font-medium text-gray-900 truncate">{t.name}</span>
                          <span className="block text-xs text-gray-500 truncate">
                            {wasRefused
                              ? "No longer on this transaction"
                              : linked
                                ? "Linked"
                                : [day, t.snippet ? `“${t.snippet}”` : ""].filter(Boolean).join(" · ")}
                          </span>
                        </span>
                      </div>
                    );
                  })}
                  {pickerTexts.hasMore && (
                    <button
                      type="button"
                      onClick={() => void pickerTexts.loadMore()}
                      disabled={pickerTexts.loading}
                      className="w-full py-2 text-sm font-medium text-primary-700 hover:underline disabled:opacity-60"
                      data-testid="checklist-picker-texts-more"
                    >
                      {pickerTexts.loading ? "Loading…" : "Show more"}
                    </button>
                  )}
                </div>
              )}
              <p className="mt-2 text-xs text-gray-500">
                Texts you pick together are linked as one group.
                {pickerTexts.threadsLeftOut > 0 && " Showing your 200 most recent conversations."}
              </p>
            </section>
          )}
        </div>

        <div className="flex-shrink-0 px-3 sm:px-6 py-3 sm:py-4 bg-gray-50 rounded-b-xl flex items-center gap-3 justify-end sm:justify-between border-t border-gray-200">
          <span className="text-sm text-gray-600 hidden sm:inline" data-testid="checklist-picker-count">
            {count > 0 ? `${count} selected` : texts ? "Select emails, texts or attachments" : "Select attachments or conversations"}
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
                  : "bg-primary-600 text-white hover:bg-primary-700 shadow-sm"
              }`}
              data-testid="checklist-picker-link"
            >
              {linking ? "Linking…" : `Link ${plural(count, onlyTexts ? "text" : "item")}`}
            </button>
          </div>
        </div>
      </ResponsiveModal>
      {question && (
        <ResponsiveModal
          onClose={declineOutside}
          zIndex="z-[80]"
          testId="checklist-outside-dates-question"
          panelClassName="max-w-md"
        >
          <div className="p-5 space-y-3 text-sm text-gray-800">
            {question.pending.length === 1 ? (
              <p data-testid="checklist-outside-dates-sentence">
                {outsideDatesSentence(
                  question.pending[0].evidence,
                  question.pending[0].sentAt,
                  question.pending[0].auditStart,
                  question.pending[0].auditEnd,
                )}{" "}
                {includeAnywayQuestion(1)}
              </p>
            ) : (
              <>
                <p data-testid="checklist-outside-dates-sentence">
                  {outsideDatesPluralSentence(question.pending[0].auditStart, question.pending[0].auditEnd)}{" "}
                  {includeAnywayQuestion(question.pending.length)}
                </p>
                <ul className="list-disc pl-5 space-y-1" data-testid="checklist-outside-dates-list">
                  {question.pending.map((p) => {
                    const day = shortDay(p.sentAt);
                    return <li key={p.key}>{day ? `${p.label} — ${day}` : p.label}</li>;
                  })}
                </ul>
              </>
            )}
          </div>
          <div className="px-5 py-3 bg-gray-50 rounded-b-xl flex justify-end gap-3 border-t border-gray-200">
            <button
              type="button"
              onClick={declineOutside}
              className="px-4 py-2 text-gray-700 hover:bg-gray-200 rounded-lg font-medium"
              data-testid="checklist-outside-dates-decline"
            >
              Don&apos;t link
            </button>
            <button
              type="button"
              onClick={() => void includeOutside()}
              className="px-4 py-2 bg-primary-600 text-white hover:bg-primary-700 rounded-lg font-semibold"
              data-testid="checklist-outside-dates-include"
            >
              {question.pending.length === 1 ? "Include it" : "Include them"}
            </button>
          </div>
        </ResponsiveModal>
      )}
      <AttachmentPreviewHost preview={attachmentPreview} />
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
