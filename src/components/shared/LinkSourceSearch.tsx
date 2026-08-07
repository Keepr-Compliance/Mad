import React, { useCallback, useEffect, useMemo, useState } from "react";
import { useContactManualLink } from "../contact/hooks/useContactManualLink";
import { ContactSearchList } from "./ContactSearchList";
import type { ExtendedContact } from "../../types/components";
import type {
  LinkableSourceRecord,
  LinkSourceOutcome,
  SourceRecordRef,
} from "@/types/contactProvenance";

/**
 * "These two ARE the same person" — the joining action (BACKLOG-2426),
 * rebuilt on the shared picker (BACKLOG-2591).
 *
 * ===========================================================================
 * WHY THIS RENDERS `ContactSearchList` BUT NOT ITS DATA
 * ===========================================================================
 * The founder asked why linking did not simply reuse the transaction picker.
 * It now does — for the LIST. It deliberately does NOT reuse the picker's DATA,
 * and that distinction is the whole correctness of this screen:
 *
 * `contacts:get-available` applies THREE exclusions — the crosswalk, then
 * `emailClaimedByImported`, then `phoneClaimedByImported`. The last two are
 * right for an import picker ("you already have this person") and WRONG here: a
 * record unclaimed in the crosswalk whose email merely resembles a saved contact
 * is precisely what manual linking exists to attach, and `get-available` hides
 * it. So the rows come from `findLinkableSourceRecords`, which filters on the
 * crosswalk and nothing else.
 *
 * Reusing `externalContacts` would have looked obviously right and removed the
 * feature's purpose while every existing test stayed green.
 *
 * ===========================================================================
 * WHAT IT OFFERS, AND WHAT IT MAY NEVER OFFER
 * ===========================================================================
 * UNCLAIMED SOURCE RECORDS ONLY. `contacts={[]}` is load-bearing, not
 * incidental: `ContactSearchList` renders saved contacts by default, and
 * offering one here would invite the merge this epic forbids. `onExternalSelect`
 * (rather than `onImportContact`) is the other half — it selects a record by
 * identity and leaves no import path reachable, so this surface cannot create a
 * contact.
 *
 * ===========================================================================
 * THE SECOND CONFIRMATION IS THE FEATURE, NOT A RETRY
 * ===========================================================================
 * If the user previously pressed `Unlink` on a pair, a `different_people`
 * verdict blocks it. Linking must be able to overturn that — otherwise a
 * mistaken unlink is permanent and unexplained — but it must SAY SO FIRST. The
 * first call returns `prior_rejection` for those records and writes nothing for
 * them; the disclosure lists them and asks ONCE for the whole batch.
 */

interface LinkSourceSearchProps {
  userId: string;
  contactId: string;
  contactName: string;
  onClose: () => void;
  /** Fired after at least one link is written, so the caller can refresh. */
  onLinked?: () => void;
}

/** The synthetic row id — unique per record, and reversible back to the pair. */
function rowId(record: SourceRecordRef): string {
  return `${record.sourceType}:${record.sourceRecordId}`;
}

/**
 * A linkable record as the shared picker expects to receive it.
 *
 * `is_message_derived: true` is what marks a row EXTERNAL to `ContactSearchList`
 * — the same stamp `useContactList` applies to `get-available`'s rows — so these
 * render through the identical path as the transaction pickers' address-book
 * rows. `last_communication_at` carries the recency the picker sorts on by
 * default, which the old bespoke list never used.
 */
function toPickerRow(record: LinkableSourceRecord): ExtendedContact {
  return {
    id: rowId(record),
    name: record.name ?? "",
    display_name: record.name ?? "",
    email: record.emails[0] ?? null,
    phone: record.phones[0] ?? null,
    allEmails: record.emails,
    allPhones: record.phones,
    company: record.company,
    source: record.sourceType,
    last_communication_at: record.lastMessageAt,
    is_message_derived: true,
    isFromDatabase: false,
  } as unknown as ExtendedContact;
}

