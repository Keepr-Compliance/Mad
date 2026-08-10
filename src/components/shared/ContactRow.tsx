import React from "react";
import type { ExtendedContact } from "../../types/components";
import type { ContactLinkBadge } from "../../../electron/types/models";
import { labelForContact } from "../../utils/contactDisplayLabel";
import { sourceDisplayLabel } from "./SourcePill";

/**
 * BACKLOG-2626 — the three badges, as WORDS THE FOUNDER CHOSE.
 *
 * Exported so the Sort control's `Autolinked` option and this row cannot drift
 * apart: they are one filter and one label for the same set, and two string
 * literals in two files is how "Needs review" survived in one place after being
 * renamed in the other.
 *
 * `suggestion` IS NOT HERE ANY MORE — it is the only one of the three whose
 * label carries a number, so it cannot be a constant. `badgeLabel()` below is
 * the single place all three are worded; this map remains only because the Sort
 * control names the `autolinked` SET, which has no contact and therefore no
 * count. Reach for `badgeLabel()` unless you are labelling a filter.
 */
export const BADGE_LABELS: Record<Exclude<ContactLinkBadge, "suggestion">, string> = {
  autolinked: "Autolinked",
  user_linked: "You linked these",
};

/**
 * THE BADGE'S WORDS — BACKLOG-2626, comment `d84dc2f6`.
 *
 * > *"It showed the suggestions pill — I'd rather call it X duplicates found or
 * > something that a user can understand as duplicates found."*
 *
 * `Suggestion` named the app's INTERNAL CATEGORY. It told the user a suggestion
 * existed without saying what it was about or how many, which is the one
 * question the badge exists to answer: how much is outstanding on this contact.
 * `Suggestion` cannot distinguish one question from four.
 *
 * The replacement is the COUNT plus the NOUN THIS SURFACE ALREADY USES. The
 * header button says "Review N possible duplicates" and the queue is titled
 * "Possible duplicates"; a third name for the same concept is how a user meets
 * three ideas where there is one.
 *
 * NOT "action required", which he also floated and which is REJECTED: these are
 * optional, the queue's own copy promises *"nothing changes until you answer"*,
 * and he ruled the sibling badge a lens rather than a queue for exactly this
 * reason. A badge that demands would contradict the screen it points at.
 *
 * The other two are UNCHANGED — `Autolinked` and `You linked these` already say
 * what happened in plain words. Only the suggestion state was named after its
 * internal concept.
 *
 * ON THE TWO NUMBERS THAT CAN NOW SHARE A ROW (his explicit question): this
 * badge counts OPEN QUESTIONS while `N records combined` beside it counts
 * RECORDS ATTACHED. They can appear together and they count different things.
 * They no longer collide because each now names its own noun and the tenses
 * separate them — "combined" is done, "possible duplicates" is outstanding. It
 * was `Suggestion` beside "5 records combined" that could not be read, because
 * only one of the two said what it counted. Both strings are asserted in one
 * test so they cannot drift apart again (`14617008`'s standing instruction).
 */
export function badgeLabel(state: {
  badge: ContactLinkBadge;
  openQuestions: number;
}): string {
  if (state.badge !== "suggestion") return BADGE_LABELS[state.badge];
  // Singular at one. "1 possible duplicates" is the kind of small wrongness
  // that makes a user distrust the number beside it.
  return state.openQuestions === 1
    ? "1 possible duplicate"
    : `${state.openQuestions} possible duplicates`;
}

/**
 * A LENS, NOT AN ALERT — founder, `11abce67` on BACKLOG-2471.
 *
 * `Autolinked` is deliberately NOT amber any more. The set it names is the set
 * the matcher was CONFIDENT about; the genuinely uncertain ones are the open
 * questions, and those are the only ones that get a colour asking for attention.
 */
const BADGE_STYLES: Record<ContactLinkBadge, string> = {
  suggestion: "bg-indigo-50 text-indigo-700 border-indigo-200",
  autolinked: "bg-slate-50 text-slate-600 border-slate-200",
  user_linked: "bg-green-50 text-green-700 border-green-200",
};

