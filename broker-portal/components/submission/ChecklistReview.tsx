'use client';

/**
 * ChecklistReview — BACKLOG-3477, mock 3481 v4, with the tick model of BACKLOG-3596.
 *
 * Mock v4's "Mark reviewed" pill, agent-tick icons in the broker view and
 * counts from agent ticks are SUPERSEDED by BACKLOG-3596 (pm_comments b250c7fa).
 * Do not build to those parts of the mock.
 *
 * The Checklists area of the submission review page, between Status History
 * and Messages/Attachments. One card, one collapsible section per checklist.
 *
 * - BACKLOG-3596 (founder design): on the broker page the item's checkbox IS
 *   the broker's tick (set_submission_checklist_reviewer_check), with who and
 *   when under the item title. The agent's ticks are never shown to a broker,
 *   and "x of y required" counts the broker's ticks. Every item carries the
 *   checkbox except in a checklist added at review. An unticked item carries
 *   no pill: the empty checkbox says it. Ticking and Add are closed, with one
 *   plain notice in the header, once changes are requested or a newer version
 *   exists. "Changed since you checked" marks an item whose tick did not carry
 *   over from the previous version because the agent changed it.
 * - The agent's notes and links are frozen and read-only.
 * - "Add checklist" adds one of the organization's templates through
 *   add_submission_checklist_at_review.
 * - Every attachment / email chip has one View action that opens the
 *   existing viewers: AttachmentViewerModal and MessageList's
 *   ConversationModal (the "View Full" viewer).
 * - viewer="agent" (BACKLOG-3593, My Transactions): the same section, read
 *   only, showing the agent's OWN ticks and counts. No broker tick, no Add,
 *   no Request Changes sentence.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  AlertTriangle,
  CheckCircle2,
  ChevronRight,
  Circle,
  FileText,
  Loader2,
  Mail,
  Plus,
  X,
} from 'lucide-react';
import { Button } from '@keepr/design-system';
import { formatDate } from '@/lib/utils';
import {
  ADD_OPEN_STATUSES,
  agentRemovals,
  changedSinceChecked,
  isRemovedSection,
  requestChangesAvailable,
  formatRequired,
  overallRequiredCount,
  requiredCount,
  sectionKey,
  tickOpenFor,
  type AgentRemoval,
  type ChecklistItemView,
  type ChecklistLink,
  type ChecklistSectionView,
  type LinkedCounts,
  type RequiredCount,
  type SupersededBy,
  type TemplateOption,
} from '@/lib/submissions/checklistModel';
import { actorLabel, actorName, linkedPhrase } from '@/lib/submissions/history';
import {
  addChecklistAtReview,
  removeChecklistAtReview,
  restoreChecklistAtReview,
  setReviewerCheck,
} from '@/lib/actions/submissionChecklists';
import { AttachmentViewerModal } from './AttachmentViewerModal';
import {
  ConversationModal,
  groupMessagesIntoThreads,
  type Message,
  type AttachmentsByMessage,
  type Thread,
} from './MessageList';

export interface ChecklistAttachment {
  id: string;
  filename: string;
  mime_type: string | null;
  file_size_bytes: number | null;
  storage_path: string | null;
}

export interface ChecklistReviewProps {
  submissionId: string;
  status: string;
  sections: ChecklistSectionView[];
  /** false when the checklist tables could not be read. */
  loaded?: boolean;
  /** id -> display name from public.users; null when names are unavailable. */
  names: Record<string, string> | null;
  /** May tick and add (can_review_submission). */
  canTick: boolean;
  /**
   * May approve / request changes / reject: false for it_admin and during
   * impersonation. Only decides whether the banner points at Request Changes.
   */
  canDecide?: boolean;
  /** The organization's non-archived templates. */
  templates: TemplateOption[];
  /** Messages the page is allowed to show (already feature-gated). */
  messages: Message[];
  /** Attachments the page is allowed to show (already feature-gated). */
  attachments: ChecklistAttachment[];
  /**
   * Who is looking. 'agent' (My Transactions, BACKLOG-3593) is read-only
   * whatever canTick / canDecide say. Default 'reviewer' (the broker page).
   */
  viewer?: 'reviewer' | 'agent';
  /**
   * BACKLOG-3596: whether a newer version of this submission exists ('newer')
   * or is being sent ('uploading'). Ticking is closed on such a version.
   */
  supersededBy?: SupersededBy;
  /**
   * BACKLOG-3607: THIS version's own status_history (raw, not the chain), for
   * the agent's removals and "Add it back". Broker page only.
   */
  versionHistory?: unknown;
  /** BACKLOG-3607: this version's number, for "restored from version N". */
  version?: number | null;
  /** BACKLOG-3748: files shown inside their message's bubble in the View viewer. */
  attachmentsByMessage?: AttachmentsByMessage;
  /**
   * BACKLOG-3607: section id -> documents and emails linked to it on this
   * version, counted server-side by the remove RPC's rule, for the confirmation.
   */
  linkedCounts?: Record<string, LinkedCounts>;
}

