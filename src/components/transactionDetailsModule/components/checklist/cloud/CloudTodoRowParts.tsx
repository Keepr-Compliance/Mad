/**
 * One row's Keepr Cloud parts — BACKLOG-4263 PR-6 (plan §7). Each renders nothing unless Keepr Cloud is on for
 * this user (useCloudTodos). Styles are ChecklistItemRow's own: the due chip is its Required pill, the strip,
 * editor and History are its Note block and note editor; action buttons are solid.
 */
import React, { useEffect, useState } from "react";
import type { ChecklistItem } from "../../../../../../electron/types/checklist";
import type { CloudTodoHistoryResult } from "../../../../../../electron/types/ipc/window-api-cloud-todos";
import cloudTodosService from "../../../../../services/cloudTodosService";
import { useCloudTodos } from "./CloudTodosContext";
import { ago, CLOUD_TODO_COPY as T, shortDay } from "./cloudTodoCopy";
import { MenuButton } from "../MenuButton";

const PILL = "inline-flex items-center px-1.5 py-0.5 rounded-full text-[10px] font-medium uppercase tracking-wide flex-shrink-0";
const BLOCK = "mt-2.5 bg-gray-50 border border-gray-200 rounded-lg p-3";
const SOLID = "px-3 py-1.5 text-sm font-semibold text-white bg-blue-600 hover:bg-blue-700 rounded-lg disabled:opacity-60";
const SOLID_SECONDARY = "px-3 py-1.5 text-sm font-semibold text-gray-800 bg-white border border-gray-300 hover:bg-gray-100 rounded-lg disabled:opacity-60";
const OTHER_PREVIEW = 200;

/** A value cut to the strip's preview length (History shows no "Show all"). */
function cut(text: string | null): string {
  const t = text ?? T.empty;
  return t.length > OTHER_PREVIEW ? `${t.slice(0, OTHER_PREVIEW)}…` : t;
}

/** "Due Nov 20", in the title line, after the Required pill. */
export function CloudDueChip({ item }: { item: ChecklistItem }): React.ReactElement | null {
  const cloud = useCloudTodos();
  if (!cloud || !item.dueDate) return null;
  return (
    <span className={`${PILL} bg-gray-100 text-gray-600`} data-testid={`checklist-due-${item.id}`}>
      {T.due(shortDay(item.dueDate))}
    </span>
  );
}

/** "Ticked by Claude · 2 h ago" under the title. */
export function CloudMarker({ item }: { item: ChecklistItem }): React.ReactElement | null {
  const cloud = useCloudTodos();
  const m = cloud?.markers[item.id];
  if (!cloud || !m) return null;
  return (
    <p className="mt-1 text-xs text-gray-500" data-testid={`checklist-marker-${item.id}`}>
      {T.marker(m.kind, m.who, ago(m.at))}
    </p>
  );
}

/** The menu entries Keepr Cloud adds to a row's ⋯ menu (My items) — rendered by the caller's MenuButton. */
export function useCloudMenu(item: ChecklistItem): Array<{ key: "due" | "history"; label: string; onSelect: () => void }> | null {
  const cloud = useCloudTodos();
  if (!cloud) return null;
  return [
    { key: "due", label: T.dueDateMenu, onSelect: () => cloud.setPanel({ itemId: item.id, panel: "due" }) },
    { key: "history", label: T.historyMenu, onSelect: () => cloud.setPanel({ itemId: item.id, panel: "history" }) },
  ];
}

/**
 * A ⋯ menu with only Due date… and History, for a template row (which has no menu of its own). The same toggle
 * and menu as MyItemsSection's.
 */
export function CloudTemplateMenu({ item, readOnly }: { item: ChecklistItem; readOnly: boolean }): React.ReactElement | null {
  const entries = useCloudMenu(item);
  const [open, setOpen] = useState(false);
  if (!entries) return null;
  const shown = readOnly ? entries.filter((e) => e.key === "history") : entries;
  return (
    <span className="relative">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        aria-controls={`cloud-item-menu-${item.id}`}
        aria-label={`More actions for ${item.title}`}
        className="px-1 text-sm font-medium text-gray-600 hover:text-primary min-h-[44px] sm:min-h-0"
        data-testid={`cloud-item-menu-toggle-${item.id}`}
      >
        ⋯
      </button>
      {open && (
        <span
          id={`cloud-item-menu-${item.id}`}
          role="group"
          aria-label={`Actions for ${item.title}`}
          onKeyDown={(e) => {
            if (e.key === "Escape") setOpen(false);
          }}
          className="absolute right-0 z-10 mt-1 flex w-36 flex-col rounded-md border border-gray-200 bg-white py-1 shadow-md"
          data-testid={`cloud-item-menu-${item.id}`}
        >
          {shown.map((e) => (
            <MenuButton
              key={e.key}
              onClick={() => {
                setOpen(false);
                e.onSelect();
              }}
              testId={`cloud-item-${e.key}-${item.id}`}
            >
              {e.label}
            </MenuButton>
          ))}
        </span>
      )}
    </span>
  );
}

/** The panels under a row: conflict strips, the due-date editor, the History list. */
export function CloudRowPanels({ item, readOnly }: { item: ChecklistItem; readOnly: boolean }): React.ReactElement | null {
  const cloud = useCloudTodos();
  if (!cloud) return null;
  const conflicts = cloud.notices.filter((n) => n.kind === "conflict" && n.itemId === item.id);
  const open = cloud.panel?.itemId === item.id ? cloud.panel.panel : null;
  return (
    <>
      {conflicts.map((n) => (
        <ConflictStrip key={n.id} noticeId={n.id} readOnly={readOnly} />
      ))}
      {open === "due" && !readOnly && <DueEditor item={item} />}
      {open === "history" && <HistoryList item={item} />}
    </>
  );
}

