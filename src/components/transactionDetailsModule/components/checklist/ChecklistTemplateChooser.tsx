/**
 * ChecklistTemplateChooser — BACKLOG-3476, mock state 1.
 *
 * Three different sentences for three different facts, which is the whole
 * point of 3475 keeping "no templates" and "could not read" apart:
 *   templates listed      → one checkbox row per template
 *   empty list            → "No checklist templates have been set up yet."
 *   the read failed       → main's own sentence, and Retry
 * A failed read never says there are none. That would be a false
 * statement about someone else's account.
 *
 * BACKLOG-3588: a checkbox list, not one card per click. The user ticks
 * several templates and one "Add N checklists" adds them, in the order shown,
 * ONE AT A TIME through the tab's single-template add (`onAdd`). Sequential
 * on purpose: each add is its own write followed by its own reload, so a
 * template that succeeded is on the transaction (its row turns "Already
 * added") whatever happens to the next one. Nothing is rolled back.
 *   all added         → `onAllAdded` (the tab closes the chooser)
 *   some or all fail  → the failed rows stay ticked, and one sentence says
 *                       what was added and what was not
 * A template already on the transaction renders a disabled checkbox, marked
 * "Already added" (BACKLOG-3476: a template may be on a transaction once).
 * The checkbox is the checklist item row's own (`ChecklistCheckbox`).
 *
 * BACKLOG-3617: the hint under the list depends on whether this user may
 * create templates — asked of the database (`checklistService.canEditTemplates`,
 * the portal Checklists page's own check). ONE boolean, {@link canCreateChecklists},
 * decides every "create your own → Checklists" line in both views. BACKLOG-3618
 * (brokerage agents create their own) changed only where the answer comes
 * from — main now also asks `can_create_own_checklist_templates`.
 *
 * BACKLOG-3618: the user's own templates are tagged "Mine"; an own template
 * set not to be sent with submissions also says "Not sent to broker".
 *   creator            → the create line, "Checklists" opens the portal page
 *   cannot create      → no create line; nothing under the list
 *   unknown            → today's "Templates come from…" under the list
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChecklistCheckbox } from "./ChecklistCheckbox";
import { checklistService } from "../../../../services/checklistService";
import type { ChecklistTemplate, ChecklistTemplateSource } from "../../../../../electron/types/checklist";

type ListingState =
  | { status: "loading" }
  | { status: "ready"; templates: ChecklistTemplate[]; source: ChecklistTemplateSource }
  | { status: "failed"; error: string };

interface ChecklistTemplateChooserProps {
  /** "pick": no checklist yet. "add": the transaction already has some. */
  mode: "pick" | "add";
  /** Templates that cannot be ticked: already on this transaction. */
  disabledTemplateIds?: ReadonlySet<string>;
  /**
   * Add ONE template. Resolves true when that template is on the transaction
   * afterwards, false when it is not. Called once per ticked template, in
   * list order, each call awaited before the next starts.
   */
  onAdd: (template: ChecklistTemplate) => Promise<boolean>;
  /** Every ticked template was added. */
  onAllAdded: () => void;
  /** A batch finished with at least one template not added; `addedCount` of it were added. */
  onSomeNotAdded?: (addedCount: number) => void;
  /** Back to the checklists, nothing written. Absent: there is nowhere to go back to. */
  onCancel?: () => void;
  /** True while something else is writing; nothing can be ticked or added. */
  busy?: boolean;
  /** Bump to make the chooser read the templates again. */
  refreshKey?: number;
}

const CLIPBOARD_ICON =
  "M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9l2 2 4-4";

/** "A", "A and B", "A, B and C" — each name quoted. */
function quotedList(names: string[]): string {
  const quoted = names.map((n) => `"${n}"`);
  if (quoted.length <= 1) return quoted.join("");
  return `${quoted.slice(0, -1).join(", ")} and ${quoted[quoted.length - 1]}`;
}

/**
 * The sentence after a batch in which something was not added.
 * `attempted` is how many were sent; `notAdded` names the ones that failed.
 */
