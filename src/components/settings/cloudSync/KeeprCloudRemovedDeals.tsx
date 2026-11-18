/**
 * Settings › Keepr Cloud › Removed — BACKLOG-4263 PR-6 (plan §7, §14 F9).
 *
 * Same card rows and solid buttons as KeeprCloudSettings (`ROW`, `SOLID_BUTTON`). "Delete for good" asks first
 * (ConfirmationDialog, destructive). A row being deleted shows "Deleting…" and has no Restore. Wording:
 * keeprCloudCopy.ts. Rendered only for a user with Keepr Cloud on (the parent decides).
 */
import React, { useState } from "react";
import { ConfirmationDialog } from "@keepr/ui";
import { KEEPR_CLOUD_COPY as C } from "./keeprCloudCopy";
import type { UseKeeprCloudRemoved } from "./useKeeprCloudRemoved";

export const ROW = "flex items-center justify-between gap-4 rounded-lg border border-[#E6E4DF] bg-white px-5 py-4";
export const SOLID_BUTTON =
  "inline-flex h-9 flex-none items-center rounded-md bg-sky-700 px-4 text-sm font-semibold text-white hover:bg-sky-800 disabled:opacity-50";
const SOLID_RED_BUTTON =
  "inline-flex h-9 flex-none items-center rounded-md bg-red-600 px-4 text-sm font-semibold text-white hover:bg-red-700 disabled:opacity-50";

function shortDate(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleDateString(undefined, { day: "numeric", month: "short" });
}

export function KeeprCloudRemovedDeals({
  removed,
  offline = false,
}: {
  removed: UseKeeprCloudRemoved;
  /** This computer is offline: a row being deleted says it finishes when Keepr is online. */
  offline?: boolean;
}): React.ReactElement | null {
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const restorableOnline = removed.online.filter((d) => d.kind === "online");
  const rejected = removed.online.filter((d) => d.kind === "rejected");
  const total = removed.here.length + restorableOnline.length;
  // the answer to the last action stays visible even when its row is gone (a restored or erased deal leaves the list)
  if (total === 0 && rejected.length === 0 && !removed.onlineUnavailable && !removed.message) return null;

  return (
    <div className="flex flex-col gap-3" data-testid="cloud-removed">
      <div className="flex flex-col gap-1">
        <span className="text-sm font-semibold text-gray-900">{C.removedTitle}</span>
      </div>

      {removed.here.map((d) => (
        <div key={d.transactionId} className="flex flex-col gap-1" data-testid={`cloud-removed-${d.transactionId}`}>
          <div className={ROW}>
            <span className="flex flex-col gap-0.5">
              <span className="text-[13px] text-gray-700">{C.removedRow(d.propertyAddress ?? C.noAddress, shortDate(d.removedAt))}</span>
              {d.deleting && (
                <span className="text-[13px] text-gray-500" data-testid={`cloud-removed-deleting-${d.transactionId}`}>
                  {offline ? `${C.deleting} ${C.deletingOffline}` : C.deleting}
                </span>
              )}
            </span>
            <span className="flex flex-none items-center gap-2">
              {!d.deleting && (
                <button
                  type="button"
                  className={SOLID_BUTTON}
                  disabled={removed.busyId !== null}
                  onClick={() => void removed.restore(d.transactionId)}
                >
                  {C.restore}
                </button>
              )}
              {!d.deleting && (
                <button
                  type="button"
                  className={SOLID_RED_BUTTON}
                  disabled={removed.busyId !== null}
                  onClick={() => setConfirmId(d.transactionId)}
                >
                  {C.deleteForGood}
                </button>
              )}
            </span>
          </div>
        </div>
      ))}

      {restorableOnline.map((d) => (
        <div key={d.cloudId} className="flex flex-col gap-1" data-testid={`cloud-removed-online-${d.cloudId}`}>
          <div className={ROW}>
            <span className="text-[13px] text-gray-700">{C.removedOnlineRow(d.propertyAddress ?? C.noAddress, shortDate(d.removedAt))}</span>
            <button
              type="button"
              className={SOLID_BUTTON}
              disabled={removed.busyId !== null}
              onClick={() => void removed.restoreOnline(d.cloudId)}
            >
              {C.restore}
            </button>
          </div>
        </div>
      ))}

      {rejected.map((d) => (
        <p key={d.cloudId} className="m-0 text-[13px] text-gray-700" data-testid={`cloud-removed-rejected-${d.cloudId}`}>
          {C.rejectedRow(d.propertyAddress ?? C.noAddress)}
        </p>
      ))}

      {removed.message && (
        <p className="m-0 text-[13px] text-gray-700" data-testid="cloud-removed-message">
          {removed.message.text}
        </p>
      )}

      {removed.onlineUnavailable && (
        <p className="m-0 text-[13px] text-gray-500" data-testid="cloud-removed-online-unavailable">
          {C.removedOnlineUnavailable}
        </p>
      )}
      {removed.here.length > 0 && <p className="m-0 text-[13px] text-gray-500">{C.removedFootnote}</p>}

      <ConfirmationDialog
        open={confirmId !== null}
        title={C.deleteForGoodTitle}
        description={C.deleteForGoodConfirm}
        confirmLabel={C.deleteForGood}
        cancelLabel={C.cancel}
        isDestructive
        loading={removed.busyId !== null}
        onCancel={() => setConfirmId(null)}
        onConfirm={() => {
          const id = confirmId;
          setConfirmId(null);
          if (id) void removed.deleteForGood(id);
        }}
      />
    </div>
  );
}
