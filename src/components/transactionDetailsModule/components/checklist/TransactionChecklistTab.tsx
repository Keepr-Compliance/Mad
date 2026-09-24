/**
 * TransactionChecklistTab — BACKLOG-3476.
 *
 * The Checklist tab's panel. TransactionDetails owns the checklist hook and the
 * plan state and passes them in, so the tab, its button and the Overview line
 * all read one answer.
 *
 * | plan      | checklist | this panel                                         |
 * |-----------|-----------|----------------------------------------------------|
 * | allowed   | none      | template chooser (mock state 1)                    |
 * | allowed   | exists    | the checklist (mock state 2)                       |
 * | blocked   | exists    | read-only + notice + Remove checklist              |
 * | unknown   | exists    | read-only + notice                                 |
 * | pending / blocked / unknown with none: the tab is not shown at all         |
 *
 * Read-only exists because `checklists:get` and `checklists:remove` are
 * deliberately ungated in main: a user whose plan dropped checklists can still
 * see, and take off, what they made. Every other write is refused by main
 * whatever this screen shows; the screen only avoids offering it.
 *
 * A failed read shows an error and Retry, never the chooser: "no checklist
 * yet" would be a false statement about this transaction.
 */
import React, { useCallback, useMemo, useState } from "react";
import type { ApiResult } from "../../../../services";
import type {
  ChecklistItem,
  ChecklistTemplate,
  SelectChecklistTemplateResult,
} from "../../../../../electron/types/checklist";
import type { StrictFeatureStateOrPending } from "../../../../hooks/useStrictFeatureState";
import type { UseTransactionChecklistResult } from "../../hooks/useTransactionChecklist";
import type { UnifiedAttachment } from "../../hooks/useTransactionAllAttachments";
import type { Communication, HighlightTarget, TransactionTab } from "../../types";
import { ChecklistTemplateChooser } from "./ChecklistTemplateChooser";
import { ChecklistProgress } from "./ChecklistProgress";
import { ChecklistItemRow } from "./ChecklistItemRow";
import { ChangeTemplateConfirm } from "./ChangeTemplateConfirm";
import { ChecklistLinkPicker } from "./ChecklistLinkPicker";
import { checklistLoss, linkableThreads } from "../../utils/checklistLinks";

const CHANGE_WARNING = "Changing the template clears every check, note and link on this list.";

export interface TransactionChecklistTabProps {
  checklist: UseTransactionChecklistResult;
  gate: StrictFeatureStateOrPending;
  attachments: UnifiedAttachment[];
  attachmentsLoading: boolean;
  emailCommunications: Communication[];
  ensureEmailsLoaded: () => Promise<void>;
  onRefreshLinkTargets: () => void;
  onNavigateToTab: (payload: { tab: TransactionTab; highlight?: HighlightTarget }) => void;
  onShowSuccess: (message: string) => void;
  onShowError: (message: string) => void;
  userEmail?: string;
  nameMap?: ReadonlyMap<string, string>;
}