function ConflictStrip({ noticeId, readOnly }: { noticeId: number; readOnly: boolean }): React.ReactElement | null {
  const cloud = useCloudTodos();
  const [all, setAll] = useState(false);
  const [busy, setBusy] = useState(false);
  const n = cloud?.notices.find((x) => x.id === noticeId);
  if (!cloud || !n || !n.part) return null;
  const other = n.otherText ?? T.empty;
  const long = other.length > OTHER_PREVIEW;
  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await fn();
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className={BLOCK} role="status" data-testid={`checklist-conflict-${noticeId}`}>
      <p className="text-sm text-gray-700">{T.conflict(n.part, n.who ?? T.aTodo)}</p>
      <p className="mt-1 text-sm text-gray-700 whitespace-pre-wrap break-words">
        {T.otherVersion} “{all || !long ? other : `${other.slice(0, OTHER_PREVIEW)}…`}”
        {long && !all && (
          <>
            {" "}
            <button type="button" className="text-xs font-medium text-blue-600 hover:text-blue-800" onClick={() => setAll(true)}>
              {T.showAll}
            </button>
          </>
        )}
      </p>
      <div className="flex items-center justify-end gap-3 mt-2">
        <button type="button" className={SOLID_SECONDARY} disabled={busy} onClick={() => void run(() => cloud.dismiss(noticeId))}>
          {T.dismiss}
        </button>
        {!readOnly && (
          <button
            type="button"
            className={SOLID}
            disabled={busy}
            onClick={() => void run(() => cloud.applyOtherVersion(n))}
            data-testid={`checklist-use-version-${noticeId}`}
          >
            {T.useThisVersion}
          </button>
        )}
      </div>
    </div>
  );
}

function DueEditor({ item }: { item: ChecklistItem }): React.ReactElement | null {
  const cloud = useCloudTodos();
  const [draft, setDraft] = useState(item.dueDate ?? "");
  const [saving, setSaving] = useState(false);
  if (!cloud) return null;
  const save = async (value: string | null) => {
    setSaving(true);
    try {
      if (await cloud.setDueDate(item.id, value)) cloud.setPanel(null);
    } finally {
      setSaving(false);
    }
  };
  return (
    <div className="mt-2.5" data-testid={`checklist-due-editor-${item.id}`}>
      <label className="block text-xs font-medium text-gray-400 uppercase tracking-wider mb-1" htmlFor={`due-${item.id}`}>
        {T.dueLabel}
      </label>
      <input
        id={`due-${item.id}`}
        type="date"
        min="2000-01-01"
        max="2100-12-31"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        className="text-sm text-gray-900 bg-white border border-gray-300 rounded-lg p-2 focus:outline-none focus:ring-2 focus:ring-blue-500"
      />
      <div className="flex items-center justify-end gap-3 mt-2">
        <button type="button" onClick={() => cloud.setPanel(null)} disabled={saving} className="text-sm font-medium text-gray-600 hover:text-gray-800">
          {T.cancel}
        </button>
        {item.dueDate && (
          <button type="button" onClick={() => void save(null)} disabled={saving} className={SOLID_SECONDARY} data-testid={`checklist-due-clear-${item.id}`}>
            {T.clear}
          </button>
        )}
        <button
          type="button"
          onClick={() => void save(draft.length > 0 ? draft : null)}
          disabled={saving || draft === (item.dueDate ?? "")}
          className={SOLID}
          data-testid={`checklist-due-save-${item.id}`}
        >
          {T.save}
        </button>
      </div>
    </div>
  );
}

function historyLine(r: CloudTodoHistoryResult["rows"][number]): string {
  const when = ago(r.at);
  const what =
    r.what === "changed"
      ? `${T.partName[r.part ?? ""] ?? ""}: ${cut(r.oldText)} → ${cut(r.newText)}`
      : r.what === "added" || r.what === "removed" || r.what === "restored"
        ? T[r.what]
        : "";
  return [r.who, when, what].filter((x) => x.length > 0).join(" · ") + (r.kept ? "" : ` ${T.notKept}`);
}

function HistoryList({ item }: { item: ChecklistItem }): React.ReactElement {
  const cloud = useCloudTodos();
  const [res, setRes] = useState<CloudTodoHistoryResult | null>(null);
  useEffect(() => {
    let live = true;
    void cloudTodosService.history(item.id).then((r) => {
      if (live) setRes(r);
    });
    return () => {
      live = false;
    };
  }, [item.id]);
  return (
    <div className={BLOCK} data-testid={`checklist-history-${item.id}`}>
      <span className="block text-xs font-medium text-gray-400 uppercase tracking-wider mb-1">{T.historyMenu}</span>
      {!res ? null : !res.success ? (
        <p className="text-sm text-gray-700">{res.error === "offline" ? T.historyOffline : T.historyFailed}</p>
      ) : res.rows.length === 0 ? (
        <p className="text-sm text-gray-700">{T.historyEmpty}</p>
      ) : (
        <ul className="flex flex-col gap-1">
          {res.rows.map((r, i) => (
            <li key={i} className="text-sm text-gray-700 break-words">
              {historyLine(r)}
            </li>
          ))}
        </ul>
      )}
      <div className="flex items-center justify-end gap-3 mt-2">
        <button type="button" className={SOLID_SECONDARY} onClick={() => cloud?.setPanel(null)} data-testid={`checklist-history-dismiss-${item.id}`}>
          {T.dismiss}
        </button>
      </div>
    </div>
  );
}
