import React, { useEffect, useState } from "react";
import { useContactManualLink } from "../contact/hooks/useContactManualLink";
import type { LinkableSourceRecord, LinkSourceOutcome } from "@/types/contactProvenance";

/**
 * "These two ARE the same person" — the joining action (BACKLOG-2426).
 *
 * ===========================================================================
 * WHAT THIS SEARCHES, AND WHAT IT DOES NOT
 * ===========================================================================
 * UNCLAIMED SOURCE RECORDS ONLY — address-book entries no contact holds yet.
 * It does NOT search saved contacts, because joining two saved contacts is a
 * MERGE: both are real, both may carry transaction history, and both may appear
 * on exported audits. There is no merge implementation and no design for one.
 * The service refuses a claimed record and names the incumbent; this panel
 * never offers one.
 *
 * ===========================================================================
 * THE SECOND CONFIRMATION IS THE FEATURE, NOT A RETRY
 * ===========================================================================
 * If the user previously pressed `Unlink` on this exact pair, a
 * `different_people` verdict blocks it in both the crosswalk and the name rule.
 * A manual link must be able to overturn that — otherwise a mistaken unlink is
 * permanent and unexplained — but it must SAY SO FIRST. So the first attempt
 * returns `prior_rejection` and renders a disclosure; only the second call
 * carries `acknowledgedPriorRejection`. The founder hit this case himself.
 */

interface LinkSourceSearchProps {
  userId: string;
  contactId: string;
  contactName: string;
  onClose: () => void;
  /** Fired after a link is written, so the caller can refresh its own views. */
  onLinked?: () => void;
}

function describeRecord(record: LinkableSourceRecord): string {
  const bits = [record.emails[0], record.phones[0], record.company].filter(
    (b): b is string => typeof b === "string" && b.length > 0,
  );
  return bits.join(" · ");
}

export const LinkSourceSearch: React.FC<LinkSourceSearchProps> = ({
  userId,
  contactId,
  contactName,
  onClose,
  onLinked,
}) => {
  const { records, loading, searchFailed, search, link } = useContactManualLink(userId);
  const [query, setQuery] = useState("");
  const [pendingRejection, setPendingRejection] = useState<LinkableSourceRecord | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    search(query);
  }, [query, search]);

  const applyOutcome = (record: LinkableSourceRecord, outcome: LinkSourceOutcome | null): void => {
    if (outcome === null) {
      setFailure("That link could not be saved. Nothing was changed.");
      return;
    }
    if (outcome.ok) {
      setPendingRejection(null);
      setFailure(null);
      onLinked?.();
      onClose();
      return;
    }
    switch (outcome.reason) {
      case "prior_rejection":
        // Not an error — the disclosure this feature exists to make.
        setPendingRejection(record);
        setFailure(null);
        break;
      case "claimed":
        setFailure(
          "That record already belongs to another contact. Joining two saved contacts is not something Keepr can do yet.",
        );
        break;
      case "contact_removed":
        setFailure("This contact has been removed, so nothing can be linked to it.");
        break;
      case "record_not_found":
        setFailure("That record is no longer in your address book.");
        break;
      default:
        setFailure("That link could not be saved. Nothing was changed.");
        break;
    }
  };

  const attemptLink = async (record: LinkableSourceRecord, acknowledged: boolean): Promise<void> => {
    setBusy(true);
    try {
      applyOutcome(record, await link(contactId, record, acknowledged));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="p-4 space-y-3" data-testid="link-source-search">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold text-gray-900">Link a record to {contactName}</h3>
          <p className="text-xs text-gray-600 mt-0.5">
            Search your address books for another entry that is the same person.
          </p>
        </div>
        <button
          onClick={onClose}
          className="text-sm text-gray-500 hover:text-gray-800"
          data-testid="link-source-close"
        >
          Cancel
        </button>
      </div>

      <input
        type="text"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Search by name, email, phone or company"
        aria-label="Search for a record to link"
        className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm text-gray-900 bg-white"
        data-testid="link-source-input"
      />

      {pendingRejection && (
        <div
          className="p-3 rounded-lg border border-amber-300 bg-amber-50 space-y-2"
          data-testid="link-prior-rejection-warning"
        >
          <p className="text-sm text-gray-900">
            You previously said {pendingRejection.name ?? "this record"} was a different person.
            Linking it now replaces that answer.
          </p>
          <div className="flex gap-2">
            <button
              onClick={() => void attemptLink(pendingRejection, true)}
              disabled={busy}
              className="px-3 py-1.5 text-sm font-semibold text-white bg-amber-600 rounded-lg hover:bg-amber-700 disabled:opacity-60"
              data-testid="link-prior-rejection-confirm"
            >
              Link them anyway
            </button>
            <button
              onClick={() => setPendingRejection(null)}
              className="px-3 py-1.5 text-sm text-gray-700 rounded-lg hover:bg-gray-100"
              data-testid="link-prior-rejection-cancel"
            >
              Keep them separate
            </button>
          </div>
        </div>
      )}

      {failure && (
        <p className="text-sm text-red-700" data-testid="link-source-error">
          {failure}
        </p>
      )}

      {loading && (
        <p className="text-sm text-gray-500" data-testid="link-source-loading">
          Searching…
        </p>
      )}

      {/* A failed search is not an empty one, and must not say "nothing found". */}
      {!loading && searchFailed && (
        <p className="text-sm text-red-700" data-testid="link-source-search-failed">
          Your address books could not be searched just now.
        </p>
      )}

      {!loading && !searchFailed && records.length === 0 && (
        <p className="text-sm text-gray-500" data-testid="link-source-empty">
          No unlinked records match that search.
        </p>
      )}

      {!loading && !searchFailed && records.length > 0 && (
        <ul className="space-y-1" data-testid="link-source-results">
          {records.map((record) => (
            <li
              key={`${record.sourceType}:${record.sourceRecordId}`}
              data-testid={`link-source-result-${record.sourceType}-${record.sourceRecordId}`}
              className="flex items-center justify-between gap-3 p-2 rounded-lg hover:bg-gray-50"
            >
              <div className="min-w-0">
                <div className="text-sm font-medium text-gray-900 truncate">
                  {record.name ?? "Unnamed record"}
                </div>
                <div className="text-xs text-gray-600 truncate">
                  {record.sourceLabel}
                  {describeRecord(record) ? ` — ${describeRecord(record)}` : ""}
                </div>
              </div>
              <button
                onClick={() => void attemptLink(record, false)}
                disabled={busy}
                className="flex-shrink-0 px-3 py-1.5 text-sm font-semibold text-white bg-purple-600 rounded-lg hover:bg-purple-700 disabled:opacity-60"
                data-testid={`link-source-confirm-${record.sourceType}-${record.sourceRecordId}`}
              >
                Link
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
};

export default LinkSourceSearch;
