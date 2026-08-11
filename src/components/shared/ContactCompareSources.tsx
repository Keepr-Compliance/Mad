import React, { useEffect, useState } from "react";
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
 * TWO CELL TREATMENTS BELONG TO A RECORD THAT BELONGS TO NOBODY
 * ===========================================================================
 *   Transactions, on a PROPOSED record  -> "not imported yet", muted italic
 *                                          (founder, 11 Aug — see the constant).
 *   Recent communication, on a PROPOSED -> that record's OWN messages, under a
 *                                          heading tagged "not linked" (D5).
 * Neither is a placeholder for missing data. A record nobody has imported is not
 * a party to a deal, and its messages genuinely reach nobody yet.
 *
 * BACKLOG-2628 — THE DISCRIMINATOR IS `proposed`, NOT `source`, AND THAT IS THE
 * WHOLE FIX. Both treatments used to hang off `kind === "source"`, which is the
 * same boolean that draws the `linked record` tag and the `Unlink` button. So a
 * record the founder had just confirmed as the same person read: `linked
 * record`, `Unlink` — and, two rows down, that it belonged to nobody. One
 * column, two opposite claims about one record.
 *
 * Once a record IS linked both rows say the plainest true thing instead: the
 * contact's transactions (it is on those deals, through the contact), and its
 * own messages with no tag (they reach the contact now — that is what linking
 * did).
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
/**
 * A candidate's Transactions row. FOUNDER DECISION, 11 Aug (BACKLOG-2628).
 *
 * THREE POSITIONS WERE TAKEN ON THIS ONE CELL IN FIVE DAYS. Recording all three
 * so no later reader restores an earlier one believing it is the live decision:
 *
 *   D5, 6 Aug          "not a contact yet"        SUPERSEDED
 *   11 Aug, earlier    a real lookup, else "none" SUPERSEDED — built, discarded
 *   11 Aug, current    "not imported yet"         THIS
 *
 * The founder's reasoning, and the reason this is the one that lasts: **import**
 * is the word he uses for the action that turns an address-book record into a
 * contact, so this names what the user actually DOES. "not a contact yet"
 * described an internal state, and "none" reported a count for something that
 * cannot have one.
 */
const NOT_IMPORTED_YET = "not imported yet";
/** D5, verbatim, and still in force — the founder changed only the row above. */
const NOT_LINKED = "not linked";
/**
 * BACKLOG-2502 — the review queue's candidate. Deliberately NOT the same string
 * as `NOT_LINKED` above, which is about that record's MESSAGES rather than the
 * record itself. Two different claims must not share one word.
 *
 * Since BACKLOG-2628 both appear on the same column — this one in the header,
 * `NOT_LINKED` on the communication heading — so the distinction is now visible
 * rather than merely stated. That is not a duplication to collapse: the header
 * says the RECORD is unclaimed, the heading says those MESSAGES reach nobody.
 */
const NOT_LINKED_YET = "not linked yet";

