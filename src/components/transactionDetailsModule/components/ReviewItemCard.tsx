/**
 * ReviewItemCard (BACKLOG-2791)
 *
 * ONE card for a needs-review item, shared by all three renderings of the same
 * set: the combined Needs Review screen, the Emails tab's section and the Texts
 * tab's section. Shared deliberately — the founder's ruling is that these are
 * three VIEWS of one set, and three separate card components would drift into
 * three different ideas of what an item is.
 */
import React from "react";
import type { ReviewItemDto } from "../../../../electron/types/ipc/window-api-transactions";

function formatWhen(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

export function KindIcon({ kind }: { kind: ReviewItemDto["kind"] }): React.ReactElement {
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

export function ReviewItemCard({
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


export default ReviewItemCard;
