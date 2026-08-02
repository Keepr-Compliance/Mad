import React, { useCallback, useEffect, useState } from "react";
import { ResponsiveModal } from "../../common/ResponsiveModal";
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
      try {
        const result =
          verdict === "same"
            ? await window.api.contacts.confirmLink(userId, item.proposalId)
            : await window.api.contacts.rejectLink(userId, item.proposalId);
        if (!result.success) {
          setError(result.error ?? "That answer could not be saved.");
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
        <p className="text-sm text-gray-600 mt-1">
          These were <span className="font-semibold">not</span> linked automatically because we
          could not tell. Nothing changes until you answer.
        </p>
      </div>

      <div className="px-6 py-4 overflow-y-auto">
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
                <h3 className="text-sm font-semibold text-amber-900">{cluster.question}</h3>
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
                  />
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>

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

function ReviewRow({
  item,
  busy,
  onSame,
  onDifferent,
}: {
  item: ContactReviewItem;
  busy: boolean;
  onSame: () => void;
  onDifferent: () => void;
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

      {/* The evidence. Sentences, not a score — this is what the user actually
          decides on. */}
      {item.evidence && (
        <p className="text-sm text-gray-700 mt-1.5" data-testid={`review-evidence-${item.proposalId}`}>
          {item.evidence.summary}
        </p>
      )}
      {item.evidence?.details?.length ? (
        <ul className="mt-1.5 space-y-0.5">
          {item.evidence.details.map((detail, idx) => (
            <li key={idx} className="text-xs text-gray-500">
              {detail}
            </li>
          ))}
        </ul>
      ) : null}

      {/* The two axes, side by side and separately labelled so neither can be
          read as a restatement of the other. */}
      <div className="mt-2.5 flex flex-wrap gap-x-4 gap-y-1 text-xs">
        <span className="text-gray-500">
          Identity:{" "}
          <span className="font-semibold text-gray-800" data-testid={`review-identity-${item.proposalId}`}>
            {item.identityPhrase}
          </span>
        </span>
        <span className="text-gray-500">
          Relationship:{" "}
          <span
            className="font-semibold text-gray-800"
            data-testid={`review-relationship-${item.proposalId}`}
          >
            {item.relationshipPhrase}
          </span>
        </span>
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
      </div>
    </div>
  );
}
