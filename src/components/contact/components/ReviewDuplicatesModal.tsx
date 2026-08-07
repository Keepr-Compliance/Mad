import React, { useCallback, useEffect, useState } from "react";
import { ResponsiveModal } from "../../common/ResponsiveModal";
import { ContactCompareSources } from "../../shared/ContactCompareSources";
import type { ContactReviewCluster, ContactReviewItem } from "@/types/contactProvenance";

/**
 * Review possible duplicates (BACKLOG-2410)
 *
 * ===========================================================================
 * WHAT THIS SCREEN IS
 * ===========================================================================
 * The linker refuses to guess. When a match would reassign an identifier
 * already held by someone else — or when a name is not unique enough to trust —
 * the link is withheld. Before this screen, "withheld" meant counted, logged,
 * and then nothing: the one band where a human adds information was discarded on
 * every sync.
 *
 * It is also the only place a WRONG merge can be reported. No product in the
 * public record proactively detects a false merge; the person harmed by it does.
 * That only works if we ask.
 *
 * ===========================================================================
 * TWO AXES, IN WORDS
 * ===========================================================================
 * Every item states its reading on two separate axes, never a score and never a
 * single blended scale:
 *
 *   identity      the same person · possibly the same person · different people
 *   relationship  connected · possibly connected · no known connection
 *
 * A buyer and a seller on one deal are CONNECTED and DEFINITELY NOT THE SAME
 * PERSON. A single 0..1 "match confidence" cannot say that, and every product
 * that tries ends up reading "strongly related" as "probably the same" — which
 * is the false-merge generator this whole feature exists to avoid.
 *
 * ===========================================================================
 * AMBER, LIKE THE OTHER REVIEW SURFACE
 * ===========================================================================
 * Matches the palette and count-in-header idiom of `NeedsReviewSection`
 * (BACKLOG-2319) so the two review surfaces read as one system, while staying
 * strictly separate: that one is emails↔transaction, this one is
 * contacts↔source records. Its `needs-review-*` test ids are deliberately not
 * reused.
 */

interface ReviewDuplicatesModalProps {
  userId: string;
  onClose: () => void;
  /** Fired after any answer, so the caller can refresh the count and the list. */
  onResolved?: () => void;
}