export interface ContactRowProps {
  /** The contact to display */
  contact: ExtendedContact;
  /**
   * Whether this is an external contact (from Contacts App, not yet imported).
   * Retained for API compatibility; as of BACKLOG-2356 the row is name-only and
   * no longer renders source/import-status pills, so this no longer affects
   * rendering. Import gating is driven by `showImportButton` from the parent.
   */
  isExternal?: boolean;
  /** Whether this contact is currently selected */
  isSelected?: boolean;
  /** Whether this contact has been added to the transaction */
  isAdded?: boolean;
  /** Whether this contact is currently being added (loading state) */
  isAdding?: boolean;
  /** Whether to show a checkbox for selection */
  showCheckbox?: boolean;
  /** Whether to show import button for external contacts */
  showImportButton?: boolean;
  /**
   * Whether to show a "+ Add" affordance (BACKLOG-2400 two-pane picker). Unlike
   * `showImportButton` (which calls `onImport` to import WITHOUT selecting), this
   * button calls `onSelect` — the row's add-to-selection action — so a single
   * click moves the contact into the "Added" column. Used by the
   * ContactAssignmentStep two-pane selection context ONLY; every other consumer
   * leaves it `false` (default) and is unaffected.
   */
  showAddButton?: boolean;
  /**
   * Compact mode (BACKLOG-1898 Phase-1 layout polish). Opt-in, default `false`
   * so shared consumers (the transaction add-contact flows) are unaffected.
   * When `true`:
   * - The avatar circle is not rendered.
   * - The per-row "+ Add Contact" button is never rendered (import happens via
   *   the detail pane's Import button instead).
   *
   * Note (BACKLOG-2356): rows are now name-only in every mode, so `compact` no
   * longer changes pill visibility (pills were removed entirely).
   */
  compact?: boolean;
  /**
   * Render a second line under the name: source, email, phone, company
   * (BACKLOG-2591).
   *
   * DEFAULT FALSE, AND THE DEFAULT IS THE WHOLE POINT. BACKLOG-2356 removed the
   * secondary line from every picker row deliberately — "full details live in
   * the contact detail/preview pane" — and that decision STANDS everywhere
   * except one surface.
   *
   * It comes back ONLY where the row is itself the surface on which an IDENTITY
   * DECISION is made: manual linking (BACKLOG-2426), where the user must tell
   *
   *   - two RECORDS of one person (link them), from
   *   - two DIFFERENT PEOPLE who share a name (never link them).
   *
   * Same-name-different-person is the exact failure this epic exists to prevent
   * — it is why `contact_link_proposals` carries `name_not_unique` and
   * `name_generational_suffix` reasons at all. Two rows both reading "Robin
   * Marsh" cannot express that difference, so a name-only row makes the decision
   * unanswerable.
   *
   * Every other caller — both transaction pickers and Clients & Contacts —
   * omits this and renders EXACTLY as before. That is asserted against the real
   * `ContactAssignmentStep`, not against this default.
   */
  showDetailLine?: boolean;
  /** Called when the row is selected (clicked or keyboard) */
  onSelect?: () => void;
  /** Called when the import button is clicked */
  onImport?: () => void;
  /**
   * BACKLOG-2603 — make the badge a way IN to this contact's open questions.
   *
   * OPT-IN, and the opt-in is the point. Clients & Contacts already routes the
   * questions through its ROW CLICK (`Contacts.handleContactClick`), so it does
   * not pass this and its badge stays a plain status. The transaction wizard
   * cannot: its row click adds the contact to the deal, and `ContactSearchList`
   * derives `isSelectionMode` from the absence of `onContactClick`, so the row
   * click is spoken for. This gives that surface a way in WITHOUT forking the
   * row or changing what a row click means anywhere.
   *
   * Only ever rendered where a badge is (`review_state` present), so a consumer
   * passing it does not decorate the ordinary contact.
   */
  onOpenQuestions?: () => void;
  /** Additional CSS classes */
  className?: string;
}

/**
 * Gets the first initial from a name for avatar display
 */
function getInitial(name: string | undefined): string {
  if (!name) return "?";
  return name.charAt(0).toUpperCase();
}

/**
 * Gets the label for a contact.
 *
 * BACKLOG-2461: was `display_name || name || "Unknown Contact"`. On a verified
 * store 18 of 1,124 macOS contacts have no name, so all 18 rendered as the same
 * string and could not be told apart — while their phone numbers sat unused on
 * the same object. The chain now falls through to what we actually hold, and is
 * shared with the audit PDF so the two surfaces cannot drift apart again (they
 * previously used two different literals for one condition).
 */
function getDisplayName(contact: ExtendedContact): string {
  return labelForContact(contact);
}

