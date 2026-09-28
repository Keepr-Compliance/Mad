'use client';

/**
 * ChecklistReview — BACKLOG-3477, mock 3481 v4.
 *
 * The Checklists area of the submission review page, between Status History
 * and Messages/Attachments. One card, one collapsible section per checklist.
 *
 * - The agent's ticks and notes are frozen and read-only.
 * - "x of y required" counts the AGENT's ticks on required items
 *   (lib/submissions/checklistModel.ts), per section and overall.
 * - A reviewer (can_review_submission) marks items reviewed through
 *   set_submission_checklist_reviewer_check; the pill shows only on required
 *   and agent-checked rows, never in a checklist added at review.
 * - "Add checklist" adds one of the organization's templates through
 *   add_submission_checklist_at_review. Disabled once changes are requested.
 * - Every attachment / email chip has one View action that opens the
 *   existing viewers: AttachmentViewerModal and MessageList's
 *   ConversationModal (the "View Full" viewer).
 * - viewer="agent" (BACKLOG-3593, My Transactions): the same section, read
 *   only. No tick, no Add, no Request Changes sentence; the reviewer pill is
 *   plain text shown only on rows a reviewer marked.
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
  TICK_OPEN_STATUSES,
  requestChangesAvailable,
  formatRequired,
  overallRequiredCount,
  requiredCount,
  showsReviewerPill,
  type ChecklistItemView,
  type ChecklistLink,
  type ChecklistSectionView,
  type RequiredCount,
  type TemplateOption,
} from '@/lib/submissions/checklistModel';
import { actorName } from '@/lib/submissions/history';
import { addChecklistAtReview, setReviewerCheck } from '@/lib/actions/submissionChecklists';
import { AttachmentViewerModal } from './AttachmentViewerModal';
import {
  ConversationModal,
  groupMessagesIntoThreads,
  type Message,
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
}

/** Copy owned by the coordinator (pm_comments dcc91c87, ruling 2). */
export const ADD_DISABLED_REASON =
  'Changes were requested, so this version is closed. You can add a checklist to the next submission.';

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
}: ChecklistReviewProps) {
  const isAgent = viewerRole === 'agent';
  const router = useRouter();
  const [sections, setSections] = useState<ChecklistSectionView[]>(initialSections);

  const nameMap = useMemo(() => (names ? new Map(Object.entries(names)) : null), [names]);

  // Default: first checklist and any checklist added at review are open (mock v4).
  const [open, setOpen] = useState<Set<string>>(
    () =>
      new Set(
        initialSections.filter((s, idx) => idx === 0 || s.addedAtReviewBy).map((s) => s.id)
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
    const addedNow = arrived.filter((s) => s.addedAtReviewBy).map((s) => s.id);
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

  const threads = useMemo(() => groupMessagesIntoThreads(messages), [messages]);
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

  const tickOpen = !isAgent && canTick && TICK_OPEN_STATUSES.includes(status);
  const addOpen = ADD_OPEN_STATUSES.includes(status);
  const showAdd = !isAgent && canTick && (addOpen || status === 'needs_changes');
  const pointAtRequestChanges = !isAgent && requestChangesAvailable(status, canDecide);
  const overall = overallRequiredCount(sections);

  const onTick = async (item: ChecklistItemView) => {
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
            {loaded && sections.length > 0 && <RequiredPill count={overall} />}
          </div>
          {loaded && (
            <p className="mt-1 text-sm text-gray-500">
              {sections.length} checklist{sections.length === 1 ? '' : 's'}
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
                aria-describedby={!addOpen ? 'checklist-add-disabled-reason' : undefined}
              >
                <Plus className="h-4 w-4" aria-hidden />
                Add checklist
              </Button>
            )}
          </div>
        )}
        {showAdd && !addOpen && (
          <p id="checklist-add-disabled-reason" className="basis-full text-sm text-gray-500">
            {ADD_DISABLED_REASON}
          </p>
        )}
      </div>

      {error && (
        <div role="alert" className="border-b border-red-200 bg-red-50 px-6 py-2 text-sm text-red-700">
          {error}
        </div>
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
            return (
              <section key={section.id} className={idx > 0 ? 'border-t border-gray-200' : ''}>
                <button
                  type="button"
                  aria-expanded={isOpen}
                  aria-controls={bodyId}
                  onClick={() => toggle(section.id)}
                  className="flex w-full items-center justify-between gap-3 bg-gray-50 px-6 py-[15px] text-left transition-colors hover:bg-gray-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary-500"
                >
                  <span className="flex min-w-0 items-center gap-2.5">
                    <ChevronRight
                      className={`h-4 w-4 shrink-0 text-gray-400 transition-transform ${isOpen ? 'rotate-90' : ''}`}
                      aria-hidden
                    />
                    <span className="text-[15px] font-semibold text-gray-900">{section.name}</span>
                    {section.addedAtReviewBy && (
                      <span className="rounded-full bg-purple-100 px-2 py-0.5 text-xs font-medium text-purple-800">Added</span>
                    )}
                  </span>
                  <RequiredPill count={requiredCount(section.items)} />
                </button>
                {isOpen && (
                  <div id={bodyId}>
                    {section.addedAtReviewBy && (
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
                      const gap = item.isRequired && !item.isChecked && !section.addedAtReviewBy;
                      const reviewedBy = item.reviewerCheckedBy ? actorName(item.reviewerCheckedBy, nameMap) : undefined;
                      const pill = showsReviewerPill(section, item);
                      return (
                        <div
                          key={item.id}
                          data-testid="checklist-item"
                          className={`flex flex-wrap items-start gap-3.5 px-6 py-4 sm:flex-nowrap ${
                            itemIdx > 0 || section.addedAtReviewBy ? 'border-t border-gray-200' : ''
                          }`}
                        >
                          <ItemIcon item={item} />
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
                              {gap && <span className="text-xs font-medium text-amber-700">Not yet checked</span>}
                            </div>
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
                          {isAgent && pill && item.reviewerChecked && (
                            <div
                              className="flex w-full shrink-0 flex-row items-center gap-2 sm:w-auto sm:flex-col sm:items-end sm:gap-1.5"
                              data-testid="reviewer-status"
                            >
                              <span className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border border-primary-500 bg-primary-100 px-[11px] py-[5px] text-xs font-semibold text-primary-800">
                                <CheckCircle2 className="h-3.5 w-3.5" aria-hidden />
                                Reviewed
                              </span>
                              {(reviewedBy || item.reviewerCheckedAt) && (
                                <p className="text-[11px] text-gray-400 sm:text-right" data-testid="reviewer-meta">
                                  {[reviewedBy, item.reviewerCheckedAt ? formatDate(item.reviewerCheckedAt) : null]
                                    .filter(Boolean)
                                    .join(' · ')}
                                </p>
                              )}
                            </div>
                          )}
                          {!isAgent && pill && (item.reviewerChecked || tickOpen) && (
                            <div className="flex w-full shrink-0 flex-row items-center gap-2 sm:w-auto sm:flex-col sm:items-end sm:gap-1.5">
                              <button
                                type="button"
                                aria-pressed={item.reviewerChecked}
                                disabled={!tickOpen || pendingItem !== null}
                                onClick={() => onTick(item)}
                                className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border px-[11px] py-[5px] text-xs font-semibold transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 disabled:cursor-default ${
                                  item.reviewerChecked
                                    ? 'border-primary-500 bg-primary-100 text-primary-800'
                                    : 'border-gray-300 bg-white text-gray-500 hover:border-primary-500 hover:text-primary-700'
                                }`}
                              >
                                {pendingItem === item.id ? (
                                  <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
                                ) : (
                                  <CheckCircle2 className="h-3.5 w-3.5" aria-hidden />
                                )}
                                {item.reviewerChecked ? 'Reviewed' : 'Mark reviewed'}
                              </button>
                              {item.reviewerChecked && (reviewedBy || item.reviewerCheckedAt) && (
                                <p className="text-[11px] text-gray-400 sm:text-right" data-testid="reviewer-meta">
                                  {[reviewedBy, item.reviewerCheckedAt ? formatDate(item.reviewerCheckedAt) : null]
                                    .filter(Boolean)
                                    .join(' · ')}
                                </p>
                              )}
                            </div>
                          )}
                        </div>
                      );
                    })}
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
          addedTemplateIds={new Set(sections.map((s) => s.templateId).filter((id): id is string => !!id))}
          onClose={() => setPickerOpen(false)}
          onAdded={() => {
            setPickerOpen(false);
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
        <ConversationModal thread={viewer.thread} onClose={() => setViewer({ attachment: null, thread: null })} />
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
            Checklists already on this submission are marked. An added checklist can’t be removed.
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

export default ChecklistReview;
