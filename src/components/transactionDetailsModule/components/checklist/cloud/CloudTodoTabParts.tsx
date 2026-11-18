/**
 * The Checklist tab's Keepr Cloud parts above and below the checklists — BACKLOG-4263 PR-6 (plan §7): the
 * offline notice (non-blocking, solid OK, once per app session), the one-line notices, and Recently removed.
 * Each renders nothing unless Keepr Cloud is on for this user. Banners use the tab's own notice style.
 */
import React, { useCallback, useEffect, useState } from "react";
import type { CloudTodoRemovedResult } from "../../../../../../electron/types/ipc/window-api-cloud-todos";
import cloudTodosService from "../../../../../services/cloudTodosService";
import { useCloudTodos } from "./CloudTodosContext";
import { CLOUD_TODO_COPY as T } from "./cloudTodoCopy";

const SOLID = "px-3 py-1.5 text-sm font-semibold text-white bg-blue-600 hover:bg-blue-700 rounded-lg disabled:opacity-60";
const SOLID_SECONDARY = "px-3 py-1.5 text-sm font-semibold text-gray-800 bg-white border border-gray-300 hover:bg-gray-100 rounded-lg disabled:opacity-60";

/** Once per app session: the offline notice is not shown again after OK. */
let offlineAcknowledged = false;
/** Tests only. */
export function resetOfflineNoticeForTests(): void {
  offlineAcknowledged = false;
}

export function CloudOfflineNotice(): React.ReactElement | null {
  const cloud = useCloudTodos();
  const [done, setDone] = useState(offlineAcknowledged);
  if (!cloud || cloud.online || done) return null;
  return (
    <div
      className="mb-4 p-3 bg-amber-50 border border-amber-200 rounded-lg text-sm text-amber-800 flex items-center justify-between gap-3"
      role="status"
      data-testid="checklist-cloud-offline"
    >
      <span>{T.offline}</span>
      <button
        type="button"
        className={SOLID}
        onClick={() => {
          offlineAcknowledged = true;
          setDone(true);
        }}
      >
        {T.ok}
      </button>
    </div>
  );
}

export function CloudDealNotices(): React.ReactElement | null {
  const cloud = useCloudTodos();
  if (!cloud) return null;
  const lines = cloud.notices.filter((n) => n.kind !== "conflict");
  if (lines.length === 0) return null;
  return (
    <div className="mb-4 flex flex-col gap-2" data-testid="checklist-cloud-notices">
      {lines.map((n) => {
        const title = n.title ?? T.aTodo;
        const text =
          n.kind === "dropped_not_online"
            ? T.dropped(title)
            : n.kind === "local_write_failed"
              ? T.writeFailed(title)
              : n.kind === "links_not_restored"
                ? T.linksNotRestored(n.count ?? 0)
                : T.notAccepted(title);
        return (
          <div
            key={n.id}
            className="p-3 bg-gray-50 border border-gray-200 rounded-lg text-sm text-gray-700 flex items-center justify-between gap-3"
            data-testid={`checklist-cloud-notice-${n.id}`}
          >
            <span>{text}</span>
            <button type="button" className={SOLID_SECONDARY} onClick={() => void cloud.dismiss(n.id)}>
              {T.dismiss}
            </button>
          </div>
        );
      })}
    </div>
  );
}

/** Todos and checklists of this deal removed in the last 30 days, with Restore (online only). */
export function CloudRecentlyRemoved({ locked }: { locked: boolean }): React.ReactElement | null {
  const cloud = useCloudTodos();
  const transactionId = cloud?.transactionId ?? "";
  const on = !!cloud;
  const [list, setList] = useState<CloudTodoRemovedResult | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [line, setLine] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!on || !transactionId) return;
    setList(await cloudTodosService.listRemoved(transactionId));
  }, [on, transactionId]);
  useEffect(() => {
    void load();
  }, [load, cloud?.notices, cloud?.markers]);

  if (!cloud || !list) return null;
  if (list.success && list.items.length === 0 && !line) return null;
  if (!list.success && list.error !== "offline") return null;

  const restore = async (entity: "item" | "checklist", cloudId: string) => {
    setBusy(cloudId);
    setLine(null);
    const r = await cloudTodosService.restore(transactionId, entity, cloudId);
    setBusy(null);
    setLine(r.success ? T.restoredLine : r.error === "offline" ? T.removedOffline : r.error === "locked" ? T.restoreLocked : T.restoreFailed);
    await load();
  };

  return (
    <div className="mt-6" data-testid="checklist-recently-removed">
      <h5 className="text-base font-medium text-gray-900 mb-2">{T.recentlyRemoved}</h5>
      {!list.success ? (
        <p className="text-sm text-gray-600">{T.removedOffline}</p>
      ) : (
        <div className="flex flex-col gap-2">
          {locked && list.items.length > 0 && <p className="text-sm text-gray-600">{T.restoreLocked}</p>}
          {list.items.map((i) => (
            <div
              key={i.cloudId}
              className="border border-gray-200 rounded-lg p-3 bg-white flex items-center justify-between gap-3"
              data-testid={`checklist-removed-${i.cloudId}`}
            >
              <span className="text-sm text-gray-700 min-w-0 break-words">
                {i.title}
                {i.removedAt && (
                  <span className="text-gray-500">
                    {" · "}
                    {T.removedOn(new Date(i.removedAt).toLocaleDateString("en-US", { month: "short", day: "numeric" }))}
                  </span>
                )}
              </span>
              {!locked && (
                <button type="button" className={SOLID} disabled={busy !== null} onClick={() => void restore(i.entity, i.cloudId)}>
                  {T.restore}
                </button>
              )}
            </div>
          ))}
        </div>
      )}
      {line && (
        <p className="mt-2 text-sm text-gray-700" data-testid="checklist-removed-line">
          {line}
        </p>
      )}
    </div>
  );
}