/**
 * BACKLOG-3607: the Remove confirmation's sentence about linked evidence.
 * Documents and emails stay on the deal; only the checklist and its links go.
 */
export function removeConfirmText(counts: LinkedCounts | undefined): string {
  if (!counts) return 'Documents and emails linked to it stay on the deal; the checklist and its links are removed.';
  const linked = linkedPhrase(counts.documents, counts.emails);
  if (!linked) return 'No documents or emails are linked to it. The checklist is removed.';
  const one = counts.documents + counts.emails === 1;
  return `${linked} ${one ? 'is' : 'are'} linked to it. ${one ? 'It stays' : 'They stay'} on the deal; the checklist and its links are removed.`;
}

/**
 * BACKLOG-3596: why this version is closed to the broker's ticks AND to Add
 * checklist. One notice in the header covers both controls (coordinator
 * ruling C-A, pm_comments b43086bd); the newer-version wording is the same
 * for both (SR C-F, pm_comments 80f5ae11).
 */
export const VERSION_CLOSED_REASONS = {
  needs_changes:
    'Changes were requested, so this version is closed. You can check items and add a checklist on the next submission.',
  newer: 'A newer version of this submission has been sent, so this version is closed. Check items and add checklists on the newest version.',
  uploading: 'A newer version of this submission is being sent, so this version is closed.',
} as const;

/** The header notice for a closed version, or null when it is open (or decided). */
function versionClosedReason(status: string, supersededBy: SupersededBy): string | null {
  if (supersededBy) return VERSION_CLOSED_REASONS[supersededBy];
  if (status === 'needs_changes') return VERSION_CLOSED_REASONS.needs_changes;
  return null;
}

const CLOSED_REASON_ID = 'checklist-closed-reason';