export const LinkSourceSearch: React.FC<LinkSourceSearchProps> = ({
  userId,
  contactId,
  contactName,
  onClose,
  onLinked,
}) => {
  const { records, loading, loadFailed, load, link } = useContactManualLink(userId);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [pendingRejections, setPendingRejections] = useState<LinkableSourceRecord[]>([]);
  const [failure, setFailure] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // One read per open — see the hook's docblock.
  useEffect(() => {
    load();
  }, [load]);

  const byId = useMemo(() => {
    const map = new Map<string, LinkableSourceRecord>();
    for (const r of records) map.set(rowId(r), r);
    return map;
  }, [records]);

  const pickerRows = useMemo(() => records.map(toPickerRow), [records]);
  const selectedRecords = useMemo(
    () => selectedIds.map((id) => byId.get(id)).filter((r): r is LinkableSourceRecord => !!r),
    [selectedIds, byId],
  );

  const handleExternalSelect = useCallback((contact: ExtendedContact) => {
    setSelectedIds((prev) => (prev.includes(contact.id) ? prev : [...prev, contact.id]));
  }, []);

  const applyOutcomes = (
    attempted: LinkableSourceRecord[],
    outcomes: LinkSourceOutcome[] | null,
  ): void => {
    if (outcomes === null) {
      setFailure("Those links could not be saved. Nothing was changed.");
      return;
    }

    const rejected = attempted.filter(
      (_r, i) => outcomes[i] && !outcomes[i].ok && outcomes[i].reason === "prior_rejection",
    );
    const linked = outcomes.filter((o) => o.ok).length;
    const claimed = outcomes.filter((o) => !o.ok && o.reason === "claimed").length;

    if (linked > 0) onLinked?.();

    if (rejected.length > 0) {
      // Not an error — the disclosure this feature exists to make. Anything that
      // DID link above is already written; only these are still outstanding.
      setPendingRejections(rejected);
      setSelectedIds(rejected.map(rowId));
      setFailure(null);
      return;
    }

    if (claimed > 0 && linked === 0) {
      setFailure(
        "Those records already belong to another contact. Joining two saved contacts is not something Keepr can do yet.",
      );
      setSelectedIds([]);
      return;
    }

    onClose();
  };

  const commit = async (toLink: LinkableSourceRecord[], acknowledged: boolean): Promise<void> => {
    if (toLink.length === 0) return;
    setBusy(true);
    try {
      const refs: SourceRecordRef[] = toLink.map((r) => ({
        sourceType: r.sourceType,
        sourceRecordId: r.sourceRecordId,
      }));
      applyOutcomes(toLink, await link(contactId, refs, acknowledged ? refs : undefined));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col min-h-0 p-4 gap-3" data-testid="link-source-search">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold text-gray-900">Link records to {contactName}</h3>
          <p className="text-xs text-gray-600 mt-0.5">
            Pick any address-book entries that are the same person. You can choose more than one.
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

      {pendingRejections.length > 0 && (
        <div
          className="p-3 rounded-lg border border-amber-300 bg-amber-50 space-y-2"
          data-testid="link-prior-rejection-warning"
        >
          <p className="text-sm text-gray-900">
            You previously said {pendingRejections.length === 1 ? "this record was" : "these records were"}{" "}
            a different person: {pendingRejections.map((r) => r.name ?? "an unnamed record").join(", ")}.
            Linking now replaces that answer.
          </p>
          <div className="flex gap-2">
            <button
              onClick={() => void commit(pendingRejections, true)}
              disabled={busy}
              className="px-3 py-1.5 text-sm font-semibold text-white bg-amber-600 rounded-lg hover:bg-amber-700 disabled:opacity-60"
              data-testid="link-prior-rejection-confirm"
            >
              Link them anyway
            </button>
            <button
              onClick={() => {
                setPendingRejections([]);
                setSelectedIds([]);
              }}
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

      {/*
        `contacts={[]}` — see the header comment. A saved contact must never be
        offered here. `onExternalSelect` (never `onImportContact`) is what makes
        a row a LINK rather than an import.

        `error` is passed so a failed load stays distinguishable from an empty
        address book: without it this swap would inherit the conflation the
        transaction pickers still have (BACKLOG-2592).
      */}
      <div className="flex-1 min-h-0 border border-gray-200 rounded-lg overflow-hidden">
        <ContactSearchList
          contacts={[]}
          externalContacts={pickerRows}
          selectedIds={selectedIds}
          onSelectionChange={setSelectedIds}
          onExternalSelect={handleExternalSelect}
          selectionMode="add"
          showDetailLine
          isLoading={loading}
          error={loadFailed ? "Your address books could not be searched just now." : null}
          searchPlaceholder="Search by name, email, phone or company"
          className="h-full"
        />
      </div>

      {selectedRecords.length > 0 && (
        <div className="space-y-2" data-testid="link-source-selected">
          <div className="flex flex-wrap gap-1.5">
            {selectedRecords.map((record) => (
              <span
                key={rowId(record)}
                className="inline-flex items-center gap-1 px-2 py-1 text-xs font-medium text-purple-700 bg-purple-100 rounded-full"
                data-testid={`link-source-chip-${record.sourceType}-${record.sourceRecordId}`}
              >
                {record.name ?? "Unnamed record"}
                <button
                  onClick={() => setSelectedIds((prev) => prev.filter((id) => id !== rowId(record)))}
                  aria-label={`Remove ${record.name ?? "record"}`}
                  className="text-purple-500 hover:text-purple-800"
                >
                  ×
                </button>
              </span>
            ))}
          </div>
          <button
            onClick={() => void commit(selectedRecords, false)}
            disabled={busy}
            className="px-3.5 py-1.5 text-sm font-semibold text-white bg-purple-600 rounded-lg hover:bg-purple-700 disabled:opacity-60"
            data-testid="link-source-commit"
          >
            {busy
              ? "Linking…"
              : `Link ${selectedRecords.length} record${selectedRecords.length === 1 ? "" : "s"}`}
          </button>
        </div>
      )}
    </div>
  );
};

export default LinkSourceSearch;