export function batchResultMessage(attempted: number, notAdded: string[]): string {
  const added = attempted - notAdded.length;
  if (added === 0) {
    return attempted === 1
      ? `Couldn't add ${quotedList(notAdded)} \u2014 try again.`
      : `Couldn't add any of the ${attempted} checklists \u2014 try again.`;
  }
  return `Added ${added} of ${attempted} checklists. Couldn't add ${quotedList(notAdded)} \u2014 try again.`;
}

/**
 * BACKLOG-3617: the ONE role check. `canEditTemplates` is the database's answer
 * (`null` = unknown). Every create line in the chooser reads this and nothing
 * else — BACKLOG-3618 flips it.
 */
export function canCreateChecklists(canEditTemplates: boolean | null): boolean {
  return canEditTemplates === true;
}

export function addButtonLabel(count: number): string {
  return count === 1 ? "Add checklist" : `Add ${count} checklists`;
}

/** BACKLOG-3617: the line shown when "Checklists" did not open. */
export function portalOpenFailedMessage(portalAddress?: string): string {
  return portalAddress
    ? `Couldn't open the portal. Go to ${portalAddress} \u2192 Checklists.`
    : "Couldn't open the portal Checklists page.";
}

export function ChecklistTemplateChooser({
  mode,
  disabledTemplateIds,
  onAdd,
  onAllAdded,
  onSomeNotAdded,
  onCancel,
  busy = false,
  refreshKey = 0,
}: ChecklistTemplateChooserProps): React.ReactElement {
  const [listing, setListing] = useState<ListingState>({ status: "loading" });
  const [retryKey, setRetryKey] = useState(0);
  const [ticked, setTicked] = useState<ReadonlySet<string>>(new Set());
  const [adding, setAdding] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  // BACKLOG-3617: null = unknown (still asking, refused, offline).
  const [canEditTemplates, setCanEditTemplates] = useState<boolean | null>(null);
  const [linkError, setLinkError] = useState<string | null>(null);
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

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
          error: result.error ?? "Checklist templates couldn't be loaded right now.",
        });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [refreshKey, retryKey]);

  useEffect(() => {
    let cancelled = false;
    void checklistService.canEditTemplates().then((answer) => {
      if (!cancelled) setCanEditTemplates(answer);
    });
    return () => {
      cancelled = true;
    };
  }, [refreshKey, retryKey]);

  const retry = useCallback(async () => {
    // Drop the cache first, so Retry really reads again instead of replaying the cache.
    await checklistService.invalidateTemplates();
    setRetryKey((k) => k + 1);
  }, []);

  // What Add would send: ticked, still listed, not already on the transaction,
  // in list order. The button's count reads the same list, so the label can
  // never promise a template the batch would skip.
  const toAdd = useMemo(
    () =>
      listing.status === "ready"
        ? listing.templates.filter((t) => ticked.has(t.id) && !(disabledTemplateIds?.has(t.id) ?? false))
        : [],
    [listing, ticked, disabledTemplateIds],
  );

  const locked = busy || adding;

  const toggle = useCallback(
    (templateId: string) => {
      if (locked || (disabledTemplateIds?.has(templateId) ?? false)) return;
      setTicked((prev) => {
        const next = new Set(prev);
        if (next.has(templateId)) next.delete(templateId);
        else next.add(templateId);
        return next;
      });
    },
    [locked, disabledTemplateIds],
  );

  const addTicked = useCallback(async () => {
    if (locked || toAdd.length === 0) return;
    const batch = toAdd;
    setAdding(true);
    setMessage(null);
    const notAdded: ChecklistTemplate[] = [];
    try {
      // One at a time, in list order: each add is its own write and reload.
      for (const template of batch) {
        let ok = false;
        try {
          ok = await onAdd(template);
        } catch {
          ok = false;
        }
        if (!ok) notAdded.push(template);
      }
    } finally {
      if (mountedRef.current) setAdding(false);
    }
    if (!mountedRef.current) return;
    // The ones that failed stay ticked, ready for another try.
    setTicked(new Set(notAdded.map((t) => t.id)));
    if (notAdded.length === 0) {
      onAllAdded();
      return;
    }
    setMessage(batchResultMessage(batch.length, notAdded.map((t) => t.name)));
    onSomeNotAdded?.(batch.length - notAdded.length);
  }, [locked, toAdd, onAdd, onAllAdded, onSomeNotAdded]);

  const hasList = listing.status === "ready" && listing.templates.length > 0;
  const listIsEmpty = listing.status === "ready" && listing.templates.length === 0;
  const canCreate = canCreateChecklists(canEditTemplates);

  const openPortal = async () => {
    setLinkError(null);
    const result = await checklistService.openTemplatesPortal();
    if (!mountedRef.current) return;
    if (!result.success) setLinkError(portalOpenFailedMessage(result.portalAddress));
  };

  const linkErrorLine = linkError ? (
    <p className="mt-1 text-xs text-red-600" role="alert" data-testid="checklist-create-link-error">
      {linkError}
    </p>
  ) : null;

  const checklistsLink = (
    <button
      type="button"
      onClick={() => void openPortal()}
      className="font-medium text-blue-600 hover:underline"
      data-testid="checklist-create-link"
    >
      Checklists
    </button>
  );

  // "pick": the line under the title. An empty list has nothing to select from.
  let pickHint: React.ReactNode = null;
  if (canCreate) {
    pickHint = listIsEmpty ? (
      <>Need a checklist? Create your own &rarr; {checklistsLink}.</>
    ) : (
      <>Need a checklist? Select one from the list or create your own &rarr; {checklistsLink}.</>
    );
  } else if (!listIsEmpty) {
    pickHint = <>Need a checklist? Select one from the list.</>;
  }

  // "add": the line under the list (or under the empty sentence).
  let addHint: React.ReactNode = null;
  if (canCreate) {
    addHint = listIsEmpty ? (
      <>Need a checklist? Create your own &rarr; {checklistsLink}.</>
    ) : (
      <>Need a different checklist? Create your own &rarr; {checklistsLink}.</>
    );
  } else if (canEditTemplates === null && hasList) {
    addHint = <>Templates come from your organization&rsquo;s checklist settings.</>;
  }

  return (
    <div className="text-center pt-12" data-testid="checklist-chooser">
      <svg className="w-16 h-16 text-gray-300 mx-auto mb-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d={CLIPBOARD_ICON} />
      </svg>
      {mode === "pick" ? (
        <>
          <p className="text-gray-600 mb-2" data-testid="checklist-chooser-title">No checklist added yet.</p>
          {pickHint && (
            <p className="text-sm text-gray-500" data-testid="checklist-chooser-hint">
              {pickHint}
            </p>
          )}
          {linkErrorLine}
        </>
      ) : (
        <>
          <p className="text-gray-600 mb-2">Add checklists to this transaction</p>
          <p className="text-sm text-gray-500">The checklists already here are not changed.</p>
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
          No checklist templates have been set up yet.
        </p>
      )}

      {mode === "add" && listIsEmpty && addHint && (
        <>
          <p className="mt-2 text-sm text-gray-500" data-testid="checklist-chooser-hint">
            {addHint}
          </p>
          {linkErrorLine}
        </>
      )}

      {listing.status === "ready" && listing.templates.length > 0 && (
        <>
          <div className="flex flex-col gap-2 mt-6 text-left" data-testid="checklist-template-list">
            {listing.templates.map((template) => {
              const required = template.items.filter((i) => i.isRequired).length;
              const alreadyAdded = disabledTemplateIds?.has(template.id) ?? false;
              const isTicked = !alreadyAdded && ticked.has(template.id);
              const disabled = locked || alreadyAdded;
              return (
                <label
                  key={template.id}
                  className={`border rounded-lg px-4 py-3 flex items-start gap-3 transition-colors ${
                    isTicked ? "border-blue-500 bg-blue-50" : "border-gray-200 bg-white"
                  } ${disabled ? "opacity-60 cursor-not-allowed" : "cursor-pointer hover:border-gray-300"}`}
                  data-testid={`checklist-template-${template.id}`}
                >
                  <ChecklistCheckbox
                    checked={isTicked}
                    label={template.name}
                    disabled={disabled}
                    onClick={() => toggle(template.id)}
                    testId={`checklist-template-check-${template.id}`}
                  />
                  <span className="flex-1 min-w-0 flex flex-col">
                    <span className="text-base font-medium text-gray-900">
                      {template.name}
                      {template.isMine && (
                        <span
                          className="ml-2 align-middle rounded bg-gray-100 px-1.5 py-0.5 text-xs font-medium text-gray-600"
                          data-testid={`checklist-template-mine-${template.id}`}
                        >
                          Mine
                        </span>
                      )}
                    </span>
                    <span className="text-sm text-gray-500 tabular-nums">
                      {template.items.length} item{template.items.length === 1 ? "" : "s"} · {required} required
                    </span>
                    {template.isMine && !template.includeInSubmission && (
                      <span
                        className="text-xs text-gray-500"
                        data-testid={`checklist-template-not-sent-${template.id}`}
                      >
                        Not sent to broker
                      </span>
                    )}
                  </span>
                  {alreadyAdded && (
                    <span
                      className="text-xs font-medium text-gray-500 flex-shrink-0 whitespace-nowrap mt-1"
                      data-testid={`checklist-template-added-${template.id}`}
                    >
                      Already added
                    </span>
                  )}
                </label>
              );
            })}
          </div>
          {mode === "add" && addHint && (
            <>
              <p className="mt-3 text-xs text-gray-400 text-left" data-testid="checklist-chooser-hint">
                {addHint}
              </p>
              <div className="text-left">{linkErrorLine}</div>
            </>
          )}
          {listing.source === "cache" && (
            <p className="mt-1 text-xs text-gray-400 text-left" data-testid="checklist-templates-cached">
              Showing saved templates &mdash; couldn&rsquo;t connect just now.
            </p>
          )}
        </>
      )}

      {message && (
        <p className="mt-4 text-sm text-red-600 text-left" role="alert" data-testid="checklist-add-result">
          {message}
        </p>
      )}

      {(hasList || message || onCancel) && (
        // Pinned to the bottom of the tab's scroll area while the list scrolls.
        // The negative offsets cancel the scroll area's own p-3 / sm:p-6, so the
        // bar reaches its edges instead of floating above a strip of list.
        <div
          className="sticky -bottom-3 sm:-bottom-6 -mx-3 sm:-mx-6 mt-6 px-3 sm:px-6 pt-4 pb-6 sm:pb-9 bg-gray-50 border-t border-gray-200 flex items-center justify-between gap-3 flex-wrap text-left"
          data-testid="checklist-chooser-footer"
        >
          <span className="text-sm text-gray-600 tabular-nums" data-testid="checklist-chooser-count">
            {toAdd.length} selected
          </span>
          <div className="flex items-center gap-3 flex-shrink-0">
            {onCancel && (
              <button
                type="button"
                onClick={onCancel}
                disabled={adding}
                className="rounded-lg px-4 py-2 font-medium text-gray-700 transition-all hover:bg-gray-100 disabled:opacity-60 disabled:cursor-not-allowed"
                data-testid="checklist-chooser-cancel"
              >
                Cancel
              </button>
            )}
            {hasList && (
              <button
                type="button"
                onClick={() => void addTicked()}
                disabled={locked || toAdd.length === 0}
                className="rounded-lg bg-blue-600 px-4 py-2 font-semibold text-white shadow-md transition-all hover:bg-blue-700 disabled:opacity-60 disabled:cursor-not-allowed disabled:hover:bg-blue-600"
                data-testid="checklist-chooser-add"
              >
                {adding ? "Adding\u2026" : addButtonLabel(Math.max(toAdd.length, 1))}
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

export default ChecklistTemplateChooser;