function RequiredPill({ count }: { count: RequiredCount }) {
  const done = count.done === count.total;
  return (
    <span
      className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-3 py-1 text-[13px] font-semibold ${
        done ? 'bg-green-100 text-green-800' : 'border border-amber-200 bg-amber-50 text-amber-700'
      }`}
    >
      {done ? <CheckCircle2 className="h-3.5 w-3.5" aria-hidden /> : <AlertTriangle className="h-3.5 w-3.5" aria-hidden />}
      {formatRequired(count)}
    </span>
  );
}

function ItemIcon({ item }: { item: ChecklistItemView }) {
  if (item.isChecked) return <CheckCircle2 className="mt-0.5 h-[22px] w-[22px] shrink-0 text-green-600" aria-label="Checked by agent" />;
  if (item.isRequired) return <AlertTriangle className="mt-0.5 h-[22px] w-[22px] shrink-0 text-amber-500" aria-label="Not checked" />;
  return <Circle className="mt-0.5 h-[22px] w-[22px] shrink-0 text-gray-300" aria-label="Not checked" />;
}

interface ChipTarget {
  attachment: ChecklistAttachment | null;
  thread: Thread | null;
}

export function ChecklistReview({
  submissionId,
  status,
  sections: initialSections,
  loaded = true,
  names,
  canTick,
  canDecide = false,
  templates,
  messages,
  attachments,
  viewer: viewerRole = 'reviewer',
  supersededBy = null,
  versionHistory,
  version = null,
  linkedCounts,
  attachmentsByMessage,
}: ChecklistReviewProps) {
  const isAgent = viewerRole === 'agent';
  const router = useRouter();
  const [sections, setSections] = useState<ChecklistSectionView[]>(initialSections);

  const nameMap = useMemo(() => (names ? new Map(Object.entries(names)) : null), [names]);

  // Default: first checklist and any checklist added at review are open (mock v4).
  const [open, setOpen] = useState<Set<string>>(
    () =>
      new Set(
        initialSections
          .filter((s, idx) => (idx === 0 || s.addedAtReviewBy) && !isRemovedSection(s))
          .map((s) => s.id)
      )
  );

  // Fresh server data (router.refresh after a tick or an add). A checklist
  // that was just added at review arrives open, as in mock v4 state 4.
  const [knownIds, setKnownIds] = useState<Set<string>>(() => new Set(initialSections.map((s) => s.id)));
  useEffect(() => {
    setSections(initialSections);
    const arrived = initialSections.filter((s) => !knownIds.has(s.id));
    if (arrived.length === 0) return;
    setKnownIds(new Set(initialSections.map((s) => s.id)));
    const addedNow = arrived.filter((s) => s.addedAtReviewBy && !isRemovedSection(s)).map((s) => s.id);
    if (addedNow.length > 0) setOpen((prev) => new Set([...Array.from(prev), ...addedNow]));
  }, [initialSections]);
  const allOpen = sections.length > 0 && sections.every((s) => open.has(s.id));
  const allClosed = sections.every((s) => !open.has(s.id));
  const toggle = (id: string) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const [pendingItem, setPendingItem] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [viewer, setViewer] = useState<ChipTarget>({ attachment: null, thread: null });

  const threads = useMemo(
    () => groupMessagesIntoThreads(messages, attachmentsByMessage),
    [messages, attachmentsByMessage]
  );
  const attachmentsById = useMemo(() => new Map(attachments.map((a) => [a.id, a])), [attachments]);

  const chipTarget = useCallback(
    (link: ChecklistLink): ChipTarget => {
      for (const m of link.members) {
        if (m.submissionAttachmentId) {
          const a = attachmentsById.get(m.submissionAttachmentId);
          if (a) return { attachment: a, thread: null };
        }
        if (m.submissionMessageId) {
          const t = threads.find((th) => th.messages.some((msg) => msg.id === m.submissionMessageId));
          if (t) return { attachment: null, thread: t };
        }
      }
      return { attachment: null, thread: null };
    },
    [attachmentsById, threads]
  );

  const tickOpen = !isAgent && canTick && tickOpenFor(status, supersededBy);
  const closedReason = !isAgent && canTick ? versionClosedReason(status, supersededBy) : null;
  // Add is closed on a version that has a newer version, like the tick (C-F).
  const addStatusOpen = ADD_OPEN_STATUSES.includes(status);
  const addOpen = addStatusOpen && supersededBy === null;
  const showAdd = !isAgent && canTick && (addStatusOpen || status === 'needs_changes');
  const pointAtRequestChanges = !isAgent && requestChangesAvailable(status, canDecide);
  const overall = overallRequiredCount(sections, viewerRole);
  const liveSections = sections.filter((s) => !isRemovedSection(s));
  // BACKLOG-3607: remove, undo a removal, and add back what the agent removed
  // are open exactly when Add is (same statuses, not superseded).
  const actOpen = !isAgent && canTick && addOpen;
  const removals = useMemo(() => (isAgent ? [] : agentRemovals(versionHistory)), [isAgent, versionHistory]);
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  const [removeTarget, setRemoveTarget] = useState<ChecklistSectionView | null>(null);

  const onUndoRemove = async (section: ChecklistSectionView) => {
    if (!actOpen || !section.templateId || pendingAction !== null) return;
    setPendingAction(`undo:${section.id}`);
    setError(null);
    try {
      const result = await addChecklistAtReview(submissionId, section.templateId);
      if (!result.ok) {
        setError(result.message);
        return;
      }
      router.refresh();
    } catch {
      setError('Something went wrong. Please try again.');
    } finally {
      setPendingAction(null);
    }
  };

  const onAddBack = async (removal: AgentRemoval) => {
    if (!actOpen || !removal.removedChecklistId || pendingAction !== null) return;
    setPendingAction(`restore:${removal.key}`);
    setError(null);
    try {
      const result = await restoreChecklistAtReview(submissionId, removal.removedChecklistId);
      if (!result.ok) {
        setError(result.message);
        return;
      }
      router.refresh();
    } catch {
      setError('Something went wrong. Please try again.');
    } finally {
      setPendingAction(null);
    }
  };

  const onTick = async (item: ChecklistItemView) => {
    // A disabled checkbox can still deliver a change event (jsdom does); a
    // closed version never calls the RPC from here.
    if (!tickOpen || pendingItem !== null) return;
    setPendingItem(item.id);
    setError(null);
    try {
      const result = await setReviewerCheck(submissionId, item.id, !item.reviewerChecked);
      if (!result.ok) {
        setError(result.message);
        return;
      }
      setSections((prev) =>
        prev.map((s) => ({
          ...s,
          items: s.items.map((i) =>
            i.id === item.id
              ? {
                  ...i,
                  reviewerChecked: result.reviewerChecked,
                  reviewerCheckedBy: result.reviewerChecked ? result.reviewerCheckedBy : null,
                  reviewerCheckedAt: result.reviewerChecked ? result.reviewerCheckedAt : null,
                }
              : i
          ),
        }))
      );
      router.refresh();
    } catch {
      setError('Something went wrong. Please try again.');
    } finally {
      setPendingItem(null);
    }
  };

  return (
    <div className="overflow-hidden rounded-lg border border-gray-200 bg-white shadow-sm" data-testid="checklist-review">
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-3 border-b border-gray-200 px-6 py-4">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-3">
            <h2 className="text-lg font-semibold text-gray-900">Checklists</h2>
            {loaded && liveSections.length > 0 && <RequiredPill count={overall} />}
          </div>
          {loaded && (
            <p className="mt-1 text-sm text-gray-500">
              {liveSections.length} checklist{liveSections.length === 1 ? '' : 's'}
              {liveSections.length !== sections.length && ` · ${sections.length - liveSections.length} removed at review`}
            </p>
          )}
        </div>
        {loaded && (
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => setOpen(new Set(sections.map((s) => s.id)))}
              disabled={allOpen || sections.length === 0}
              className="rounded-md px-2 py-1 text-sm font-medium text-primary-600 hover:text-primary-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 disabled:cursor-not-allowed disabled:text-gray-400"
            >
              Expand all
            </button>
            <span className="text-gray-300" aria-hidden>
              ·
            </span>
            <button
              type="button"
              onClick={() => setOpen(new Set())}
              disabled={allClosed}
              className="rounded-md px-2 py-1 text-sm font-medium text-primary-600 hover:text-primary-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 disabled:cursor-not-allowed disabled:text-gray-400"
            >
              Collapse all
            </button>
            {showAdd && (
              <Button
                variant="primary"
                size="sm"
                onClick={() => setPickerOpen(true)}
                disabled={!addOpen}
                aria-describedby={!addOpen && closedReason ? CLOSED_REASON_ID : undefined}
              >
                <Plus className="h-4 w-4" aria-hidden />
                Add checklist
              </Button>
            )}
          </div>
        )}
        {loaded && closedReason && (showAdd || sections.length > 0) && (
          <p id={CLOSED_REASON_ID} className="basis-full text-sm text-gray-500">
            {closedReason}
          </p>
        )}
      </div>

      {error && (
        <div role="alert" className="border-b border-red-200 bg-red-50 px-6 py-2 text-sm text-red-700">
          {error}
        </div>
      )}

      {loaded && removals.length > 0 && (
        <ul className="border-b border-gray-200 bg-amber-50 px-6 py-3 text-sm text-amber-900" data-testid="agent-removals">
          {removals.map((r) => {
            const live = sections.find((s) => !isRemovedSection(s) && sectionKey(s) === r.key);
            const removedHere = sections.find((s) => isRemovedSection(s) && sectionKey(s) === r.key);
            const who = actorLabel(r.changedBy, nameMap) ?? 'The agent';
            let after: string | null = null;
            if (live) {
              const by = live.restoredFromChecklistId && live.addedAtReviewBy ? actorName(live.addedAtReviewBy, nameMap) : undefined;
              after = live.restoredFromChecklistId ? (by ? `Added back by ${by}.` : 'Added back.') : 'It is on this version again.';
            } else if (removedHere) {
              after = 'It was added back, then removed at review.';
            }
            const offer = !after && actOpen && r.removedChecklistId !== null;
            return (
              <li key={r.key} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-0.5" data-testid="agent-removal">
                <span>
                  {r.addedAtReview ? (
                    <>
                      <strong className="font-semibold">{r.name}</strong>, which was added at review, is not on this version.
                    </>
                  ) : (
                    <>
                      {who} removed <strong className="font-semibold">{r.name}</strong> from this version.
                    </>
                  )}
                  {after && <span className="ml-1 text-amber-800">{after}</span>}
                </span>
                {offer && (
                  <Button
                    variant="secondary"
                    size="sm"
                    disabled={pendingAction !== null}
                    onClick={() => onAddBack(r)}
                    aria-label={`${r.addedAtReview ? 'Add it again' : 'Add it back'}: ${r.name}`}
                  >
                    {pendingAction === `restore:${r.key}` ? (
                      <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
                    ) : r.addedAtReview ? (
                      'Add it again'
                    ) : (
                      'Add it back'
                    )}
                  </Button>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {!loaded ? (
        <p className="px-6 py-6 text-sm text-gray-500">The checklists for this submission could not be loaded. Refresh the page to try again.</p>
      ) : sections.length === 0 ? (
        <p className="px-6 py-6 text-sm text-gray-500">No checklists were submitted with this transaction.</p>
      ) : (
        <div>
          {sections.map((section, idx) => {
            const isOpen = open.has(section.id);
            const bodyId = `checklist-section-${section.id}`;
            const addedBy = section.addedAtReviewBy ? actorName(section.addedAtReviewBy, nameMap) : undefined;
            const removed = isRemovedSection(section);
            const removedBy = removed ? actorName(section.removedAtReviewBy, nameMap) : undefined;
            const sectionTickOpen = tickOpen && !removed;
            return (
              <section key={section.id} className={idx > 0 ? 'border-t border-gray-200' : ''}>
                <button
                  type="button"
                  aria-expanded={isOpen}
                  aria-controls={bodyId}
                  onClick={() => toggle(section.id)}
                  className="flex w-full flex-col items-start gap-2 md:flex-row md:items-center md:justify-between md:gap-3 bg-gray-50 px-6 py-[15px] text-left transition-colors hover:bg-gray-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary-500"
                >
                  <span className="flex min-w-0 items-center gap-2.5">
                    <ChevronRight
                      className={`h-4 w-4 shrink-0 text-gray-400 transition-transform ${isOpen ? 'rotate-90' : ''}`}
                      aria-hidden
                    />
                    <span className="text-[15px] font-semibold text-gray-900">{section.name}</span>
                    {section.addedAtReviewBy && !removed && (
                      <span className="rounded-full bg-purple-100 px-2 py-0.5 text-xs font-medium text-purple-800">Added</span>
                    )}
                    {removed && (
                      <span className="rounded-full bg-gray-200 px-2 py-0.5 text-xs font-medium text-gray-700">
                        Removed at review
                      </span>
                    )}
                  </span>
                  {!removed && <RequiredPill count={requiredCount(section.items, viewerRole)} />}
                </button>
                {isOpen && (
                  <div id={bodyId}>
                    {removed && (
                      <div
                        className="flex flex-wrap items-center justify-between gap-3 bg-gray-100 px-6 py-3 text-[13px] text-gray-700"
                        data-testid="removed-banner"
                      >
                        <p>
                          {removedBy ? (
                            <>
                              Removed by <strong className="font-bold">{removedBy}</strong> at review
                            </>
                          ) : (
                            <>Removed at review</>
                          )}
                          {section.removedAtReviewAt ? ` · ${formatDate(section.removedAtReviewAt)}` : ''}.
                          {isAgent ? ' It is not on your next version.' : ' It is not on the agent’s next version.'}
                        </p>
                        {/* Undo = the add RPC's un-remove ('readded'); it keys on
                            the template, so a checklist with none has no Undo. */}
                        {showAdd && section.templateId && (
                          <Button
                            variant="secondary"
                            size="sm"
                            disabled={!actOpen || pendingAction !== null}
                            onClick={() => onUndoRemove(section)}
                            aria-label={`Undo removal: ${section.name}`}
                            aria-describedby={!actOpen && closedReason ? CLOSED_REASON_ID : undefined}
                          >
                            {pendingAction === `undo:${section.id}` ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : 'Undo'}
                          </Button>
                        )}
                      </div>
                    )}
                    {section.addedAtReviewBy && !removed && (
                      <p className="bg-purple-100 px-6 py-3 text-[13px] text-purple-800">
                        {isAgent ? (
                          addedBy ? (
                            <>
                              Added by <strong className="font-bold">{addedBy}</strong> at review.
                            </>
                          ) : (
                            <>Added at review.</>
                          )
                        ) : addedBy ? (
                          <>
                            Added by <strong className="font-bold">{addedBy}</strong> at review, for the agent’s next version.
                          </>
                        ) : (
                          <>Added at review, for the agent’s next version.</>
                        )}
                        {pointAtRequestChanges && (
                          <span data-testid="added-banner-request-changes">
                            {' Use '}
                            <strong className="font-bold">Request Changes</strong>
                            {' below to send this submission back.'}
                          </span>
                        )}
                      </p>
                    )}
                    {section.items.length === 0 && (
                      <p className="px-6 py-4 text-sm text-gray-500">This checklist has no items.</p>
                    )}
                    {section.items.map((item, itemIdx) => {
                      const reviewedBy = item.reviewerCheckedBy ? actorName(item.reviewerCheckedBy, nameMap) : undefined;
                      // Every item carries the broker's checkbox, including a
                      // checklist added at review (BACKLOG-3596 follow-up): the
                      // tick RPC accepts those items and the carry-over keeps them.
                      const checkbox = !isAgent;
                      const changed = !isAgent && checkbox && changedSinceChecked(item);
                      return (
                        <div
                          key={item.id}
                          data-testid="checklist-item"
                          className={`flex flex-wrap items-start gap-3.5 px-6 py-4 sm:flex-nowrap ${
                            itemIdx > 0 || section.addedAtReviewBy ? 'border-t border-gray-200' : ''
                          }`}
                        >
                          {checkbox ? (
                            <span className="flex h-[22px] shrink-0 items-center">
                              {pendingItem === item.id ? (
                                <Loader2 className="h-[18px] w-[18px] animate-spin text-primary-600" aria-hidden />
                              ) : (
                                <input
                                  type="checkbox"
                                  checked={item.reviewerChecked}
                                  disabled={!sectionTickOpen || pendingItem !== null}
                                  onChange={() => {
                                    if (sectionTickOpen) void onTick(item);
                                  }}
                                  aria-label={`Checked: ${item.title}`}
                                  aria-describedby={closedReason ? CLOSED_REASON_ID : undefined}
                                  className="h-[18px] w-[18px] rounded border-gray-300 text-primary-600 focus:ring-2 focus:ring-primary-500 disabled:cursor-default"
                                />
                              )}
                            </span>
                          ) : (
                            <ItemIcon item={item} />
                          )}
                          <div className="min-w-0 flex-1">
                            <div className="flex flex-wrap items-center gap-2">
                              <span className="text-sm font-medium text-gray-900">{item.title}</span>
                              <span
                                className={`text-[11px] font-semibold uppercase tracking-wide ${
                                  item.isRequired ? 'text-gray-600' : 'text-gray-400'
                                }`}
                              >
                                {item.isRequired ? 'Required' : 'Optional'}
                              </span>
                              {changed && (
                                <span
                                  className="rounded-full border border-amber-200 bg-amber-50 px-2 py-0.5 text-xs font-medium text-amber-700"
                                  data-testid="changed-since-checked"
                                >
                                  Changed since you checked
                                </span>
                              )}
                            </div>
                            {checkbox && item.reviewerChecked && (reviewedBy || item.reviewerCheckedAt) && (
                              <p className="mt-0.5 text-xs text-gray-500" data-testid="reviewer-meta">
                                {[
                                  reviewedBy,
                                  item.reviewerCheckedAt ? formatDate(item.reviewerCheckedAt) : null,
                                  // BACKLOG-3607: a tick carried back with "Add it back".
                                  item.restoredFromItemId
                                    ? typeof version === 'number' && version > 1
                                      ? `restored from version ${version - 1}`
                                      : 'restored from the previous version'
                                    : null,
                                ]
                                  .filter(Boolean)
                                  .join(' · ')}
                              </p>
                            )}
                            {item.description && <p className="mt-1 text-[13px] text-gray-500">{item.description}</p>}
                            {item.note && (
                              <div className="mt-2 rounded-md bg-gray-50 px-3 py-2.5 text-[13px] text-gray-600">{item.note}</div>
                            )}
                            {item.links.length > 0 && (
                              <div className="mt-2.5 flex flex-wrap gap-2">
                                {item.links.map((link) => {
                                  const target = chipTarget(link);
                                  const viewable = !!(target.attachment || target.thread);
                                  const Icon = link.kind === 'email' ? Mail : FileText;
                                  return (
                                    <button
                                      key={link.id}
                                      type="button"
                                      disabled={!viewable}
                                      onClick={() => setViewer(target)}
                                      aria-label={viewable ? `View ${link.label}` : `${link.label} (not available to view)`}
                                      className="inline-flex max-w-full items-center gap-1.5 rounded-md border border-gray-200 bg-white px-2.5 py-1.5 text-xs font-medium text-gray-700 transition-colors hover:border-gray-300 hover:bg-gray-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 disabled:cursor-default disabled:hover:bg-white"
                                    >
                                      <Icon
                                        className={`h-3.5 w-3.5 shrink-0 ${link.kind === 'email' ? 'text-primary-600' : 'text-red-600'}`}
                                        aria-hidden
                                      />
                                      <span className="min-w-0 truncate">{link.label}</span>
                                      {viewable ? (
                                        <span className="shrink-0 font-semibold text-primary-600">View</span>
                                      ) : (
                                        <span className="shrink-0 font-normal text-gray-400">Not available</span>
                                      )}
                                    </button>
                                  );
                                })}
                              </div>
                            )}
                          </div>
                        </div>
                      );
                    })}
                    {/* BACKLOG-3607: the broker removes a checklist at review. */}
                    {!removed && showAdd && (
                      <div className="flex justify-end border-t border-gray-200 px-6 py-2.5" data-testid="remove-row">
                        <button
                          type="button"
                          onClick={() => setRemoveTarget(section)}
                          disabled={!actOpen || pendingAction !== null}
                          aria-label={`Remove checklist: ${section.name}`}
                          aria-describedby={!actOpen && closedReason ? CLOSED_REASON_ID : undefined}
                          className="rounded-md px-2 py-1 text-sm font-medium text-red-600 hover:text-red-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-red-500 disabled:cursor-not-allowed disabled:text-gray-400"
                        >
                          Remove checklist
                        </button>
                      </div>
                    )}
                  </div>
                )}
              </section>
            );
          })}
        </div>
      )}

      {pickerOpen && (
        <AddChecklistPicker
          submissionId={submissionId}
          templates={templates}
          addedTemplateIds={new Set(liveSections.map((s) => s.templateId).filter((id): id is string => !!id))}
          onClose={() => setPickerOpen(false)}
          onAdded={() => {
            setPickerOpen(false);
            router.refresh();
          }}
        />
      )}

      {removeTarget && (
        <RemoveChecklistDialog
          submissionId={submissionId}
          section={removeTarget}
          counts={linkedCounts?.[removeTarget.id]}
          onClose={() => setRemoveTarget(null)}
          onRemoved={() => {
            setRemoveTarget(null);
            router.refresh();
          }}
        />
      )}

      <AttachmentViewerModal
        attachment={viewer.attachment}
        open={!!viewer.attachment}
        onClose={() => setViewer({ attachment: null, thread: null })}
      />
      {viewer.thread && (
        <ConversationModal
          thread={viewer.thread}
          onClose={() => setViewer({ attachment: null, thread: null })}
          attachmentsByMessage={attachmentsByMessage}
        />
      )}
    </div>
  );
}

function AddChecklistPicker({
  submissionId,
  templates,
  addedTemplateIds,
  onClose,
  onAdded,
}: {
  submissionId: string;
  templates: TemplateOption[];
  addedTemplateIds: Set<string>;
  onClose: () => void;
  onAdded: () => void;
}) {
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const add = async (templateId: string) => {
    setPending(templateId);
    setError(null);
    try {
      const result = await addChecklistAtReview(submissionId, templateId);
      if (!result.ok) {
        setError(result.message);
        return;
      }
      onAdded();
    } catch {
      setError('Something went wrong. Please try again.');
    } finally {
      setPending(null);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="add-checklist-title"
        className="flex max-h-[90vh] w-full max-w-[27rem] flex-col overflow-hidden rounded-lg bg-white shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-4 border-b border-gray-200 px-6 py-4">
          <div>
            <h3 id="add-checklist-title" className="text-lg font-semibold text-gray-900">
              Add checklist
            </h3>
            <p className="mt-0.5 text-sm text-gray-500">For the agent’s next version</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="rounded-md p-2 text-gray-400 hover:bg-gray-100 hover:text-gray-600"
          >
            <X className="h-5 w-5" />
          </button>
        </div>
        <div className="overflow-y-auto px-6 pb-6 pt-5">
          <p className="mb-3.5 text-[13px] text-gray-500">
            Checklists already on this submission are marked.
          </p>
          {error && (
            <p role="alert" className="mb-3 rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">
              {error}
            </p>
          )}
          {templates.length === 0 ? (
            <p className="text-sm text-gray-500">Your organization has no checklists to add.</p>
          ) : (
            <ul className="flex flex-col gap-2">
              {templates.map((t) => {
                const added = addedTemplateIds.has(t.id);
                return (
                  <li
                    key={t.id}
                    className={`flex items-center justify-between gap-4 rounded-lg border border-gray-200 px-4 py-3 ${
                      added ? 'bg-gray-50' : 'bg-white'
                    }`}
                  >
                    <span className={`text-sm font-medium ${added ? 'text-gray-400' : 'text-gray-900'}`}>{t.name}</span>
                    {added ? (
                      <span className="inline-flex items-center gap-1 whitespace-nowrap text-xs font-semibold text-gray-400">
                        <CheckCircle2 className="h-3.5 w-3.5 text-green-600" aria-hidden />
                        Added
                      </span>
                    ) : (
                      <Button
                        variant="secondary"
                        size="sm"
                        disabled={pending !== null}
                        onClick={() => add(t.id)}
                        aria-label={`Add ${t.name}`}
                      >
                        {pending === t.id ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : 'Add'}
                      </Button>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * BACKLOG-3607: confirm before removing a checklist at review, with the
 * documents and emails linked to it (founder Q2).
 */
function RemoveChecklistDialog({
  submissionId,
  section,
  counts,
  onClose,
  onRemoved,
}: {
  submissionId: string;
  section: ChecklistSectionView;
  counts: LinkedCounts | undefined;
  onClose: () => void;
  onRemoved: () => void;
}) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !pending) onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose, pending]);

  const confirm = async () => {
    setPending(true);
    setError(null);
    try {
      const result = await removeChecklistAtReview(submissionId, section.id);
      if (!result.ok) {
        setError(result.message);
        return;
      }
      onRemoved();
    } catch {
      setError('Something went wrong. Please try again.');
    } finally {
      setPending(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={pending ? undefined : onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="remove-checklist-title"
        aria-describedby="remove-checklist-text"
        className="w-full max-w-[27rem] overflow-hidden rounded-lg bg-white shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-6 pb-4 pt-5">
          <h3 id="remove-checklist-title" className="text-lg font-semibold text-gray-900">
            Remove {section.name}?
          </h3>
          <p id="remove-checklist-text" className="mt-2 text-sm text-gray-600">
            {removeConfirmText(counts)}
          </p>
          <p className="mt-2 text-sm text-gray-500">It will not be on the agent’s next version. You can undo this while the version is open.</p>
          {error && (
            <p role="alert" className="mt-3 rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">
              {error}
            </p>
          )}
        </div>
        <div className="flex justify-end gap-2 border-t border-gray-200 bg-gray-50 px-6 py-3">
          <Button variant="secondary" size="sm" onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          <Button variant="danger" size="sm" onClick={confirm} disabled={pending}>
            {pending ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : 'Remove'}
          </Button>
        </div>
      </div>
    </div>
  );
}

export default ChecklistReview;
