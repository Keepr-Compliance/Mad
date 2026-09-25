/**
 * TransactionChecklistTab — BACKLOG-3476.
 *
 * The Checklist tab's panel. A transaction may carry several checklists, each
 * from a different broker template; each renders as a `ChecklistSection`.
 * TransactionDetails owns the checklist hook and the plan state and passes them
 * in, so the tab, its button and the Overview line all read one answer.
 *
 * | plan      | checklists | this panel                                           |
 * |-----------|------------|-------------------------------------------------------|
 * | allowed   | none       | template chooser                                     |
 * | allowed   | 1+         | summed progress, Add checklist; each section: Remove |
 * | blocked   | 1+         | read-only + notice; each section: Remove only        |
 * | unknown   | 1+         | read-only + notice                                   |
 * | pending / blocked / unknown with none: the tab is not shown at all                  |
 *
 * BACKLOG-3476 round 2: there is no Change. A checklist already on the
 * transaction can only be taken off with Remove; Add and Remove together do
 * what Change did.
 *
 * Read-only exists because `checklists:get` and `checklists:remove` are
 * deliberately ungated in main: a user whose plan dropped checklists can still
 * see, and take off, what they made. Every other write is refused by main
 * whatever this screen shows; the screen only avoids offering it.
 *
 * Sections open by default. A checklist whose items are ALL ticked (optional
 * ones included, `allItemsChecked` from main) opens collapsed. That initial
 * state is decided once per checklist id, when its data first arrives, so
 * ticking the last box does not snap a section shut and a collapsed section
 * can always be opened. Nothing is remembered between opens.
 *
 * A failed read shows an error and Retry, never the chooser: "no checklist
 * yet" would be a false statement about this transaction.
 *
 * Each evidence chip's View opens the linked item here, over the tab: an
 * attachment through the shared `useAttachmentPreview` flow (downloaded on
 * demand when only its metadata is present), an email link as ONE thread made
 * of its members still on the transaction (`threadForLink`).
 */
import React, { useCallback, useEffect, useMemo, useState } from "react";
import { useAuth } from "../../../../contexts/AuthContext";
import type { ApiResult } from "../../../../services";
import type {
  ChecklistDetail,
  ChecklistItem,
  ChecklistLink,
  ChecklistTemplate,
  SelectChecklistTemplateResult,
} from "../../../../../electron/types/checklist";
import type { StrictFeatureStateOrPending } from "../../../../hooks/useStrictFeatureState";
import type { UseTransactionChecklistResult } from "../../hooks/useTransactionChecklist";
import type { UnifiedAttachment } from "../../hooks/useTransactionAllAttachments";
import { AttachmentPreviewHost, useAttachmentPreview } from "../../hooks/useAttachmentPreview";
import type { Communication } from "../../types";
import { EmailThreadViewModal } from "../modals/EmailThreadViewModal";
import type { ChecklistLinkViewer } from "./ChecklistLinkChip";
import { ChecklistTemplateChooser } from "./ChecklistTemplateChooser";
import { ChecklistProgress } from "./ChecklistProgress";
import { ChecklistSection } from "./ChecklistSection";
import { ChecklistLinkPicker } from "./ChecklistLinkPicker";
import { linkableThreads, threadForLink } from "../../utils/checklistLinks";

export const ALREADY_ON_TRANSACTION_ERROR = "That checklist is already on this transaction.";

export interface TransactionChecklistTabProps {
  checklist: UseTransactionChecklistResult;
  gate: StrictFeatureStateOrPending;
  attachments: UnifiedAttachment[];
  attachmentsLoading: boolean;
  emailCommunications: Communication[];
  ensureEmailsLoaded: () => Promise<void>;
  /** Refetch attachments (and loaded emails): after a refused link, or an on-demand download. */
  onRefreshLinkTargets: () => void;
  onShowSuccess: (message: string) => void;
  onShowError: (message: string) => void;
  nameMap?: ReadonlyMap<string, string>;
}

