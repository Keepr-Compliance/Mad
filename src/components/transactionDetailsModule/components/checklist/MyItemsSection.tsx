/**
 * MyItemsSection — BACKLOG-3966 U1, the agent's own items on the Checklist tab.
 *
 * One private checklist per deal ("My items"), drawn at the top of the tab on
 * EVERY plan. Only the agent sees it: main never sends it to the broker and
 * leaves it out of exports (BACKLOG-3966 PR-1). Every item counts in the
 * agent's own numbers (main writes `is_required = 1`), so a row carries no
 * Required/Optional pill.
 *
 * | what               | how                                                     |
 * |--------------------|---------------------------------------------------------|
 * | add                | the input + Add (or Enter) → `checklists:add-my-item`   |
 * | rename             | ⋯ → Rename, Enter saves, Escape cancels → `rename-my-item` |
 * | reorder            | drag the handle, or ⋯ → Move up / Move down → `reorder-my-items` |
 * | tick, note, link   | the template rows' channels (main allows them on every plan) |
 * | delete             | ⋯ → Delete, then a one-line confirm → `remove-my-item`  |
 *
 * `detail` is null when main returned no private checklist: the agent has not
 * added an item yet. The section still renders (empty), and the first add
 * creates the checklist in main.
 *
 * Writes are shown at once (optimistic) and main is asked again afterwards
 * (the hook's one `get`). A refusal puts the screen back and says why in one
 * line under the header. A refusal because the deal is locked (`dealLocked`,
 * BACKLOG-3910d) also makes the rows read-only from then on.
 *
 * Counts are main's (`requiredDone` / `requiredTotal`), never computed here.
 */
import React, { useCallback, useMemo, useRef, useState } from "react";
import { Button, Card } from "@keepr/ui";
import type {
  ChecklistDetail,
  ChecklistItem,
} from "../../../../../electron/types/checklist";
import type { ChecklistWriteApiResult } from "../../../../services/checklistService";
import type { UnifiedAttachment } from "../../hooks/useTransactionAllAttachments";
import type { EmailThread } from "../EmailThreadCard";
import type { ChecklistLinkViewer } from "./ChecklistLinkChip";
import { ChecklistItemRow } from "./ChecklistItemRow";

/** `MyItemTitleSchema` (electron/schemas/checklist.ts) refuses longer titles. */
export const MY_ITEM_TITLE_MAX_LENGTH = 300;

export const MY_ITEMS_PRIVACY_LINE = "Only you see this. Not sent to the broker, not exported.";
export const MY_ITEMS_EMPTY_LINE = "Add your first item.";
export const MY_ITEMS_LOCKED_LINE = "This deal is locked, so your items can’t be changed.";

type Write<T> = Promise<ChecklistWriteApiResult<T>>;

export interface MyItemsSectionProps {
  /** Main's private checklist for this deal, or null when it has none yet. */
  detail: ChecklistDetail | null;
  /** The deal is locked (BACKLOG-3910): every My-items write is off. */
  locked: boolean;
  lockedTooltip?: string;
  /**
   * The template chooser is on screen (its Add is that view's one primary
   * button), so this section's Add draws as the kit secondary button.
   */
  chooserShowing?: boolean;
  pendingItemIds: ReadonlySet<string>;
  attachmentsById: ReadonlyMap<string, UnifiedAttachment>;
  threads: EmailThread[];
  viewer: ChecklistLinkViewer;
  onAdd: (title: string) => Write<unknown>;
  onRename: (itemId: string, title: string) => Write<boolean>;
  onReorder: (itemIds: string[]) => Write<unknown>;
  onRemove: (itemId: string) => Write<boolean>;
  /** `null`: the tick was ignored (a write for it is already in flight). */
  onSetChecked: (itemId: string, checked: boolean) => Promise<ChecklistWriteApiResult<boolean> | null>;
  onSaveNote: (itemId: string, note: string | null) => Promise<boolean>;
  onOpenPicker: (item: ChecklistItem) => void;
  onRemoveLink: (linkId: string) => Promise<void>;
}

/** What the screen shows ahead of main's answer. Cleared when the write settles. */
interface Overlay {
  order: string[] | null;
  titles: Record<string, string>;
  hidden: ReadonlySet<string>;
  checked: Record<string, boolean>;
  adding: string | null;
}

const EMPTY_OVERLAY: Overlay = { order: null, titles: {}, hidden: new Set(), checked: {}, adding: null };

function move<T>(list: T[], from: number, to: number): T[] {
  const next = [...list];
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved);
  return next;
}