interface ContactCompareSourcesProps {
  userId: string;
  contactId: string;
  /**
   * BACKLOG-2502 — THIS SCREEN'S `×` POPS THIS SCREEN, wherever it is mounted.
   *
   * Founder model, 2026-08-09, by his own analogy to the texts preview on
   * transaction details: the surface is a LIFO stack, and the `×` on the TOP
   * layer takes that layer off. Inside the duplicates modal this screen IS the
   * top layer, so its `×` returns the user to the list with the list intact;
   * from a contact card it is the only layer, so its `×` returns the card.
   * Same control, same meaning, no flag deciding which — `useContactCommViewers`
   * makes the same promise for the email and text viewers it mounts over the
   * card, and this is that promise, not a second mechanism.
   */
  onClose: () => void;
  /**
   * Detach ONE source record (BACKLOG-2471 PR D).
   *
   * This is `Contacts.tsx`'s OWN `handleUnlinkSource` — the same function the
   * Sources panel calls, reaching the same shipped `contacts:unlink-source`.
   * The compare screen adds no unlink behaviour of its own, which is what keeps
   * PR E's reattach work a single line to change instead of two.
   */
  onUnlinkSource?: (linkId: string) => void;
  /** The link currently being detached, so its button can say so. */
  unlinkingLinkId?: string | null;
  /** Confirm succeeded — the caller closes, and refreshes what it owns. */
  onConfirmed?: () => void;
  /** `Confirm & edit`: same write, then open the contact's form. */
  onConfirmedAndEdit?: () => void;
  /**
   * BACKLOG-2502 seam, declared from this PR onward so that item is purely
   * additive and needs no new backend: the candidate that is NOT yet linked,
   * rendered as one more column, and the proposal `Confirm` would resolve.
   * Unused in PR C — the screen is read-only and nothing is proposed to it yet.
   */
  proposedSource?: { sourceType: string; sourceRecordId: string };
  proposalId?: string;
  /**
   * BACKLOG-2502 R8 — ask for the contact and its own records as ONE column.
   *
   * FORWARDED, NEVER READ. This component renders whatever columns it is given
   * and asks no question about where they came from; the collapse happens in
   * `contactCompare.ts`, where the keys that decide "the same phone number"
   * live. That is what keeps ONE component serving both surfaces: the two
   * callers differ in the data they ask for, never in the markup they get.
   */
  collapseContactSources?: boolean;
  /**
   * BACKLOG-2502 — "different people", on the QUEUE route only.
   *
   * The two surfaces are NOT harmonised, and this is where that shows: from the
   * review queue nothing is linked yet, so the decision is about a PROPOSAL and
   * a reject belongs in the footer. From a contact the records ARE linked, so
   * rejection belongs on the record it removes and the footer carries none.
   * Both are correct; neither overrides the other.
   */
  onRejected?: () => void;
  /**
   * BACKLOG-2502 — the prose the founder moved off the list, behind a control.
   *
   * These sentences are FROZEN in `contact_link_proposals.evidence_json` and are
   * passed in by the caller rather than re-derived. Nothing is deleted; it stops
   * being the default view.
   */
  why?: { summary: string; details: string[]; identityPhrase?: string };
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

const Column: React.FC<{
  column: ContactCompareColumn;
  onUnlinkSource?: (linkId: string) => void;
  unlinkingLinkId?: string | null;
}> = ({ column, onUnlinkSource, unlinkingLinkId }) => {
  /** Linked. Draws the amber column, the `linked record` tag and `Unlink`. */
  const isSource = column.kind === "source";
  /**
   * Claimed by nobody — the review queue's candidate, and the ONLY column the
   * two D5 treatments belong on (BACKLOG-2628).
   *
   * Kept as its own boolean rather than folded into the JSX conditions: these
   * two rows and `isSource`'s three affordances answer opposite questions, and
   * one column previously read both ways because a single boolean was asked
   * both.
   */
  const isProposed = column.kind === "proposed";

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
        {column.kind === "proposed" && (
          <span
            data-testid={`compare-proposed-tag-${column.linkId}`}
            className="ml-auto font-sans text-[10px] font-bold uppercase tracking-wide rounded px-1 py-px bg-blue-50 text-blue-800 border border-blue-300"
          >
            {NOT_LINKED_YET}
          </span>
        )}
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
        /*
          On a record nobody has imported this is a STATEMENT, not an empty
          state — "not imported yet" (BACKLOG-2628, founder, 11 Aug). On a LINKED
          record the cell prints the contact's deals, because it is on them
          through that contact, and falls back to the ordinary "none" when the
          contact is on none.

          THE DISCRIMINATOR IS `isProposed`, AND THAT IS THIS ITEM'S FIX. It was
          `isSource` — the same boolean that draws the `linked record` tag and
          `Unlink` — so a record the user had just confirmed as the same person
          was told two rows below that it belonged to nobody.
        */
        emptyText={isProposed ? NOT_IMPORTED_YET : NONE}
      />

      <div className="mt-3 pt-2 border-t border-gray-200">
        <SectionHeading>
          Recent communication
          {/*
            D5's tag, on the column it was written for. A LINKED record's
            messages reach the contact — that is what linking did — so tagging
            them "not linked" contradicted the `linked record` tag in the same
            column's header (BACKLOG-2628).
          */}
          {isProposed && (
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

      {/*
        UNLINK SITS ON THE RECORD IT REMOVES, and never on the contact's own
        column. Founder, 2026-08-05: "we can't unlink a contact from itself if
        that's what you are asking so we should hide the button." The same
        sentence is why there is no footer reject — one control, on the thing it
        acts on, rather than two controls doing one job.

        EVERY source column is detachable BY CONSTRUCTION, so this is not gated
        on `canUnlinkSource`: PR C's column rule absorbs the one record a contact
        was created from into column 1, which leaves either an attached record
        (detachable by `isAttachedSource`) or one of two-or-more links
        (detachable by length). Re-spelling the predicate here would hide a
        future break in that rule; `ContactCompareSources.test.tsx` asserts the
        invariant over every link shape instead.
      */}
      {isSource && onUnlinkSource && (
        <button
          onClick={() => onUnlinkSource(column.linkId)}
          disabled={unlinkingLinkId === column.linkId}
          data-testid={`compare-unlink-${column.linkId}`}
          className="mt-3 w-full text-[13px] font-semibold py-1.5 rounded-lg border border-gray-300 text-gray-600 hover:border-red-300 hover:text-red-600 hover:bg-red-50 transition-colors disabled:opacity-60 disabled:cursor-wait"
        >
          {unlinkingLinkId === column.linkId ? "Unlinking…" : "Unlink"}
        </button>
      )}
    </div>
  );
};

export const ContactCompareSources: React.FC<ContactCompareSourcesProps> = ({
  userId,
  contactId,
  onClose,
  onUnlinkSource,
  unlinkingLinkId,
  onConfirmed,
  onConfirmedAndEdit,
  proposedSource,
  proposalId,
  collapseContactSources,
  onRejected,
  why,
}) => {
  const { view, loading, failed, reload, confirm } = useContactCompare(
    userId,
    contactId,
    proposedSource,
    proposalId,
    collapseContactSources,
  );
  const [whyOpen, setWhyOpen] = useState(false);
  /**
   * A press is in flight. Plain `useState` — this is local UI state, not a
   * didMount guard, so StrictMode's double-invoke just re-runs the initialiser.
   *
   * It stops the double CLICK, which is the one that happens. It is not the
   * durable guard: `confirmContactSources` skips links that already carry the
   * verdict, so a second press cannot write a duplicate even if this flag were
   * removed.
   */
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  const columnCount = view?.columns.length ?? 0;

  const handleConfirm = async (thenEdit: boolean) => {
    if (busy) return;
    setBusy(true);
    setFailure(null);
    try {
      const outcome = await confirm();
      // `ok: true, linked: false` is the merge guard: the record is claimed by a
      // different contact, so the verdict stands and NO link was made. Reporting
      // that as success would tell the user two records were joined when they
      // were not.
      if (outcome?.ok && proposalId && outcome.linked === false) {
        setFailure(
          "That record is already saved to a different contact, so it was not joined here.",
        );
        return;
      }
      if (!outcome?.ok) {
        // A failed write must not read as a successful one that changed
        // nothing: the screen stays open and says so.
        setFailure(outcome?.error ?? "That could not be saved just now.");
        return;
      }
      if (thenEdit) onConfirmedAndEdit?.();
      else onConfirmed?.();
    } finally {
      setBusy(false);
    }
  };

  /**
   * "Different people", on the queue route. Reaches the SHIPPED
   * `contacts:reject-link` (`rejectProposal`), which records the verdict and
   * resolves the proposal — and creates no link and removes none.
   */
  const handleReject = async () => {
    if (busy || !proposalId) return;
    setBusy(true);
    setFailure(null);
    try {
      const result = await window.api.contacts.rejectLink(userId, proposalId);
      if (!result.success) {
        setFailure(result.error ?? "That could not be saved just now.");
        return;
      }
      onRejected?.();
    } finally {
      setBusy(false);
    }
  };

  /**
   * Detach, then look again.
   *
   * The reload is what decides whether the screen survives: unlinking the last
   * source column leaves nothing to compare, and the mock's own footer says so
   * — "unlink them all and the contact stands alone". Rather than predicting
   * that in the renderer, we ask the service and close if it says there is
   * nothing left.
   */
  const handleUnlink = (linkId: string) => {
    onUnlinkSource?.(linkId);
  };

  useEffect(() => {
    if (!unlinkingLinkId && !loading) reload();
    // Re-reads when an unlink FINISHES (the id goes back to null). Value
    // comparison on the prop, not a skip-first-run guard — StrictMode is on
    // app-wide and a didMount guard here would silently skip the real first
    // render in production. The dependency is deliberately just the id: adding
    // `reload` would re-fire on every render of the parent.
  }, [unlinkingLinkId]);

  useEffect(() => {
    if (!loading && !failed && view === null && onUnlinkSource) onClose();
    // Nothing left to compare -> return to the card. Gated on `onUnlinkSource`
    // so a read-only mount (PR G's callers, tests) still renders the empty
    // state rather than closing itself. Deps are the three values the condition
    // reads; `onClose` is deliberately absent so a caller passing a fresh arrow
    // each render cannot re-fire it.
  }, [loading, failed, view]);

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
            <Column
              key={column.linkId}
              column={column}
              onUnlinkSource={onUnlinkSource ? handleUnlink : undefined}
              unlinkingLinkId={unlinkingLinkId}
            />
          ))}
        </div>
      )}

      {/*
        BACKLOG-2502 — "add the verbose description that explains why in a button
        on the compare screens that says why or how we decided this".

        This IS the block the review list used to print per candidate, moved
        rather than rewritten. The sentences are frozen in the proposal's
        `evidence_json` and arrive as props; nothing regenerates them.
      */}
      {!loading && !failed && view && why && (
        <div className="px-4 pb-3 border-t border-gray-200 pt-3">
          <button
            onClick={() => setWhyOpen((open) => !open)}
            aria-expanded={whyOpen}
            data-testid="compare-why-toggle"
            className="text-[13px] font-semibold text-gray-600 hover:text-gray-900 underline underline-offset-2"
          >
            {whyOpen ? "Hide how we decided this" : "How we decided this"}
          </button>
          {whyOpen && (
            <div className="mt-2" data-testid="compare-why-body">
              <p className="text-[13px] text-gray-700">{why.summary}</p>
              {why.details.length > 0 && (
                <ul className="mt-1.5 space-y-0.5">
                  {why.details.map((detail) => (
                    <li key={detail} className="text-xs text-gray-500">
                      {detail}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </div>
      )}

      {!loading && !failed && view && (onConfirmed || onConfirmedAndEdit) && (
        <div
          data-testid="compare-footer"
          className="flex items-center gap-2 flex-wrap p-3 border-t border-gray-200 bg-gray-50"
        >
          {failure && (
            <span className="text-[13px] text-red-600 w-full" data-testid="compare-confirm-error">
              {failure}
            </span>
          )}
          {view.isConfirmed ? (
            <span className="text-[13px] text-gray-500" data-testid="compare-already-confirmed">
              You have confirmed these records are the same person.
            </span>
          ) : (
            <>
              <span className="flex-1" />
              <button
                onClick={() => void handleConfirm(true)}
                disabled={busy}
                data-testid="compare-confirm-edit"
                className="text-[13px] font-semibold px-3 py-1.5 rounded-lg border border-gray-300 text-gray-700 hover:border-gray-400 hover:text-gray-900 transition-colors disabled:opacity-60"
              >
                Confirm &amp; edit
              </button>
              {/*
                BACKLOG-2502 — "different people", QUEUE ROUTE ONLY.

                Present because nothing is linked yet and the decision is about a
                proposal. On the contact route this is absent and `Unlink` sits on
                the record it removes instead. The settled design says the two
                surfaces are not to be harmonised — this conditional is where that
                is enforced, and collapsing it is the change that would break it.
              */}
              {onRejected && proposalId && (
                <button
                  onClick={() => void handleReject()}
                  disabled={busy}
                  data-testid="compare-reject-proposal"
                  className="text-[13px] font-semibold px-3 py-1.5 rounded-lg border border-red-300 text-red-700 hover:bg-red-50 transition-colors disabled:opacity-60"
                >
                  Different people
                </button>
              )}
              <button
                onClick={() => void handleConfirm(false)}
                disabled={busy}
                data-testid="compare-confirm"
                className="text-[13px] font-semibold px-3 py-1.5 rounded-lg bg-green-600 text-white hover:bg-green-700 transition-colors disabled:opacity-60"
              >
                {busy ? "Saving…" : columnCount > 2 ? "Confirm all" : "Confirm"}
              </button>
              <span className="text-[12px] text-gray-400 w-full" data-testid="compare-foothint">
                Unlink sits on the record it removes. Confirming returns you to the list,
                keeping your filter and search.
              </span>
            </>
          )}
        </div>
      )}
    </div>
  );
};

export default ContactCompareSources;