/** Whether the "add a checklist" chooser is open. */
type ChooserState = { mode: "add" } | null;

export function TransactionChecklistTab({
  checklist,
  gate,
  attachments,
  attachmentsLoading,
  emailCommunications,
  ensureEmailsLoaded,
  onRefreshLinkTargets,
  onShowSuccess,
  onShowError,
  nameMap,
}: TransactionChecklistTabProps): React.ReactElement | null {
  const { state, data } = checklist;
  // The Emails tab's source for "You" in a thread (TransactionEmailsTab).
  const { currentUser } = useAuth();
  const userEmail = currentUser?.email;
  const readOnly = gate !== "allowed";
  const [chooser, setChooser] = useState<ChooserState>(null);
  const [busy, setBusy] = useState(false);
  const [templatesRefreshKey, setTemplatesRefreshKey] = useState(0);
  const [pickerItem, setPickerItem] = useState<ChecklistItem | null>(null);

  const details = useMemo(() => data?.checklists ?? [], [data]);

  // Q2: each section's first state, decided ONCE per checklist id when its
  // data first arrives, then only the user's toggle changes it.
  const [initialExpanded, setInitialExpanded] = useState<Record<string, boolean>>({});
  const [toggledExpanded, setToggledExpanded] = useState<Record<string, boolean>>({});
  const unseen = useMemo(
    () => details.filter((d) => !(d.checklist.id in initialExpanded)),
    [details, initialExpanded],
  );
  useEffect(() => {
    if (unseen.length === 0) return;
    setInitialExpanded((prev) => {
      const next = { ...prev };
      for (const d of unseen) {
        if (!(d.checklist.id in next)) next[d.checklist.id] = !d.allItemsChecked;
      }
      return next;
    });
  }, [unseen]);
  const isExpanded = useCallback(
    (detail: ChecklistDetail): boolean =>
      toggledExpanded[detail.checklist.id] ??
      initialExpanded[detail.checklist.id] ??
      // The first frame before the effect above has recorded it: the same
      // rule, so the section does not flash open and shut.
      !detail.allItemsChecked,
    [toggledExpanded, initialExpanded],
  );
  const toggleExpanded = useCallback(
    (checklistId: string) => {
      const detail = details.find((d) => d.checklist.id === checklistId);
      if (!detail) return;
      const current = isExpanded(detail);
      setToggledExpanded((prev) => ({ ...prev, [checklistId]: !current }));
    },
    [details, isExpanded],
  );

  // ---- View on a chip ----------------------------------------------------
  const attachmentPreview = useAttachmentPreview(onRefreshLinkTargets);
  const { open: openAttachment, downloadingId, message: previewMessage } = attachmentPreview;
  useEffect(() => {
    if (previewMessage) onShowError(previewMessage);
  }, [previewMessage, onShowError]);

  // The thread is built at render from the CURRENT emails, so a View that
  // first had to load them shows what arrived, not what the click saw.
  const [viewingLink, setViewingLink] = useState<ChecklistLink | null>(null);
  const viewingThread = useMemo(
    () => (viewingLink ? threadForLink(viewingLink, emailCommunications) : null),
    [viewingLink, emailCommunications],
  );
  const viewer = useMemo<ChecklistLinkViewer>(
    () => ({
      onViewAttachment: (attachment) => void openAttachment(attachment),
      downloadingAttachmentId: downloadingId,
      onViewThread: async (link) => {
        await ensureEmailsLoaded();
        setViewingLink(link);
      },
    }),
    [openAttachment, downloadingId, ensureEmailsLoaded],
  );

  const attachmentsById = useMemo(() => new Map(attachments.map((a) => [a.id, a])), [attachments]);
  const threads = useMemo(() => linkableThreads(emailCommunications), [emailCommunications]);
  const templateIdsOnTransaction = useMemo(
    () => new Set(details.map((d) => d.checklist.templateId)),
    [details],
  );

  // A thread chip names its participants from the Emails list. Load it
  // (silently) when some chip needs it; otherwise the chip shows the count only.
  const hasEmailLinks = useMemo(
    () =>
      details.some((d) =>
        Object.values(d.linksByItemId).some((links) => links.some((l) => l.kind === "email")),
      ),
    [details],
  );
  useEffect(() => {
    if (hasEmailLinks) void ensureEmailsLoaded();
  }, [hasEmailLinks, ensureEmailsLoaded]);

  const handleSelectResult = useCallback(
    (result: ApiResult<SelectChecklistTemplateResult>): boolean => {
      if (!result.success || !result.data) {
        onShowError(result.error ?? "The checklist could not be started.");
        // The template may have been archived since it was listed.
        setTemplatesRefreshKey((k) => k + 1);
        return false;
      }
      switch (result.data.status) {
        case "added":
          return true;
        case "exists":
          // Another window added it first, or the listing was stale. The
          // reload that followed the write already shows it; nothing was lost.
          onShowError(ALREADY_ON_TRANSACTION_ERROR);
          return false;
        case "no_transaction":
          onShowError("This transaction no longer exists.");
          return false;
        default: {
          const exhaustive: never = result.data;
          return exhaustive;
        }
      }
    },
    [onShowError],
  );

  const handlePick = useCallback(
    async (template: ChecklistTemplate) => {
      setBusy(true);
      try {
        // Always an add: no checklist id is sent, so nothing already here can
        // change (BACKLOG-3476 round 2: Change is gone).
        if (handleSelectResult(await checklist.addChecklist(template.id))) setChooser(null);
      } finally {
        setBusy(false);
      }
    },
    [checklist, handleSelectResult],
  );

  const handleToggle = useCallback(
    async (item: ChecklistItem) => {
      const result = await checklist.setItemChecked(item.id, !item.isChecked);
      if (result && !result.success) onShowError(result.error ?? "Could not update this item.");
    },
    [checklist, onShowError],
  );

  const handleSaveNote = useCallback(
    async (itemId: string, note: string | null) => {
      const result = await checklist.setItemNote(itemId, note);
      if (!result.success) {
        onShowError(result.error ?? "Could not save the note.");
        return false;
      }
      return true;
    },
    [checklist, onShowError],
  );

  const handleRemoveLink = useCallback(
    async (linkId: string) => {
      const result = await checklist.removeLink(linkId);
      if (!result.success) onShowError(result.error ?? "Could not remove the link.");
    },
    [checklist, onShowError],
  );

  const handleRemoveChecklist = useCallback(
    async (checklistId: string) => {
      setBusy(true);
      try {
        const result = await checklist.removeChecklist(checklistId);
        if (!result.success) onShowError(result.error ?? "Could not remove the checklist.");
        else onShowSuccess("Checklist removed");
      } finally {
        setBusy(false);
      }
    },
    [checklist, onShowError, onShowSuccess],
  );

  if (state.status === "loading") {
    return (
      <div className="text-center py-12" data-testid="checklist-loading">
        <div className="w-8 h-8 border-4 border-blue-600 border-t-transparent rounded-full animate-spin mx-auto" />
      </div>
    );
  }

  if (state.status === "error") {
    return (
      <div className="text-center py-12" data-testid="checklist-error">
        <p className="text-red-600 mb-3">{state.error}</p>
        <button
          type="button"
          onClick={() => void checklist.reload()}
          className="px-4 py-2 text-sm font-medium text-blue-600 border border-blue-200 rounded-lg hover:bg-blue-50"
          data-testid="checklist-retry"
        >
          Retry
        </button>
      </div>
    );
  }

  if (details.length === 0) {
    // Without the plan there is nothing to start; the tab is hidden in that
    // case, so this only guards a render between two answers.
    if (readOnly) return null;
    return (
      <ChecklistTemplateChooser
        mode="pick"
        onPick={(t) => void handlePick(t)}
        busy={busy}
        refreshKey={templatesRefreshKey}
      />
    );
  }

  if (chooser && !readOnly) {
    // Templates already on this transaction cannot be added again.
    return (
      <ChecklistTemplateChooser
        mode={chooser.mode}
        disabledTemplateIds={templateIdsOnTransaction}
        onPick={(t) => void handlePick(t)}
        onCancel={() => setChooser(null)}
        busy={busy}
        refreshKey={templatesRefreshKey}
      />
    );
  }

  const pickerDetail = pickerItem
    ? details.find((d) => d.checklist.id === pickerItem.checklistId) ?? null
    : null;

  return (
    <div data-testid="checklist-panel">
      {readOnly && (
        <div
          className="mb-4 p-3 bg-amber-50 border border-amber-200 rounded-lg text-sm text-amber-800"
          data-testid="checklist-readonly-notice"
        >
          {gate === "blocked"
            ? "Checklists aren’t included in your current plan. You can still view these checklists or remove them."
            : "We couldn’t confirm your plan just now. You can still view these checklists."}
        </div>
      )}

      <div className="flex items-center justify-between gap-3 flex-wrap mb-2">
        <h4 className="text-lg font-semibold text-gray-900">Checklists</h4>
        {!readOnly && (
          <button
            type="button"
            onClick={() => setChooser({ mode: "add" })}
            disabled={busy}
            className="flex items-center gap-2 px-3 py-1.5 text-sm font-medium text-blue-600 hover:text-blue-800 hover:bg-blue-50 rounded-lg"
            data-testid="checklist-add"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
            </svg>
            Add checklist
          </button>
        )}
      </div>

      {data && (
        <div
          className="bg-gray-50 border border-gray-200 rounded-lg px-4 py-3 mb-6"
          data-testid="checklist-total-progress"
        >
          <ChecklistProgress requiredDone={data.requiredDone} requiredTotal={data.requiredTotal} />
        </div>
      )}

      <div className="flex flex-col gap-4">
        {details.map((detail) => (
          <ChecklistSection
            key={detail.checklist.id}
            detail={detail}
            expanded={isExpanded(detail)}
            onToggleExpanded={toggleExpanded}
            readOnly={readOnly}
            canRemove={gate === "allowed" || gate === "blocked"}
            busy={busy}
            pendingItemIds={checklist.pendingItemIds}
            attachmentsById={attachmentsById}
            threads={threads}
            onRemove={handleRemoveChecklist}
            onToggleItem={(i) => void handleToggle(i)}
            onSaveNote={handleSaveNote}
            onOpenPicker={setPickerItem}
            onRemoveLink={handleRemoveLink}
            viewer={viewer}
          />
        ))}
      </div>

      <AttachmentPreviewHost preview={attachmentPreview} />
      {viewingThread && (
        <EmailThreadViewModal
          thread={viewingThread}
          onClose={() => setViewingLink(null)}
          userEmail={userEmail}
          nameMap={nameMap}
        />
      )}

      {pickerItem && pickerDetail && !readOnly && (
        <ChecklistLinkPicker
          item={pickerItem}
          templateName={pickerDetail.checklist.templateName}
          existingLinks={pickerDetail.linksByItemId[pickerItem.id] ?? []}
          attachments={attachments}
          attachmentsLoading={attachmentsLoading}
          emailCommunications={emailCommunications}
          ensureEmailsLoaded={ensureEmailsLoaded}
          onLink={(requests) => checklist.addLinks(pickerItem.id, requests)}
          onRefreshTargets={onRefreshLinkTargets}
          onClose={() => setPickerItem(null)}
          onShowSuccess={onShowSuccess}
          onShowError={onShowError}
          userEmail={userEmail}
          nameMap={nameMap}
        />
      )}
    </div>
  );
}

export default TransactionChecklistTab;
