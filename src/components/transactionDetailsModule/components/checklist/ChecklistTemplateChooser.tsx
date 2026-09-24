/**
 * ChecklistTemplateChooser — BACKLOG-3476, mock state 1.
 *
 * Three different sentences for three different facts, which is the whole
 * point of 3475 keeping "no templates" and "could not read" apart:
 *   templates listed      → one card per template
 *   empty list            → "Your brokerage hasn't set up any checklist templates yet."
 *   the read failed       → main's own sentence, and Retry
 * A failed read never says the brokerage has none. That would be a false
 * statement about someone else's account.
 *
 * It only reports which template was clicked. Whether that click writes
 * anything — a plain pick, or a replace behind a confirmation — is the tab's
 * decision.
 */
import React, { useCallback, useEffect, useState } from "react";
import { checklistService } from "../../../../services/checklistService";
import type { ChecklistTemplate, ChecklistTemplateSource } from "../../../../../electron/types/checklist";

type ListingState =
  | { status: "loading" }
  | { status: "ready"; templates: ChecklistTemplate[]; source: ChecklistTemplateSource }
  | { status: "failed"; error: string };

interface ChecklistTemplateChooserProps {
  /** "pick": no checklist yet. "replace": Change template was clicked. */
  mode: "pick" | "replace";
  onPick: (template: ChecklistTemplate) => void;
  /** Replace mode only: back to the checklist, nothing written. */
  onCancel?: () => void;
  /** True while a pick is being written; cards are disabled. */
  busy?: boolean;
  /** Bump to make the chooser read the templates again. */
  refreshKey?: number;
}

const HOUSE_ICON =
  "M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-6 0a1 1 0 001-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 001 1m-6 0h6";
const CLIPBOARD_ICON =
  "M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9l2 2 4-4";

export function ChecklistTemplateChooser({
  mode,
  onPick,
  onCancel,
  busy = false,
  refreshKey = 0,
}: ChecklistTemplateChooserProps): React.ReactElement {
  const [listing, setListing] = useState<ListingState>({ status: "loading" });
  const [retryKey, setRetryKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setListing({ status: "loading" });
    void (async () => {
      const result = await checklistService.listTemplates();
      if (cancelled) return;
      if (result.success && result.data) {
        setListing({ status: "ready", templates: result.data.templates, source: result.data.source });
      } else {
        setListing({
          status: "failed",
          error: result.error ?? "Your brokerage's checklist templates could not be loaded right now.",
        });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [refreshKey, retryKey]);

  const retry = useCallback(async () => {
    // Drop the cache first, so Retry really goes back to the brokerage.
    await checklistService.invalidateTemplates();
    setRetryKey((k) => k + 1);
  }, []);

  return (
    <div className="text-center pt-12 pb-6" data-testid="checklist-chooser">
      <svg className="w-16 h-16 text-gray-300 mx-auto mb-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d={CLIPBOARD_ICON} />
      </svg>
      {mode === "pick" ? (
        <>
          <p className="text-gray-600 mb-2">No checklist yet</p>
          <p className="text-sm text-gray-500">Choose a template to start this transaction&rsquo;s checklist.</p>
        </>
      ) : (
        <>
          <p className="text-gray-600 mb-2">Pick a new template for this transaction</p>
          <p className="text-sm text-gray-500">You&rsquo;ll be asked to confirm before anything is cleared.</p>
          {onCancel && (
            <button
              type="button"
              onClick={onCancel}
              className="mt-3 text-sm font-medium text-blue-600 hover:text-blue-800"
              data-testid="checklist-chooser-cancel"
            >
              Keep the current checklist
            </button>
          )}
        </>
      )}

      {listing.status === "loading" && (
        <div className="mt-6" data-testid="checklist-templates-loading">
          <div className="w-8 h-8 border-4 border-blue-600 border-t-transparent rounded-full animate-spin mx-auto" />
        </div>
      )}

      {listing.status === "failed" && (
        <div className="mt-6" data-testid="checklist-templates-failed">
          <p className="text-sm text-red-600 mb-3">{listing.error}</p>
          <button
            type="button"
            onClick={() => void retry()}
            className="px-4 py-2 text-sm font-medium text-blue-600 border border-blue-200 rounded-lg hover:bg-blue-50"
            data-testid="checklist-templates-retry"
          >
            Retry
          </button>
        </div>
      )}

      {listing.status === "ready" && listing.templates.length === 0 && (
        <p className="text-sm text-gray-500" data-testid="checklist-templates-empty">
          Your brokerage hasn&rsquo;t set up any checklist templates yet.
        </p>
      )}

      {listing.status === "ready" && listing.templates.length > 0 && (
        <>
          <div className="grid gap-3 grid-cols-1 sm:grid-cols-3 mt-6 text-left">
            {listing.templates.map((template) => {
              const required = template.items.filter((i) => i.isRequired).length;
              return (
                <button
                  key={template.id}
                  type="button"
                  disabled={busy}
                  onClick={() => onPick(template)}
                  className="bg-white border border-gray-200 rounded-lg p-4 flex flex-col gap-2 text-left hover:border-gray-300 hover:shadow-md transition-all disabled:opacity-60 disabled:cursor-wait"
                  data-testid={`checklist-template-${template.id}`}
                >
                  <span className="w-10 h-10 rounded-lg inline-flex items-center justify-center text-indigo-600 bg-indigo-50">
                    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d={HOUSE_ICON} />
                    </svg>
                  </span>
                  <span className="text-base font-medium text-gray-900">{template.name}</span>
                  <span className="text-sm text-gray-500 tabular-nums">
                    {template.items.length} item{template.items.length === 1 ? "" : "s"} · {required} required
                  </span>
                </button>
              );
            })}
          </div>
          <p className="mt-3 text-xs text-gray-400 text-left">Templates come from your brokerage.</p>
          {listing.source === "cache" && (
            <p className="mt-1 text-xs text-gray-400 text-left" data-testid="checklist-templates-cached">
              Showing saved templates &mdash; couldn&rsquo;t reach your brokerage just now.
            </p>
          )}
        </>
      )}
    </div>
  );
}

export default ChecklistTemplateChooser;