/**
 * The opt-in second line: where this record came from, and how to tell it apart
 * from someone with the same name (BACKLOG-2591).
 *
 * Order is deliberate — SOURCE FIRST. On a link picker the commonest question is
 * "which address book is this one?", and two records of one person differ by
 * source before they differ by anything else.
 *
 * Empty parts are dropped rather than rendered as gaps, and an all-empty result
 * returns `null` so the caller renders no line at all instead of an empty one.
 * A nameless record already puts its email or phone in the NAME slot
 * (`labelForContact`), so repeating it here would read as a duplicate — hence
 * the identifier is skipped when it already IS the display name.
 */
function buildDetailLine(contact: ExtendedContact): string | null {
  const isExternal =
    contact.is_message_derived === 1 || contact.is_message_derived === true;
  const displayName = getDisplayName(contact);

  const email = contact.email ?? contact.allEmails?.[0] ?? null;
  const phone = contact.phone ?? contact.allPhones?.[0] ?? null;

  const parts = [
    sourceDisplayLabel(contact.source, isExternal),
    email && email !== displayName ? email : null,
    phone && phone !== displayName ? phone : null,
    contact.company || null,
  ].filter((p): p is string => typeof p === "string" && p.trim().length > 0);

  return parts.length > 0 ? parts.join(" · ") : null;
}

/**
 * ContactRow Component
 *
 * Displays a single contact in a horizontal row format (name only, as of
 * BACKLOG-2356) with optional checkbox selection and an import button for
 * external contacts.
 *
 * @example
 * // Basic usage with selection
 * <ContactRow
 *   contact={contact}
 *   isSelected={selectedId === contact.id}
 *   onSelect={() => setSelectedId(contact.id)}
 * />
 *
 * @example
 * // With checkbox and import button
 * <ContactRow
 *   contact={contact}
 *   showCheckbox
 *   showImportButton
 *   isSelected={selected.has(contact.id)}
 *   onSelect={() => toggleSelection(contact.id)}
 *   onImport={() => importContact(contact)}
 * />
 */
