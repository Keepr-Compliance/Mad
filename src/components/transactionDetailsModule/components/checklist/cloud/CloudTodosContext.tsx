/**
 * The Checklist tab's Keepr Cloud parts — BACKLOG-4263 PR-6 (plan §7).
 *
 * `CloudTodosProvider` (TransactionChecklistTab) asks main once per deal and again on `cloud-todos:changed`; each
 * row reads what it needs from the context. Without a provider, or for a user without Keepr Cloud on (main answers
 * `on: false`), every consumer renders nothing, so the tab is exactly as before.
 *
 * Writes go through the existing checklist channels only ("Use this version" is the ordinary note, name, tick or
 * due-date write: one change, captured by main as one op), plus a notice's dismiss.
 */
import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import cloudTodosService from "../../../../../services/cloudTodosService";
import checklistService from "../../../../../services/checklistService";
import type {
  CloudTodoMarker,
  CloudTodoNotice,
  CloudTodosForDeal,
} from "../../../../../../electron/types/ipc/window-api-cloud-todos";

export type CloudPanel = { itemId: string; panel: "due" | "history" } | null;

export interface CloudTodosValue {
  on: boolean;
  online: boolean;
  transactionId: string;
  notices: CloudTodoNotice[];
  markers: Record<string, CloudTodoMarker>;
  panel: CloudPanel;
  setPanel: (p: CloudPanel) => void;
  dismiss: (noticeId: number) => Promise<void>;
  /** Writes the other version as one ordinary change, then dismisses the notice. */
  applyOtherVersion: (notice: CloudTodoNotice) => Promise<boolean>;
  setDueDate: (itemId: string, dueDate: string | null) => Promise<boolean>;
  reload: () => Promise<void>;
}

const OFF: CloudTodosForDeal = { on: false, online: false, notices: [], markers: {} };

const CloudTodosContext = createContext<CloudTodosValue | null>(null);

/** The context when Keepr Cloud is on for this user; otherwise null (render nothing). */
export function useCloudTodos(): CloudTodosValue | null {
  const v = useContext(CloudTodosContext);
  return v && v.on ? v : null;
}

export function CloudTodosProvider({
  transactionId,
  onTodosChanged,
  children,
}: {
  transactionId: string | null;
  /** Re-read the checklists (a pull changed them, or "Use this version" wrote one). */
  onTodosChanged: () => void;
  children: React.ReactNode;
}): React.ReactElement {
  const [data, setData] = useState<CloudTodosForDeal>(OFF);
  const [panel, setPanel] = useState<CloudPanel>(null);
  const latest = useRef(onTodosChanged);
  latest.current = onTodosChanged;
  const seq = useRef(0);

  const reload = useCallback(async () => {
    if (!transactionId) return;
    const n = ++seq.current;
    const got = await cloudTodosService.getForDeal(transactionId);
    if (n === seq.current) setData(got);
  }, [transactionId]);

  useEffect(() => {
    setData(OFF);
    void reload();
    const off = cloudTodosService.onChanged(() => {
      void reload();
      latest.current();
    });
    return off;
  }, [reload]);

  const dismiss = useCallback(
    async (noticeId: number) => {
      await cloudTodosService.dismissNotice(noticeId);
      await reload();
    },
    [reload],
  );

  const setDueDate = useCallback(
    async (itemId: string, dueDate: string | null) => {
      const r = await checklistService.setItemDueDate(itemId, dueDate);
      if (r.success) latest.current();
      return r.success;
    },
    [],
  );

  const applyOtherVersion = useCallback(
    async (notice: CloudTodoNotice) => {
      if (notice.kind !== "conflict" || !notice.itemId || !notice.part || !transactionId) return false;
      const v = notice.otherValue;
      let ok = false;
      if (notice.part === "note") ok = (await checklistService.setItemNote(notice.itemId, typeof v === "string" ? v : null)).success;
      else if (notice.part === "due") ok = (await checklistService.setItemDueDate(notice.itemId, typeof v === "string" ? v : null)).success;
      else if (notice.part === "title" && typeof v === "string") ok = (await checklistService.renameMyItem(transactionId, notice.itemId, v)).success;
      else if (notice.part === "done" && v && typeof v === "object" && !Array.isArray(v))
        ok = (await checklistService.setItemChecked(notice.itemId, (v as { is_checked?: unknown }).is_checked === true)).success;
      if (!ok) return false;
      await cloudTodosService.dismissNotice(notice.id);
      latest.current();
      await reload();
      return true;
    },
    [transactionId, reload],
  );

  const value = useMemo<CloudTodosValue>(
    () => ({
      on: data.on,
      online: data.online,
      transactionId: transactionId ?? "",
      notices: data.notices,
      markers: data.markers,
      panel,
      setPanel,
      dismiss,
      applyOtherVersion,
      setDueDate,
      reload,
    }),
    [data, transactionId, panel, dismiss, applyOtherVersion, setDueDate, reload],
  );
  return <CloudTodosContext.Provider value={value}>{children}</CloudTodosContext.Provider>;
}
