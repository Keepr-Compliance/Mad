/**
 * NeedsReviewScreen — S2 (BACKLOG-2791)
 *
 * Emails and texts COMBINED, in one list, approved or rejected per item.
 *
 * NOT A TAB, by founder instruction ("tabs are not action specific so maybe a
 * tab isn't the place"). It is a full-surface overlay ABOVE the details screen,
 * reached three ways: the header's Needs Review button, P2's Review, and P3's
 * Review. Rendered as an overlay rather than an early return in
 * TransactionDetails so the four tabs stay mounted underneath and keep their
 * scroll position, highlight state and loaded channels — an early return
 * discards all of it and the user lands back at the top of a re-fetching tab.
 *
 * The list comes from the ONE review-state read (useReviewQueue →
 * review:get-state → reviewStateService.getReviewState), so it is the same set,
 * by id, that the header badge counts and the Complete gate blocks on.
 *
 * DEVIATION FROM THE FLOW CHART, recorded deliberately: the founder asked to
 * "reuse the components... just put them together". EmailThreadCard and
 * MessageThreadCard both require fully-hydrated `Communication[]` / message
 * rows, which a PENDING item does not have — it is not in `communications` at
 * all, which is the entire point of the design. Rendering those cards would
 * therefore have shown nothing for exactly the items this screen exists to show.
 * ReviewItemCard below matches their visual language (same card chrome, same
 * amber needs-review treatment, same check/trash affordances) against the
 * display payload that travels with each item.
 */
import React, { useMemo, useState } from "react";
import type { ReviewItemDto } from "../../../../electron/types/ipc/window-api-transactions";

export interface NeedsReviewScreenProps {
  items: ReviewItemDto[];
  isLoading: boolean;
  onApprove: (itemIds: string[]) => Promise<void>;
  onReject: (itemIds: string[]) => Promise<void>;
  onClose: () => void;
}

function formatWhen(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

function KindIcon({ kind }: { kind: ReviewItemDto["kind"] }): React.ReactElement {
  return kind === "email" ? (
    <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
    </svg>
  ) : (
    <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.86 9.86 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
    </svg>
  );
}

function ReviewItemCard({
  item,
  busy,
  onApprove,
  onReject,
}: {
  item: ReviewItemDto;
  busy: boolean;
  onApprove: () => void;
  onReject: () => void;
}): React.ReactElement {
  const when = formatWhen(item.display.occurredAt);
  return (
    <li
      className="rounded-lg border border-amber-200 bg-amber-50/40 p-4"
      data-testid="review-item"
      data-item-id={item.id}
      data-kind={item.kind}
      data-origin={item.origin}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 text-xs font-medium text-amber-800">
            <KindIcon kind={item.kind} />
            <span>{item.kind === "email" ? "Email" : "Text"}</span>
            {item.display.itemCount > 1 && <span>· {item.display.itemCount} messages</span>}
            {when && <span>· {when}</span>}
          </div>
          <p className="mt-1 truncate font-semibold text-gray-900">{item.display.title}</p>
          {item.display.subtitle && (
            <p className="truncate text-sm text-gray-600">{item.display.subtitle}</p>
          )}
          {item.display.snippet && (
            <p className="mt-1 line-clamp-2 text-sm text-gray-500">{item.display.snippet}</p>
          )}
        </div>

        <div className="flex flex-shrink-0 items-center gap-2">
          <button
            type="button"
            onClick={onApprove}
            disabled={busy}
            aria-label="Approve"
            title="Approve — link this to the transaction"
            className="rounded-lg bg-green-600 p-2 text-white transition-all hover:bg-green-700 disabled:opacity-50"
          >
            <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
            </svg>
          </button>
          <button
            type="button"
            onClick={onReject}
            disabled={busy}
            aria-label="Reject"
            title="Reject — keep this out of the transaction"
            className="rounded-lg border border-gray-300 bg-white p-2 text-gray-600 transition-all hover:bg-gray-100 disabled:opacity-50"
          >
            <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
      </div>
    </li>
  );
}

export function NeedsReviewScreen({
  items,
  isLoading,
  onApprove,
  onReject,
  onClose,
}: NeedsReviewScreenProps): React.ReactElement {
  const [busyId, setBusyId] = useState<string | null>(null);
  const [bulkBusy, setBulkBusy] = useState(false);

  const { emails, texts } = useMemo(
    () => ({
      emails: items.filter((i) => i.kind === "email"),
      texts: items.filter((i) => i.kind === "text"),
    }),
    [items],
  );

  const act = async (id: string, fn: (ids: string[]) => Promise<void>) => {
    setBusyId(id);
    try {
      await fn([id]);
    } finally {
      setBusyId(null);
    }
  };

  const actAll = async (fn: (ids: string[]) => Promise<void>) => {
    setBulkBusy(true);
    try {
      await fn(items.map((i) => i.id));
    } finally {
      setBulkBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[70] flex flex-col bg-gray-50" data-testid="needs-review-screen">
      <header className="flex items-center justify-between gap-3 border-b border-gray-200 bg-white px-4 py-3 sm:px-6">
        <div className="flex min-w-0 items-center gap-3">
          <button
            type="button"
            onClick={onClose}
            aria-label="Back"
            className="rounded-lg p-2 text-gray-600 transition-all hover:bg-gray-100"
          >
            <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
            </svg>
          </button>
          <div className="min-w-0">
            <h1 className="truncate text-lg font-semibold text-gray-900">Needs Review</h1>
            <p className="truncate text-sm text-gray-500">
              {items.length === 0
                ? "Nothing to review"
                : `${items.length} item${items.length === 1 ? "" : "s"} · ${emails.length} email${emails.length === 1 ? "" : "s"}, ${texts.length} text${texts.length === 1 ? "" : "s"}`}
            </p>
          </div>
        </div>

        {items.length > 0 && (
          <div className="flex flex-shrink-0 items-center gap-2">
            <button
              type="button"
              onClick={() => actAll(onReject)}
              disabled={bulkBusy}
              className="rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm font-medium text-gray-700 transition-all hover:bg-gray-100 disabled:opacity-50"
            >
              Reject all
            </button>
            <button
              type="button"
              onClick={() => actAll(onApprove)}
              disabled={bulkBusy}
              className="rounded-lg bg-green-600 px-3 py-2 text-sm font-semibold text-white transition-all hover:bg-green-700 disabled:opacity-50"
            >
              Approve all
            </button>
          </div>
        )}
      </header>

      <div className="flex-1 overflow-y-auto px-4 py-4 sm:px-6">
        {isLoading && items.length === 0 ? (
          <p className="text-sm text-gray-500">Loading…</p>
        ) : items.length === 0 ? (
          <div className="mx-auto mt-16 max-w-sm text-center">
            <p className="font-medium text-gray-900">Everything is reviewed</p>
            <p className="mt-1 text-sm text-gray-600">
              New communications will appear here when they are found.
            </p>
          </div>
        ) : (
          <ul className="mx-auto flex max-w-3xl flex-col gap-3">
            {items.map((item) => (
              <ReviewItemCard
                key={item.id}
                item={item}
                busy={busyId === item.id || bulkBusy}
                onApprove={() => act(item.id, onApprove)}
                onReject={() => act(item.id, onReject)}
              />
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

export default NeedsReviewScreen;