export function ContactRow({
  contact,
  isSelected = false,
  isAdded = false,
  isAdding = false,
  showCheckbox = false,
  showImportButton = false,
  showAddButton = false,
  compact = false,
  showDetailLine = false,
  onSelect,
  onImport,
  onOpenQuestions,
  className = "",
}: ContactRowProps): React.ReactElement {
  const displayName = getDisplayName(contact);
  const initial = getInitial(displayName);
  const detailLine = showDetailLine ? buildDetailLine(contact) : null;

  const handleKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      onSelect?.();
    }
  };

  const handleImportClick = (event: React.MouseEvent) => {
    event.stopPropagation();
    onImport?.();
  };

  // BACKLOG-2603: see the badge's own note below. stopPropagation keeps the
  // wizard's row-click (add to the transaction) from firing on the way to the
  // questions — the badge asks a question, it does not join a deal.
  const handleOpenQuestionsClick = (event: React.MouseEvent) => {
    event.stopPropagation();
    onOpenQuestions?.();
  };

  /*
    ONE BADGE NODE, RENDERED BARE OR WRAPPED — never two copies of the markup.
    The clickable and plain shapes differ only in what surrounds it, so a change
    to the badge itself cannot land on one surface and miss the other.
  */
  const badgeSpan = contact.review_state ? (
    <span
      className={`px-2 py-1 rounded-full text-xs font-semibold border ${BADGE_STYLES[contact.review_state.badge]}`}
      data-testid="contact-row-badge"
      /*
        ROLE, NOT JUST A TESTID. The badge is asserted through
        `getByRole("status")` so a rename cannot satisfy the test
        vacuously — a testid survives any relabelling, and relabelling is
        exactly what this item is about.
      */
      role="status"
    >
      {badgeLabel(contact.review_state)}
    </span>
  ) : null;

  // BACKLOG-2400: "+ Add" affordance triggers the row's selection action
  // (onSelect). stopPropagation prevents the row's own onClick from ALSO firing
  // onSelect (a double-toggle that would cancel itself out).
  const handleAddClick = (event: React.MouseEvent) => {
    event.stopPropagation();
    onSelect?.();
  };

  const baseClasses = [
    "flex items-center gap-3 px-3 py-3 sm:py-2 border-b border-gray-100",
    "cursor-pointer transition-colors duration-150",
    isSelected ? "bg-purple-50" : "hover:bg-gray-50",
    className,
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div
      role="option"
      aria-selected={isSelected}
      tabIndex={0}
      className={baseClasses}
      onClick={onSelect}
      onKeyDown={handleKeyDown}
      data-testid="contact-row"
      data-contact-id={contact.id}
    >
      {/* Checkbox */}
      {showCheckbox && (
        <div className="flex-shrink-0">
          <div
            className={`w-5 h-5 rounded border-2 flex items-center justify-center transition-colors ${
              isSelected
                ? "bg-purple-600 border-purple-600"
                : "border-gray-300 bg-white"
            }`}
            data-testid="contact-row-checkbox"
          >
            {isSelected && (
              <svg
                className="w-3 h-3 text-white"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                strokeWidth={3}
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M5 13l4 4L19 7"
                />
              </svg>
            )}
          </div>
        </div>
      )}

      {/* Avatar - hidden on mobile, visible on sm+ (omitted entirely in compact mode) */}
      {!compact && (
        <div
          className="flex-shrink-0 w-8 h-8 rounded-full bg-gradient-to-br from-purple-500 to-pink-600 items-center justify-center hidden sm:flex"
          data-testid="contact-row-avatar"
        >
          <span className="text-white text-sm font-medium">{initial}</span>
        </div>
      )}

      {/* Name only (BACKLOG-2356). The secondary email/phone line and the
          source/import-status pills were intentionally removed so every
          ContactRow (picker + Clients & Contacts list) shows just the name;
          full details live in the contact detail/preview pane. */}
      <div className="flex-1 min-w-0">
        <p
          className="text-sm font-medium text-gray-900 truncate"
          data-testid="contact-row-name"
        >
          {displayName}
        </p>

        {/* BACKLOG-2591 — opt-in ONLY. See `showDetailLine`'s docblock: 2356's
            name-only rule stands for every caller that does not ask for this. */}
        {detailLine && (
          <p
            className="text-xs text-gray-600 truncate"
            data-testid="contact-row-detail"
          >
            {detailLine}
          </p>
        )}

        {/* BACKLOG-2556 — the purple "N records combined" disclosure was here.
            It only ever appeared because the main-process fold had swallowed a
            record; with nothing folded there is nothing to disclose. The amber
            `contact-row-review-flag` below is a DIFFERENT control with the same
            two words — it counts what the crosswalk actually links on a SAVED
            contact — and it stays. */}
      </div>

      {/* Adding spinner */}
      {isAdding && (
        <div
          className="flex-shrink-0 flex items-center gap-1.5 px-2 py-1 text-purple-600 text-xs font-medium"
          data-testid="contact-row-adding-indicator"
        >
          <svg
            className="w-3.5 h-3.5 animate-spin"
            fill="none"
            viewBox="0 0 24 24"
          >
            <circle
              className="opacity-25"
              cx="12"
              cy="12"
              r="10"
              stroke="currentColor"
              strokeWidth="4"
            />
            <path
              className="opacity-75"
              fill="currentColor"
              d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
            />
          </svg>
          Adding...
        </div>
      )}

      {/*
        BACKLOG-2626 — THE THREE ROW BADGES, and the count beside them.

        `Autolinked` (the app linked these) · `Suggestion` (a question is open) ·
        `You linked these` (the user decided, by either route). A contact with
        none of those carries NO badge, which is `review_state: undefined`.

        The founder ruled out a FOURTH "Confirmed" state on 2026-08-09: *"do you
        think we need one status for confirmed linked contacts?"* — no.
        "Confirmed" and "you linked it" are the same fact from his side, and how
        he decided is provenance detail already on the source row inside the card
        ("You confirmed this yourself" vs "You added this contact yourself").
        That is why the green `Confirmed` pill this replaces did not survive as a
        separate value: it was renamed, not joined.

        PRECEDENCE, decided in `getReviewStateByContact` and not here, so one rule
        serves the row and the filter: Suggestion > Autolinked > You linked these.
        The three sets are NOT disjoint — `11abce67` says so explicitly, and one
        contact can hold an auto-attached record awaiting confirmation AND a
        separate proposal the matcher refused to guess about. `Suggestion` wins
        because it is the state that REPLACED the forced compare screen as the way
        an open question stays discoverable; demote it and the question is
        invisible outside the queue again.

        This is a LENS, NOT AN ALERT (founder, `11abce67`): these are contacts the
        matcher was confident about, and styling them as a queue the user is
        behind on inverts the signal. Hence neutral slate for `Autolinked` rather
        than the amber it used to wear.

        Placed BEFORE the adding/added/import cluster and gated with it, so a row
        being added to a transaction shows that state rather than two badges
        competing for the same slot.
      */}
      {!isAdding && !isAdded && contact.review_state && (
        <div className="flex-shrink-0 flex items-center gap-1.5">
          {/*
            THE RECORD COUNT — BACKLOG-2626, folding in `14617008`.

            It counts RECORDS, not columns. The badge used to render
            `review_state.columns` while the sentence beside it counted records,
            so a two-record contact whose second record matched by stable id read
            "1 records combined". Both numbers were accurate about different
            things and the user read them as one contradictory statement.

            Suppressed below two, which is not the `columns > 1` guard
            `14617008` warned against: that guard hid the founder's own case
            because it tested the WRONG NUMBER. Two records is two records
            whether or not the compare screen draws them as two columns, and a
            contact assembled from exactly one record has genuinely combined
            nothing — the badge alone carries that row.
          */}
          {contact.review_state.records > 1 && (
            <span
              className="text-xs text-gray-500"
              data-testid="contact-row-record-count"
            >
              {contact.review_state.records} records combined
            </span>
          )}
          {/*
            BACKLOG-2603 — THE BADGE IS THE WAY IN, AND IT IS THE SAME BADGE.

            The founder found `Bea Okafor` in the transaction wizard and could
            reach her; he found `Bianca Okafor`, who has four open questions, and
            the wizard said nothing. In Clients & Contacts the same contact
            carries a badge. His instruction was to REUSE, not to build: *"if we
            were to reuse the search from the Clients & Contacts it shouldn't
            [need building], should it?"* — and it did not, because both surfaces
            already render THIS component. Only the wizard's projection was
            dropping `review_state` (see `ContactAssignmentStep.toExtendedContact`).

            WHY A BUTTON ROUND THE BADGE RATHER THAN A ROW CLICK. In Clients &
            Contacts the row click opens the filtered queue. In the wizard the
            row click ADDS THE CONTACT TO THE TRANSACTION — the surface's whole
            purpose — and `ContactSearchList` derives `isSelectionMode` from the
            ABSENCE of `onContactClick`, so routing the questions through that
            prop would take add-mode away with it. One affordance that means two
            things in two places is not reuse. The badge is the way in wherever
            a consumer asks for one, and the row keeps its own meaning.

            The `<span role="status">` INSIDE is untouched in both shapes, so the
            2626 controls that assert `getByRole("status")` keep holding whether
            or not this row is clickable. `stopPropagation` follows the grammar
            `handleImportClick` / `handleAddClick` already use above: without it
            the badge press would also fire the row's `onSelect` and silently add
            her to the deal on the way to the question.
          */}
          {onOpenQuestions ? (
            <button
              type="button"
              onClick={handleOpenQuestionsClick}
              className="rounded-full focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-indigo-500"
              data-testid="contact-row-badge-action"
              aria-label={`Review ${badgeLabel(contact.review_state)} for ${displayName}`}
            >
              {badgeSpan}
            </button>
          ) : (
            badgeSpan
          )}
        </div>
      )}

      {/* Added indicator with checkmark */}
      {!isAdding && isAdded && (
        <div
          className="flex-shrink-0 flex items-center gap-1 px-2 py-1 bg-green-100 text-green-700 rounded text-xs font-medium"
          data-testid="contact-row-added-indicator"
        >
          <svg
            className="w-3.5 h-3.5"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeWidth={3}
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M5 13l4 4L19 7"
            />
          </svg>
          Added
        </div>
      )}

      {/* Add Contact Button (never rendered in compact mode — import happens
          via the detail pane's Import button instead) */}
      {!compact && !isAdding && !isAdded && showImportButton && (
        <button
          type="button"
          onClick={handleImportClick}
          className="flex-shrink-0 px-2 py-1 text-xs font-medium text-purple-600 hover:text-purple-700 hover:bg-purple-50 rounded transition-colors"
          aria-label={`Add ${displayName}`}
          data-testid="contact-row-import-button"
        >
          + Add Contact
        </button>
      )}

      {/* "+ Add" affordance (BACKLOG-2400 two-pane picker). Replaces the checkbox
          in the ContactAssignmentStep "Available" column: one click adds the
          contact (imports it first if external) and moves it to the "Added"
          column. */}
      {!isAdding && !isAdded && showAddButton && (
        <button
          type="button"
          onClick={handleAddClick}
          className="flex-shrink-0 px-3 py-1 text-xs font-semibold text-purple-700 bg-purple-100 hover:bg-purple-200 rounded-full transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-purple-500"
          aria-label={`Add ${displayName}`}
          data-testid="contact-row-add-button"
        >
          + Add
        </button>
      )}
    </div>
  );
}

export default ContactRow;