export function MyItemsSection({
  detail,
  locked,
  lockedTooltip,
  chooserShowing = false,
  pendingItemIds,
  attachmentsById,
  threads,
  viewer,
  onAdd,
  onRename,
  onReorder,
  onRemove,
  onSetChecked,
  onSaveNote,
  onOpenPicker,
  onRemoveLink,
}: MyItemsSectionProps): React.ReactElement {
  const [overlay, setOverlay] = useState<Overlay>(EMPTY_OVERLAY);
  const [error, setError] = useState<string | null>(null);
  // A write main refused because the deal is locked: read-only from here on.
  const [lockedByRefusal, setLockedByRefusal] = useState(false);
  const readOnly = locked || lockedByRefusal;
  const [draft, setDraft] = useState("");
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const [menuId, setMenuId] = useState<string | null>(null);
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const [dragId, setDragId] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(true);
  const bodyId = "my-items-body";
  const addInputRef = useRef<HTMLInputElement>(null);

  const items = useMemo(() => {
    const base = [...(detail?.items ?? [])].sort((a, b) => a.sortOrder - b.sortOrder);
    const byId = new Map(base.map((i) => [i.id, i]));
    const ordered = overlay.order
      ? overlay.order.map((id) => byId.get(id)).filter((i): i is ChecklistItem => !!i)
      : base;
    return ordered
      .filter((i) => !overlay.hidden.has(i.id))
      .map((i) => (overlay.titles[i.id] !== undefined ? { ...i, title: overlay.titles[i.id] } : i));
  }, [detail, overlay]);

  /**
   * Show `optimistic` now, run the write, then drop the overlay: on success
   * main's re-read (done by the hook before the write resolves) is the truth;
   * on a refusal the screen goes back and says why.
   */
  const run = useCallback(
    async <T,>(
      optimistic: (o: Overlay) => Overlay,
      write: () => Promise<ChecklistWriteApiResult<T> | null>,
      fallback: string,
    ): Promise<boolean> => {
      setError(null);
      setOverlay(optimistic);
      let ok = false;
      try {
        const result = await write();
        ok = result === null || result.success;
        if (result && !result.success) {
          if (result.dealLocked) setLockedByRefusal(true);
          setError(result.error || fallback);
        }
      } catch {
        setError(fallback);
      } finally {
        setOverlay(EMPTY_OVERLAY);
      }
      return ok;
    },
    [],
  );

  const submitAdd = useCallback(async () => {
    const title = draft.trim();
    if (!title || readOnly || overlay.adding !== null) return;
    setDraft("");
    const ok = await run((o) => ({ ...o, adding: title }), () => onAdd(title), "Couldn’t add the item.");
    if (!ok) setDraft(title);
    addInputRef.current?.focus();
  }, [draft, readOnly, overlay.adding, run, onAdd]);

  const startRename = (item: ChecklistItem) => {
    setMenuId(null);
    setRenameDraft(item.title);
    setRenamingId(item.id);
  };

  const submitRename = useCallback(
    async (item: ChecklistItem) => {
      const title = renameDraft.trim();
      setRenamingId(null);
      if (!title || title === item.title) return;
      await run(
        (o) => ({ ...o, titles: { ...o.titles, [item.id]: title } }),
        () => onRename(item.id, title),
        "Couldn’t rename the item.",
      );
    },
    [renameDraft, run, onRename],
  );

  const reorderTo = useCallback(
    (ids: string[]) => {
      setMenuId(null);
      void run((o) => ({ ...o, order: ids }), () => onReorder(ids), "Couldn’t move the item.");
    },
    [run, onReorder],
  );

  const moveBy = (index: number, delta: number) => {
    const to = index + delta;
    if (to < 0 || to >= items.length) return;
    reorderTo(move(items.map((i) => i.id), index, to));
  };

  const confirmRemove = useCallback(
    (itemId: string) => {
      setConfirmingId(null);
      void run(
        (o) => ({ ...o, hidden: new Set([...o.hidden, itemId]) }),
        () => onRemove(itemId),
        "Couldn’t delete the item.",
      );
    },
    [run, onRemove],
  );

  const toggle = useCallback(
    (item: ChecklistItem) => {
      if (readOnly || pendingItemIds.has(item.id)) return;
      const next = !(overlay.checked[item.id] ?? item.isChecked);
      void run(
        (o) => ({ ...o, checked: { ...o.checked, [item.id]: next } }),
        () => onSetChecked(item.id, next),
        "Couldn’t update this item.",
      );
    },
    [readOnly, pendingItemIds, overlay.checked, run, onSetChecked],
  );

  const drop = (targetId: string) => {
    const ids = items.map((i) => i.id);
    const from = dragId ? ids.indexOf(dragId) : -1;
    const to = ids.indexOf(targetId);
    setDragId(null);
    if (from < 0 || to < 0 || from === to) return;
    reorderTo(move(ids, from, to));
  };

  const done = detail?.requiredDone ?? 0;
  const total = detail?.requiredTotal ?? 0;

  return (
    <Card
      role="region"
      aria-label="My items"
      className="border-violet-200 shadow-none"
      data-testid="my-items-section"
    >
      <div className="flex items-start gap-3 flex-wrap px-4 py-3 bg-violet-50 rounded-t-lg">
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          aria-expanded={expanded}
          aria-controls={bodyId}
          className="flex items-start gap-2 text-left min-w-0 flex-1 basis-48"
          data-testid="my-items-toggle"
        >
          <svg
            className={`w-4 h-4 mt-1 text-gray-500 flex-shrink-0 transition-transform ${expanded ? "rotate-90" : ""}`}
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
            aria-hidden="true"
          >
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
          </svg>
          <span className="min-w-0">
            <span className="block text-base font-semibold text-gray-900">My items</span>
            <span className="block text-xs text-gray-500" data-testid="my-items-subtitle">
              {MY_ITEMS_PRIVACY_LINE}
              {total > 0 && (
                <span data-testid="my-items-count">{` ${done} of ${total} done`}</span>
              )}
            </span>
          </span>
        </button>
        <span
          className="inline-flex items-center gap-1 rounded-full bg-violet-100 px-2 py-0.5 text-xs font-semibold text-violet-700"
          data-testid="my-items-private-pill"
        >
          <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z"
            />
          </svg>
          Private
        </span>
      </div>

      {(error || (readOnly && !locked)) && (
        <p
          role={error ? "alert" : undefined}
          className={`mx-4 mt-3 text-sm ${error ? "text-red-700" : "text-gray-600"}`}
          data-testid={error ? "my-items-error" : "my-items-locked"}
        >
          {error ?? MY_ITEMS_LOCKED_LINE}
        </p>
      )}

      {expanded && (
      <div id={bodyId} className="flex flex-col gap-3 p-4">
        {items.length === 0 && overlay.adding === null && (
          <p className="text-sm text-gray-500" data-testid="my-items-empty">
            {readOnly ? "No items." : MY_ITEMS_EMPTY_LINE}
          </p>
        )}

        {items.map((item, index) => {
          const renaming = renamingId === item.id;
          const menuOpen = menuId === item.id;
          return (
            <div key={item.id} className="flex flex-col gap-2">
              <ChecklistItemRow
                item={item}
                links={detail?.linksByItemId[item.id] ?? []}
                readOnly={readOnly}
                pending={pendingItemIds.has(item.id)}
                attachmentsById={attachmentsById}
                threads={threads}
                onToggle={toggle}
                onSaveNote={onSaveNote}
                onOpenPicker={onOpenPicker}
                onRemoveLink={onRemoveLink}
                viewer={viewer}
                lockedTooltip={lockedTooltip}
                isPrivate
                displayChecked={overlay.checked[item.id]}
                rowProps={
                  readOnly
                    ? undefined
                    : {
                        onDragOver: (e) => {
                          if (dragId) e.preventDefault();
                        },
                        onDrop: (e) => {
                          e.preventDefault();
                          drop(item.id);
                        },
                      }
                }
                leading={
                  readOnly ? undefined : (
                    <span
                      draggable
                      onDragStart={() => setDragId(item.id)}
                      onDragEnd={() => setDragId(null)}
                      className="flex-shrink-0 mt-0.5 cursor-grab text-gray-300 select-none max-sm:hidden"
                      aria-hidden="true"
                      data-testid={`my-item-drag-${item.id}`}
                    >
                      ⋮⋮
                    </span>
                  )
                }
                title={
                  renaming ? (
                    <input
                      autoFocus
                      value={renameDraft}
                      onChange={(e) => setRenameDraft(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          e.preventDefault();
                          void submitRename(item);
                        } else if (e.key === "Escape") {
                          e.preventDefault();
                          setRenamingId(null);
                        }
                      }}
                      onBlur={() => void submitRename(item)}
                      maxLength={MY_ITEM_TITLE_MAX_LENGTH}
                      aria-label={`Rename ${item.title}`}
                      className="min-w-0 flex-1 text-base text-gray-900 bg-white border border-gray-300 rounded-md px-2 py-1 focus:outline-none focus:ring-2 focus:ring-primary"
                      data-testid={`my-item-rename-input-${item.id}`}
                    />
                  ) : undefined
                }
                controls={
                  <span className="relative">
                    <button
                      type="button"
                      onClick={() => setMenuId(menuOpen ? null : item.id)}
                      aria-expanded={menuOpen}
                      aria-controls={`my-item-menu-${item.id}`}
                      aria-label={`More actions for ${item.title}`}
                      className="px-1 text-sm font-medium text-gray-600 hover:text-primary min-h-[44px] sm:min-h-0"
                      data-testid={`my-item-menu-toggle-${item.id}`}
                    >
                      ⋯
                    </button>
                    {menuOpen && (
                      <span
                        id={`my-item-menu-${item.id}`}
                        role="group"
                        aria-label={`Actions for ${item.title}`}
                        onKeyDown={(e) => {
                          if (e.key === "Escape") setMenuId(null);
                        }}
                        className="absolute right-0 z-10 mt-1 flex w-36 flex-col rounded-md border border-gray-200 bg-white py-1 shadow-md"
                        data-testid={`my-item-menu-${item.id}`}
                      >
                        <MenuButton onClick={() => startRename(item)} testId={`my-item-rename-${item.id}`}>
                          Rename
                        </MenuButton>
                        <MenuButton
                          onClick={() => moveBy(index, -1)}
                          disabled={index === 0}
                          testId={`my-item-up-${item.id}`}
                        >
                          Move up
                        </MenuButton>
                        <MenuButton
                          onClick={() => moveBy(index, 1)}
                          disabled={index === items.length - 1}
                          testId={`my-item-down-${item.id}`}
                        >
                          Move down
                        </MenuButton>
                        <MenuButton
                          onClick={() => {
                            setMenuId(null);
                            setConfirmingId(item.id);
                          }}
                          danger
                          testId={`my-item-delete-${item.id}`}
                        >
                          Delete
                        </MenuButton>
                      </span>
                    )}
                  </span>
                }
              />
              {confirmingId === item.id && !readOnly && (
                <div
                  className="p-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-800 flex items-center justify-between gap-3 flex-wrap"
                  data-testid={`my-item-delete-prompt-${item.id}`}
                >
                  <span>Delete “{item.title}”?</span>
                  <span className="flex items-center gap-3">
                    <button
                      type="button"
                      onClick={() => confirmRemove(item.id)}
                      className="font-semibold text-red-700 hover:text-red-900"
                      data-testid={`my-item-delete-confirm-${item.id}`}
                    >
                      Delete
                    </button>
                    <button
                      type="button"
                      onClick={() => setConfirmingId(null)}
                      className="font-medium text-gray-700"
                      data-testid={`my-item-delete-cancel-${item.id}`}
                    >
                      Cancel
                    </button>
                  </span>
                </div>
              )}
            </div>
          );
        })}

        {overlay.adding !== null && (
          <div
            className="border border-gray-200 rounded-lg p-4 text-base text-gray-500 opacity-60"
            data-testid="my-item-adding"
          >
            {overlay.adding}
          </div>
        )}

        {!readOnly && (
          <form
            className="flex items-center gap-2 border border-dashed border-violet-300 rounded-lg px-3 py-2"
            onSubmit={(e) => {
              e.preventDefault();
              void submitAdd();
            }}
          >
            <input
              ref={addInputRef}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              maxLength={MY_ITEM_TITLE_MAX_LENGTH}
              placeholder="Add an item for yourself…"
              aria-label="New item"
              className="min-w-0 flex-1 bg-transparent text-sm text-gray-900 placeholder:text-gray-400 focus:outline-none"
              data-testid="my-items-add-input"
            />
            <Button
              type="submit"
              size="sm"
              variant={chooserShowing ? "secondary" : "primary"}
              disabled={draft.trim().length === 0 || overlay.adding !== null}
              data-testid="my-items-add"
            >
              Add
            </Button>
          </form>
        )}
      </div>
      )}
    </Card>
  );
}

function MenuButton({
  children,
  onClick,
  disabled,
  danger,
  testId,
}: {
  children: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
  danger?: boolean;
  testId: string;
}): React.ReactElement {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`px-3 py-1.5 text-left text-sm hover:bg-gray-50 disabled:opacity-40 disabled:cursor-not-allowed ${
        danger ? "text-red-600" : "text-gray-700"
      }`}
      data-testid={testId}
    >
      {children}
    </button>
  );
}

export default MyItemsSection;
