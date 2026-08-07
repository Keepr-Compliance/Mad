import React from "react";
import { useContactCompare } from "../contact/hooks/useContactCompare";
import type {
  ContactCompareColumn,
  CompareCommItem,
  CompareValue,
} from "@/types/contactProvenance";

/**
 * "Is this the same person?" — every record a contact is assembled from, side
 * by side (BACKLOG-2471 PR C).
 *
 * ===========================================================================
 * READ-ONLY, ON PURPOSE
 * ===========================================================================
 * No `Unlink`, no `Confirm`, no `Confirm & edit`. The approved mock draws all
 * three and PR D adds them; shipping a control here that either does nothing or
 * quietly performs PR D's write is the worse of the two ways to be early.
 * `×` closes the screen and decides nothing — which is exactly what `×` means
 * in the settled design.
 *
 * ===========================================================================
 * EVERY ROW RENDERS ON EVERY COLUMN, INCLUDING THE BLANK ONES
 * ===========================================================================
 * Founder decision, 2026-08-05: "Empty rows stay, blank, on source columns."
 * The eye reads ACROSS these columns, and a hidden row on one of them puts every
 * row below it out of line with its neighbours.
 *
 * ===========================================================================
 * TWO CELL TREATMENTS COME STRAIGHT FROM FOUNDER DECISION D5 (2026-08-06)
 * ===========================================================================
 *   Transactions, on a source record  -> "not a contact yet", muted italic.
 *   Recent communication, on a source -> that record's OWN messages, under a
 *                                        heading tagged "not linked".
 * Neither is a placeholder for missing data. A source record genuinely has no
 * transactions — only the saved contact does — and its messages genuinely are
 * not attributed to the contact yet.
 */

const FIELD_LABELS = {
  name: "Name",
  emails: "Emails",
  phone: "Phone",
  company: "Company",
  transactions: "Transactions",
} as const;

/** The literal the mock uses for a value a record does not carry. */
const NONE = "none";
/** D5, verbatim. A source record has no transactions of its own. */
const NOT_A_CONTACT_YET = "not a contact yet";
/** D5, verbatim. */
const NOT_LINKED = "not linked";

interface ContactCompareSourcesProps {
  userId: string;
  contactId: string;
  onClose: () => void;
  /**
   * BACKLOG-2502 seam, declared from this PR onward so that item is purely
   * additive and needs no new backend: the candidate that is NOT yet linked,
   * rendered as one more column, and the proposal `Confirm` would resolve.
   * Unused in PR C — the screen is read-only and nothing is proposed to it yet.
   */
  proposedSource?: { sourceType: string; sourceRecordId: string };
  proposalId?: string;
}

function formatWhen(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString(undefined, { day: "numeric", month: "short" });
}

/**
 * A field row. `matched` arrives already decided by the service — this
 * component deliberately performs NO value comparison of its own, because the
 * keys that define "the same number" live in `electron/` and a renderer-side
 * re-implementation is how two screens come to disagree about one phone.
 *
 * ADDRESSES AND NUMBERS ARE PRINTED IN FULL HERE. `maskEmail` / `maskPhone`
 * exist in `contactLinkEvidence.ts` and are deliberately NOT used — the full
 * reasoning is on `buildReason` in `electron/services/contactCompare.ts`. In
 * short: masking is for the review queue, "a screen the user may have open while
 * sharing their display"; THIS screen exists so the user can CHECK these values
 * against each other, and a masked value cannot be checked. Please do not
 * "fix" this to match the queue.
 */
const Row: React.FC<{
  testId: string;
  values: CompareValue[];
  emptyText?: string;
}> = ({ testId, values, emptyText = NONE }) => (
  <div data-testid={testId} className="py-0.5">
    {values.length === 0 ? (
      <div className="text-sm italic text-gray-400">{emptyText}</div>
    ) : (
      values.map(({ value, matched }) => (
        <div
          key={value}
          className={`font-mono text-[13px] break-words flex items-center gap-1.5 ${
            matched ? "text-green-700 font-semibold" : "text-gray-600"
          }`}
        >
          {value}
          {matched && (
            <span
              data-testid={`compare-match-${testId}`}
              className="font-sans text-[10px] font-bold uppercase tracking-wide rounded px-1 py-px bg-green-50 text-green-700 border border-green-200"
            >
              match
            </span>
          )}
        </div>
      ))
    )}
  </div>
);

const SectionHeading: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <h4 className="text-[11px] font-bold uppercase tracking-wider text-gray-400 mb-0.5 mt-2.5 flex items-center gap-1.5">
    {children}
  </h4>
);

const CommRow: React.FC<{ item: CompareCommItem }> = ({ item }) => (
  <div
    data-testid={`compare-comm-${item.id}`}
    className="py-1 border-t border-gray-100 first:border-t-0"
  >
    <div className="text-[13px] text-gray-900 font-medium leading-snug">
      {item.title || "(no subject)"}
    </div>
    <div className="font-mono text-[11px] text-gray-400 mt-px">
      {[item.channel, formatWhen(item.occurredAt), item.matchedIdentifier]
        .filter((b): b is string => !!b)
        .join(" · ")}
    </div>
  </div>
);