export function TransactionChecklistTab({
  checklist,
  gate,
  attachments,
  attachmentsLoading,
  emailCommunications,
  ensureEmailsLoaded,
  onRefreshLinkTargets,
  onNavigateToTab,
  onShowSuccess,
  onShowError,
  userEmail,
  nameMap,
}: TransactionChecklistTabProps): React.ReactElement | null {
  const { state, detail } = checklist;
  const readOnly = gate !== "allowed";
  const [mode, setMode] = useState<"view" | "replace">("view");
  const [confirmTemplate, setConfirmTemplate] = useState<ChecklistTemplate | null>(null);
  const [busy, setBusy] = useState(false);
  const [templatesRefreshKey, setTemplatesRefreshKey] = useState(0);
  const [pickerItem, setPickerItem] = useState<ChecklistItem | null>(null);
  const [confirmingRemove, setConfirmingRemove] = useState(false);

  const attachmentsById = useMemo(() => new Map(attachments.map((a) => [a.id, a])), [attachments]);
  const threads = useMemo(() => linkableThreads(emailCommunications), [emailCommunications]);

  const handleSelectResult = useCallback(
    (result: ApiResult<SelectChecklistTemplateResult>): boolean => {
      if (!result.success || !result.data) {
        onShowError(result.error ?? "The checklist could not be started.");
        // The template may have been archived since it was listed.
        setTemplatesRefreshKey((k) => k + 1);
        return false;
      }
      switch (result.data.status) {
        case "selected":
        case "replaced":
        case "exists":
          // `exists`: another window picked first. The reload that followed the
          // write already shows that checklist; nothing was lost.
          return true;
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
      if (mode === "replace") {
        // Nothing is written until the confirmation says so.
        setConfirmTemplate(template);
        return;
      }
      setBusy(true);
      try {
        handleSelectResult(await checklist.pickTemplate(template.id));
      } finally {
        setBusy(false);
      }
    },
    [mode, checklist, handleSelectResult],
  );

  const handleConfirmReplace = useCallback(async () => {
    if (!confirmTemplate) return;
    setBusy(true);
    try {
      const ok = handleSelectResult(await checklist.replaceTemplate(confirmTemplate.id));
      setConfirmTemplate(null);
      if (ok) setMode("view");
    } finally {
      setBusy(false);
    }
  }, [confirmTemplate, checklist, handleSelectResult]);

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

  const handleRemoveChecklist = useCallback(async () => {
    setBusy(true);
    try {
      const result = await checklist.remove();
      if (!result.success) onShowError(result.error ?? "Could not remove the checklist.");
      else onShowSuccess("Checklist removed");
    } finally {
      setBusy(false);
      setConfirmingRemove(false);
    }
  }, [checklist, onShowError, onShowSuccess]);

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

  if (!detail) {
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

  if (mode === "replace" && !readOnly) {
    return (
      <>
        <ChecklistTemplateChooser
          mode="replace"
          onPick={(t) => void handlePick(t)}
          onCancel={() => setMode("view")}
          busy={busy}
          refreshKey={templatesRefreshKey}
        />
        {confirmTemplate && (
          <ChangeTemplateConfirm
            currentName={detail.checklist.templateName}
            newName={confirmTemplate.name}
            isReset={confirmTemplate.id === detail.checklist.templateId}
            loss={checklistLoss(detail)}
            busy={busy}
            onConfirm={() => void handleConfirmReplace()}
            onCancel={() => setConfirmTemplate(null)}
          />
        )}
      </>
    );
  }

  return (
    <div data-testid="checklist-panel">
      {readOnly && (
        <div
          className="mb-4 p-3 bg-amber-50 border border-amber-200 rounded-lg text-sm text-amber-800 flex items-start justify-between gap-3 flex-wrap"
          data-testid="checklist-readonly-notice"
        >
          <span>
            {gate === "blocked"
              ? "Checklists aren’t included in your current plan. You can still view this checklist or remove it."
              : "We couldn’t confirm your plan just now. You can still view this checklist."}
          </span>
          {gate === "blocked" &&
            (confirmingRemove ? (
              <span className="flex items-center gap-3">
                <span>Remove this checklist?</span>
                <button
                  type="button"
                  onClick={() => void handleRemoveChecklist()}
                  disabled={busy}
                  className="font-semibold text-red-700 hover:text-red-900"
                  data-testid="checklist-remove-confirm"
                >
                  Remove
                </button>
                <button
                  type="button"
                  onClick={() => setConfirmingRemove(false)}
                  disabled={busy}
                  className="font-medium text-gray-700"
                >
                  Cancel
                </button>
              </span>
            ) : (
              <button
                type="button"
                onClick={() => setConfirmingRemove(true)}
                className="font-semibold text-amber-900 hover:underline"
                data-testid="checklist-remove"
              >
                Remove checklist
              </button>
            ))}
        </div>
      )}

      <div className="flex items-start justify-between gap-3 flex-wrap mb-2">
        <div>
          <h4 className="text-lg font-semibold text-gray-900" data-testid="checklist-template-name">
            {detail.checklist.templateName}
          </h4>
          <p className="text-xs text-gray-400 mt-1">
            From your brokerage &middot; {detail.items.length} item{detail.items.length === 1 ? "" : "s"}
          </p>
        </div>
        {!readOnly && (
          <button
            type="button"
            onClick={() => setMode("replace")}
            title={CHANGE_WARNING}
            className="flex items-center gap-2 px-3 py-1.5 text-sm font-medium text-blue-600 hover:text-blue-800 hover:bg-blue-50 rounded-lg"
            data-testid="checklist-change-template"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"
              />
            </svg>
            Change template
          </button>
        )}
      </div>

      <div className="bg-gray-50 border border-gray-200 rounded-lg px-4 py-3 mb-6">
        <ChecklistProgress requiredDone={detail.requiredDone} requiredTotal={detail.requiredTotal} />
        {!readOnly && <p className="text-xs text-gray-400 mt-1">{CHANGE_WARNING}</p>}
      </div>

      <div className="flex flex-col gap-3">
        {[...detail.items]
          .sort((a, b) => a.sortOrder - b.sortOrder)
          .map((item) => (
            <ChecklistItemRow
              key={item.id}
              item={item}
              links={detail.linksByItemId[item.id] ?? []}
              readOnly={readOnly}
              pending={checklist.pendingItemIds.has(item.id)}
              attachmentsById={attachmentsById}
              threads={threads}
              onToggle={(i) => void handleToggle(i)}
              onSaveNote={handleSaveNote}
              onOpenPicker={setPickerItem}
              onRemoveLink={handleRemoveLink}
              onNavigate={onNavigateToTab}
            />
          ))}
      </div>

      {pickerItem && !readOnly && (
        <ChecklistLinkPicker
          item={pickerItem}
          templateName={detail.checklist.templateName}
          existingLinks={detail.linksByItemId[pickerItem.id] ?? []}
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