export function ReviewDuplicatesModal({
  userId,
  onClose,
  onResolved,
}: ReviewDuplicatesModalProps): React.ReactElement {
  const [clusters, setClusters] = useState<ContactReviewCluster[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  /**
   * BACKLOG-2502 — the candidate whose compare screen is open, if any.
   *
   * The row settles what it can; this is where the rest goes. The compare screen
   * is the SHIPPED component (BACKLOG-2471), given the candidate as one more
   * column — not a second detail view built here.
   */
  const [comparing, setComparing] = useState<ContactReviewItem | null>(null);
  /**
   * An OUTCOME to report, not a load failure — kept apart from `error` because
   * the answer succeeded and the list is about to reload, and `load()` clears
   * `error`. A message that a successful reload wipes is a message nobody reads.
   */
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const result = await window.api.contacts.getReviewQueue(userId);
      if (result.success) {
        setClusters(result.clusters ?? []);
        setError(null);
      } else {
        setError(result.error ?? "Could not load the review list.");
        setClusters([]);
      }
    } catch {
      setError("Could not load the review list.");
      setClusters([]);
    }
  }, [userId]);

  useEffect(() => {
    void load();
  }, [load]);

  const answer = useCallback(
    async (item: ContactReviewItem, verdict: "same" | "different") => {
      setBusyId(item.proposalId);
      setNotice(null);
      try {
        // The two channels are called on separate branches rather than through
        // one ternary because their response shapes DIFFER: `contacts:reject-link`
        // returns `{ success, error }` and carries no `linked`. Collapsing them
        // into a union is what hides that difference.
        const result =
          verdict === "same"
            ? await window.api.contacts.confirmLink(userId, item.proposalId)
            : { ...(await window.api.contacts.rejectLink(userId, item.proposalId)), linked: true };
        if (!result.success) {
          setError(result.error ?? "That answer could not be saved.");
        } else if (verdict === "same" && result.linked === false) {
          /*
            BACKLOG-2502 — `ok: true` DOES NOT MEAN LINKED.

            `confirmProposal` returns `{ ok: true, linked: false }` when the
            record is already claimed by a DIFFERENT contact: it records the
            verdict, creates no link, and skips the sibling rejection. That is
            the merge guard working — re-pointing a claimed record is out of
            scope across this whole epic — but a caller that reads `success`
            alone tells the user two records were joined when they were not.

            The row still leaves the queue (the proposal IS resolved), so the
            list reloads; the sentence is what stops it being a silent no-op.
          */
          setNotice(
            "That record is already saved to a different contact, so it was not joined here.",
          );
          onResolved?.();
          await load();
        } else {
          setError(null);
          onResolved?.();
          // Reload rather than splice the answered row out locally: confirming
          // one option in a multiple-choice cluster also answers its siblings,
          // and only the main process knows which. A local splice would leave
          // questions on screen that have already been settled.
          await load();
        }
      } catch {
        setError("That answer could not be saved.");
      } finally {
        setBusyId(null);
      }
    },
    [userId, onResolved, load],
  );

  const total = (clusters ?? []).reduce((sum, c) => sum + c.items.length, 0);

  return (
    <ResponsiveModal
      onClose={onClose}
      panelClassName="max-w-2xl max-h-[80vh]"
      testId="review-duplicates-modal"
    >
      <div className="px-6 py-4 border-b border-gray-200">
        <h2 className="text-lg font-bold text-gray-900">Possible duplicates</h2>
        {/*
          BACKLOG-2502 — THE PROMISE IS MADE ONCE, HERE.

          The founder got it per candidate: a frozen-audit sentence repeated
          verbatim on every row, plus a "nothing has been linked" sentence the
          header already made. At five candidates that is ten sentences saying
          what these two say. Both still exist, frozen in each proposal's
          evidence, and both are reachable from the compare screen's
          "How we decided this" — they are no longer the default view.
        */}
        <p className="text-sm text-gray-600 mt-1">
          These were <span className="font-semibold">not</span> linked automatically because we
          could not tell. Nothing changes until you answer.
        </p>
      </div>

      {/*
        BACKLOG-2502 — the compare screen, over the list, for the candidate the
        row could not settle. `proposalId` present routes its Confirm to the
        SHIPPED `contacts:confirm-link`, and its `Different people` to
        `contacts:reject-link` — the same two channels the rows use, so there is
        one resolution path and not three.
      */}
      {comparing && (
        <div className="px-6 py-4 overflow-y-auto" data-testid="review-compare-pane">
          <button
            type="button"
            onClick={() => setComparing(null)}
            className="mb-3 text-sm font-semibold text-gray-600 hover:text-gray-900"
            data-testid="review-compare-back"
          >
            ← Back to the list
          </button>
          <ContactCompareSources
            userId={userId}
            contactId={comparing.contactId}
            proposedSource={{
              sourceType: comparing.sourceType,
              sourceRecordId: comparing.sourceRecordId,
            }}
            proposalId={comparing.proposalId}
            why={
              comparing.evidence
                ? {
                    summary: comparing.evidence.summary,
                    details: comparing.evidence.details ?? [],
                  }
                : undefined
            }
            onClose={() => setComparing(null)}
            onConfirmed={() => {
              setComparing(null);
              onResolved?.();
              void load();
            }}
            onRejected={() => {
              setComparing(null);
              onResolved?.();
              void load();
            }}
          />
        </div>
      )}

      {!comparing && (
      <div className="px-6 py-4 overflow-y-auto">
        {notice && (
          <div
            className="mb-4 p-3 bg-amber-50 border border-amber-200 rounded-lg text-sm text-amber-900"
            data-testid="review-duplicates-notice"
          >
            {notice}
          </div>
        )}
        {error && (
          <div
            className="mb-4 p-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-800"
            data-testid="review-duplicates-error"
          >
            {error}
          </div>
        )}

        {clusters === null && (
          <div className="text-center py-8" data-testid="review-duplicates-loading">
            <div className="w-6 h-6 border-2 border-amber-500 border-t-transparent rounded-full animate-spin mx-auto" />
          </div>
        )}

        {clusters !== null && total === 0 && (
          <div className="text-center py-8 text-sm text-gray-500" data-testid="review-duplicates-empty">
            Nothing to review. Every contact link we made was one we were sure about.
          </div>
        )}

        <div className="space-y-5">
          {(clusters ?? []).map((cluster) => (
            <div
              key={cluster.clusterKey}
              className="rounded-xl border border-amber-200 bg-amber-50/50"
              data-testid={`review-cluster-${cluster.clusterKey}`}
            >
              <div className="px-4 pt-3 pb-2 flex items-center gap-2">
                {/*
                  BACKLOG-2502 — THE HEADING IS GONE. Founder: *"espically this
                  seems redundant 'Is \"Romina\" the same person as Romina?'"*.
                  When both names are identical it says nothing, and the row
                  below already shows both. `cluster.question` is still produced
                  by `clusterQuestion()` for any other caller; it is simply not
                  what this screen leads with.
                */}
                <h3 className="text-sm font-semibold text-amber-900">
                  {cluster.items.length === 1 ? "Possible duplicate" : "Possible duplicates"}
                </h3>
                <span
                  className="text-xs font-semibold text-amber-900 bg-amber-100 rounded-full px-2 py-0.5"
                  style={{ fontVariantNumeric: "tabular-nums" }}
                  data-testid={`review-cluster-count-${cluster.clusterKey}`}
                >
                  {cluster.items.length}
                </span>
                {cluster.exclusive && cluster.items.length > 1 && (
                  <span className="ml-auto text-xs text-amber-800">
                    Only one of these can be right
                  </span>
                )}
              </div>

              <div className="px-4 pb-4 space-y-3">
                {cluster.items.map((item) => (
                  <ReviewRow
                    key={item.proposalId}
                    item={item}
                    busy={busyId === item.proposalId}
                    onSame={() => void answer(item, "same")}
                    onDifferent={() => void answer(item, "different")}
                    onCompare={() => setComparing(item)}
                  />
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
      )}

      <div className="px-6 py-4 bg-gray-50 border-t border-gray-200 flex justify-end">
        <button
          type="button"
          onClick={onClose}
          className="px-4 py-2 text-gray-700 hover:bg-gray-200 rounded-lg font-medium"
          data-testid="review-duplicates-close"
        >
          Done
        </button>
      </div>
    </ResponsiveModal>
  );
}

/**
 * `matched_on` in the user's words. BACKLOG-2502: the field that matched used to
 * reach the screen only inside a sentence; now it is a value, so it needs a
 * label. Unknown values pass through rather than being swallowed — a rule that
 * grows a new `matched_on` should read oddly, not invisibly.
 */
function matchedOnLabel(matchedOn: string): string {
  switch (matchedOn) {
    case "email":
      return "the same email address";
    case "phone":
      return "the same phone number";
    case "name":
    case "unique_name":
      return "the same full name";
    default:
      return matchedOn;
  }
}

function ReviewRow({
  item,
  busy,
  onSame,
  onDifferent,
  onCompare,
}: {
  item: ContactReviewItem;
  busy: boolean;
  onSame: () => void;
  onDifferent: () => void;
  onCompare: () => void;
}): React.ReactElement {
  return (
    <div
      className="rounded-lg bg-white border border-amber-200 px-4 py-3"
      data-testid={`review-item-${item.proposalId}`}
    >
      <div className="text-sm font-semibold text-gray-900">
        {item.contactName}
        <span className="font-normal text-gray-500"> · {item.sourceLabel}</span>
        {item.sourceName && <span className="font-normal text-gray-500"> — {item.sourceName}</span>}
      </div>

      {/*
        BACKLOG-2502 — SIX BLOCKS OF PROSE BECAME ONE LINE.

        What was here: the proposal's frozen `evidence.summary`, its
        `evidence.details` list (the source-record sentence, the matched-field
        sentence, and "Nothing has been linked…"), and two separately labelled
        axes — `Identity: possibly the same person` / `Relationship: possibly
        connected`. Six blocks per candidate, thirty at five candidates. The
        founder could not find the decision in it.

        THE PROSE IS NOT DELETED AND NOT REWRITTEN. It is frozen in
        `contact_link_proposals.evidence_json` and now renders behind the compare
        screen's "How we decided this". That freeze is deliberate —
        `databaseService.ts:3150`: *"a verdict is a labelled training/regression
        example and a label is only usable with the features AS THEY WERE WHEN
        THE HUMAN SAW THEM"* — which is why the fix is here, in what this screen
        RENDERS, and never in the generator. Editing the generator would leave
        every row already in the queue untouched AND relabel history.

        The two axes collapse to ONE statement: they are near-synonyms that both
        hedge, and side by side they read as two findings when there is one.
      */}
      <div className="text-sm text-gray-600 mt-1" data-testid={`review-summary-${item.proposalId}`}>
        {item.identityPhrase}
        {item.matchedOn ? ` — matched on ${matchedOnLabel(item.matchedOn)}` : ""}
      </div>

      <div className="mt-3 flex gap-2">
        <button
          type="button"
          onClick={onSame}
          disabled={busy}
          className="px-3 py-1.5 bg-gradient-to-r from-purple-500 to-pink-600 text-white text-sm font-semibold rounded-lg hover:from-purple-600 hover:to-pink-700 transition-all shadow-sm disabled:opacity-50"
          data-testid={`review-confirm-${item.proposalId}`}
        >
          The same person
        </button>
        <button
          type="button"
          onClick={onDifferent}
          disabled={busy}
          className="px-3 py-1.5 text-sm font-semibold text-orange-700 hover:bg-orange-50 rounded-lg transition-colors disabled:opacity-50"
          data-testid={`review-reject-${item.proposalId}`}
        >
          Different people
        </button>
        {/*
          BACKLOG-2502 — "perhaps we need to just list them all with the option
          to see the same compare window". The row settles what it can; anything
          it cannot goes to the compare screen, which is the detail surface for
          this decision and is not reinvented here.
        */}
        <button
          type="button"
          onClick={onCompare}
          disabled={busy}
          className="ml-auto px-3 py-1.5 text-sm font-semibold text-gray-600 hover:text-gray-900 hover:bg-gray-50 rounded-lg transition-colors disabled:opacity-50"
          data-testid={`review-compare-${item.proposalId}`}
        >
          Compare
        </button>
      </div>
    </div>
  );
}