const Column: React.FC<{ column: ContactCompareColumn }> = ({ column }) => {
  const isSource = column.kind === "source";

  return (
    <div
      data-testid={`compare-column-${column.linkId}`}
      className={`p-4 min-w-0 ${isSource ? "bg-amber-50/60 border-l border-gray-200" : ""}`}
    >
      <div className="flex items-center gap-2 pb-2 mb-2 border-b border-gray-200">
        <div className="min-w-0">
          <div className="font-semibold text-sm text-gray-900 truncate">
            {column.displayName || "Unnamed"}
          </div>
          <div className="font-mono text-[10px] uppercase tracking-wide text-gray-400">
            {column.columnLabel}
          </div>
        </div>
        {isSource && (
          <span
            data-testid={`compare-source-tag-${column.linkId}`}
            className="ml-auto font-sans text-[10px] font-bold uppercase tracking-wide rounded px-1 py-px bg-amber-50 text-amber-800 border border-amber-300"
          >
            linked record
          </span>
        )}
      </div>

      {!column.sourceRecordPresent && (
        <div
          data-testid={`compare-absent-${column.linkId}`}
          className="text-[13px] text-gray-500 mb-2"
        >
          {/* The card already says this, in these words (ContactPreview's
              sources panel). Saying it differently here would be two answers to
              one question. */}
          This entry is no longer in that account.
        </div>
      )}

      <SectionHeading>{FIELD_LABELS.name}</SectionHeading>
      <Row
        testId={`compare-row-name-${column.linkId}`}
        values={column.name ? [column.name] : []}
      />

      <SectionHeading>{FIELD_LABELS.emails}</SectionHeading>
      <Row testId={`compare-row-emails-${column.linkId}`} values={column.emails} />

      <SectionHeading>{FIELD_LABELS.phone}</SectionHeading>
      <Row testId={`compare-row-phone-${column.linkId}`} values={column.phones} />

      <SectionHeading>{FIELD_LABELS.company}</SectionHeading>
      <Row
        testId={`compare-row-company-${column.linkId}`}
        values={column.company ? [{ value: column.company, matched: false }] : []}
      />

      <SectionHeading>{FIELD_LABELS.transactions}</SectionHeading>
      <Row
        testId={`compare-row-transactions-${column.linkId}`}
        values={column.transactions.map((value) => ({ value, matched: false }))}
        // D5: on a source record this is a statement, not an empty state.
        emptyText={isSource ? NOT_A_CONTACT_YET : NONE}
      />

      <div className="mt-3 pt-2 border-t border-gray-200">
        <SectionHeading>
          Recent communication
          {isSource && (
            <span
              data-testid={`compare-notlinked-${column.linkId}`}
              className="font-sans text-[10px] font-bold uppercase tracking-wide rounded px-1 py-px bg-amber-50 text-amber-800 border border-amber-300"
            >
              {NOT_LINKED}
            </span>
          )}
        </SectionHeading>
        <div data-testid={`compare-row-communication-${column.linkId}`}>
          {column.recentCommunication.length === 0 ? (
            <div className="text-sm italic text-gray-400">{NONE}</div>
          ) : (
            column.recentCommunication.map((item) => <CommRow key={item.id} item={item} />)
          )}
        </div>
      </div>
    </div>
  );
};

export const ContactCompareSources: React.FC<ContactCompareSourcesProps> = ({
  userId,
  contactId,
  onClose,
}) => {
  const { view, loading, failed } = useContactCompare(userId, contactId);

  return (
    <div
      data-testid="contact-compare-screen"
      className="bg-white border border-gray-200 rounded-xl overflow-hidden shadow-sm"
    >
      <div className="flex items-start gap-3 p-4 border-b border-gray-200">
        <div className="min-w-0">
          <h3 className="text-base font-semibold text-gray-900" data-testid="compare-title">
            {view?.title ?? "Compare sources"}
          </h3>
          {view && (
            <p className="text-[13px] text-gray-600 mt-0.5" data-testid="compare-reason">
              {view.reason}
            </p>
          )}
        </div>
        <button
          onClick={onClose}
          aria-label="Close compare"
          data-testid="compare-close"
          className="ml-auto flex-shrink-0 text-gray-400 hover:text-gray-900 rounded px-1.5 leading-none text-xl"
        >
          ×
        </button>
      </div>

      {loading && (
        <div className="p-4 text-sm text-gray-500" data-testid="compare-loading">
          Loading…
        </div>
      )}

      {!loading && failed && (
        <div className="p-4 text-sm text-gray-600" data-testid="compare-failed">
          These records could not be loaded just now.
        </div>
      )}

      {!loading && !failed && !view && (
        <div className="p-4 text-sm text-gray-600" data-testid="compare-empty">
          This contact has only one record, so there is nothing to compare.
        </div>
      )}

      {!loading && !failed && view && (
        <div
          data-testid="compare-columns"
          className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-[repeat(auto-fit,minmax(15rem,1fr))]"
        >
          {view.columns.map((column) => (
            <Column key={column.linkId} column={column} />
          ))}
        </div>
      )}
    </div>
  );
};

export default ContactCompareSources;
