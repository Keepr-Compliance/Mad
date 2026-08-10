/**
 * ContactSearchList Component
 *
 * A search-enabled contact selection list that combines imported and external
 * (address-book) contacts into one deterministic list.
 *
 * All list-shaping logic (assemble -> filter -> search -> sort) lives in the pure
 * `contactPickerList` engine; this component is a thin, side-effect-free wrapper
 * that owns UI state (search text, sort toggle, grouped filter selection) and
 * renders rows. There are NO ref writes during render — the render order is a
 * pure function of props + UI state (BACKLOG-2352, replacing the SVO machinery of
 * BACKLOG-1745/1761).
 *
 * BACKLOG-2370: this list does NOT decide whether two records are the same
 * person. It renders what the main process gives it. The one place that decision
 * is made is `contacts:get-available`, which stores it and discloses it. This
 * component used to re-decide it, knew nothing about unlink verdicts, and so
 * silently reversed one on the founder's data — see `assembleContacts`.
 *
 * @see BACKLOG-2370: One matching rule, not two
 * @see BACKLOG-2352: Rewrite the contact search/select pipeline
 * @see TASK-1763: Original ContactSearchList Component
 */

import React, { useState, useMemo, useCallback, useRef, useEffect, useLayoutEffect } from "react";
import { BADGE_LABELS, ContactRow } from "./ContactRow";
import { GroupedMultiSelect } from "./GroupedMultiSelect";
import type { ExtendedContact } from "../../types/components";
import {
  assembleContacts,
  assembleFilterSearch,
  sortContacts,
  projectOntoOrder,
  stableIdentityKey,
  mergeNewOrderKeys,
  type ContactSortOrder,
} from "../../utils/contactPickerList";
import {
  resolveContactAnchor,
  scrollTopForAnchor,
  type ContactListAnchor,
} from "../../utils/contactListAnchor";
import {
  SOURCE_GROUPS,
  ROLE_GROUPS,
  matchesContactFilters,
  defaultSourceSelection,
  defaultRoleSelection,
  ALL_SOURCE_LEAF_IDS,
  type ContactFilters,
} from "../../utils/contactFilterModel";
import logger from "../../utils/logger";

/**
 * How the grouped Source/Role filter behaves for this instance — collapses the
 * old `showCategoryFilter` + `categoryFilterDefaultsToAll` flag pair into ONE
 * unambiguous choice (BACKLOG-2352):
 *
 * - `"off"` (default): no filter UI and no filtering — every contact shows. Used
 *   by transaction flows that don't surface the filter (audit wizard).
 * - `"ephemeral"`: filter UI shown, opens on a TRUE select-all (show everyone),
 *   and is NEVER read from nor written to localStorage. Used by transaction
 *   flows that surface the filter (EditContacts add-contacts) — it can only ever
 *   NARROW in-session, never pre-hide, and never touches the Contacts screen's
 *   saved selection.
 * - `"persistent"`: filter UI shown and persisted to localStorage. The Contacts
 *   screen ONLY.
 */
export type ContactFilterMode = "off" | "ephemeral" | "persistent";

/**
 * How a selectable row presents its per-row selection affordance (BACKLOG-2400):
 *
 * - `"checkbox"` (default): the historical behavior — each row shows a checkbox
 *   and clicking toggles selection in place. Selected rows STAY in the list
 *   (checked). Used by every consumer except the two-pane picker.
 * - `"add"`: each row shows a **"+ Add"** button instead of a checkbox, and a
 *   contact that is currently selected DROPS OUT of the list (it has "moved" to
 *   the caller's Added column). Deselection happens outside this list (the
 *   Added column's ✕), so the list only ever ADDS. Used by
 *   `ContactAssignmentStep` Step 2. This makes selection single-sourced — a
 *   contact is EITHER available OR added, never shown in both with conflicting
 *   state (the checkbox/pill desync this replaces).
 */
export type ContactSelectionMode = "checkbox" | "add";

export interface ContactSearchListProps {
  /** Imported/existing contacts */
  contacts: ExtendedContact[];
  /** External contacts (from address book, not yet imported) */
  externalContacts?: ExtendedContact[];
  /** Currently selected contact IDs */
  selectedIds: string[];
  /** Callback when selection changes */
  onSelectionChange: (selectedIds: string[]) => void;
  /** Callback to import an external contact - returns the imported contact */
  onImportContact?: (contact: ExtendedContact) => Promise<ExtendedContact>;
  /**
   * Select an external row WITHOUT importing it (BACKLOG-2591).
   *
   * In "add" mode an external row today MEANS import: `handleExternalSelect` ->
   * `handleImport` -> `onImportContact`, which CREATES a contact. Manual linking
   * must attach the record to an EXISTING contact and must never create one — a
   * reachable import here would manufacture exactly the duplicates the feature
   * removes.
   *
   * Omitting `onImportContact` is NOT a way to get that: without it the row
   * becomes a silent no-op rather than a link. So this is a genuine third path,
   * not a flag.
   *
   * PRECEDENCE: this WINS over `onImportContact` where both are somehow
   * supplied, and it forces the per-row import button off — so a caller cannot
   * half-configure linking and leave an import reachable.
   */
  onExternalSelect?: (contact: ExtendedContact) => void;
  /**
   * Whether to show add/import button for already-imported contacts.
   * - true: Show button for ALL contacts (use in transaction flows to add to transaction)
   * - false: Only show button for external contacts (use in Contacts screen for import only)
   * Default: false
   */
  showAddButtonForImported?: boolean;
  /** Callback when a contact is clicked (for viewing details). If provided, clicking a contact calls this instead of selection. */
  onContactClick?: (contact: ExtendedContact) => void;
  /**
   * BACKLOG-2603 — a way into a contact's open questions that does NOT spend
   * the row click.
   *
   * Passed straight through to `ContactRow.onOpenQuestions`, which turns the
   * badge into a button. It exists because `isSelectionMode` is derived from
   * `!onContactClick` (see the row-render below): in the transaction wizard the
   * row click means "add to the deal", so the questions need their own
   * affordance — and the badge, already the thing that says a question exists,
   * is it.
   *
   * Clients & Contacts omits this. Its row click already opens the filtered
   * queue, so a second route off the same row would be two controls for one
   * action. Omitting it leaves that surface byte-identical.
   */
  onOpenContactQuestions?: (contact: ExtendedContact) => void;
  /**
   * Contact ID currently shown in a master-detail pane (BACKLOG-1898 QA fix).
   * When set, the matching row is highlighted even though `selectedIds` stays
   * empty in detail mode. Has no effect in selection mode. Default `undefined`.
   */
  activeContactId?: string | null;
  /** Callback to add a new contact manually */
  onAddManually?: () => void;
  /** Contact IDs that have been added (for visual feedback) */
  addedContactIds?: Set<string>;
  /** Show loading state */
  isLoading?: boolean;
  /** Error message to display */
  error?: string | null;
  /** Placeholder text for search input */
  searchPlaceholder?: string;
  /**
   * Grouped Source/Role filter behavior. See {@link ContactFilterMode}.
   * Default: `"off"`.
   */
  filterMode?: ContactFilterMode;
  /**
   * Per-row selection affordance. See {@link ContactSelectionMode}. Default:
   * `"checkbox"` (unchanged for every existing consumer). `"add"` opts into the
   * two-pane "+ Add" affordance and drops selected contacts out of the list.
   */
  selectionMode?: ContactSelectionMode;
  /**
   * Initial sort order. The component owns the live sort as internal state
   * (driven by the Sort control), so this only seeds the first render.
   * Default: `"recent"`.
   */
  initialSortOrder?: ContactSortOrder;
  /** Additional CSS classes */
  className?: string;
  /**
   * Compact mode (BACKLOG-1898). Forwarded to each `ContactRow` and forces the
   * per-row import button off (import happens via the detail pane instead).
   */
  compact?: boolean;
  /**
   * Forwarded verbatim to every `ContactRow` (BACKLOG-2591). Default `false`,
   * so both transaction pickers and Clients & Contacts render name-only exactly
   * as BACKLOG-2356 decided. See `ContactRowProps.showDetailLine` for why the
   * link picker is the one surface that turns it on.
   */
  showDetailLine?: boolean;
  /**
   * Called with the number of rows actually rendered (post filter, post search)
   * whenever that count changes (BACKLOG-2141). Derived from the
   * SAME array that renders, so header counts always match the list. Fired from
   * an effect (never during render). Default: unused.
   */
  onVisibleCountChange?: (count: number) => void;
  /**
   * Called the moment a row is opened via `onContactClick`, with everything
   * needed to find the user's place again (BACKLOG-2459).
   *
   * Fired SYNCHRONOUSLY from the click handler, before `onContactClick`, and not
   * from an effect: below 1200px the Contacts screen replaces this whole list
   * with the detail card in the same commit, so a layout effect would never run
   * and there would be nothing left to measure. Because the anchor is held by
   * the PARENT it also survives that unmount.
   */
  onAnchorCapture?: (anchor: ContactListAnchor) => void;
  /**
   * An anchor to return to — set by the parent when the detail view closes.
   *
   * The list scrolls to the anchored contact (or its survivor, or its nearest
   * surviving neighbour) and then calls `onAnchorConsumed`. While the resolution
   * finds nothing — the usual reason is that a `silentLoadContacts()` from the
   * action the user just took has not landed yet — the anchor is left pending
   * and retried as the data settles, so it can never restore against a stale list.
   */
  pendingAnchor?: ContactListAnchor | null;
  /** Called once `pendingAnchor` has been restored. */
  onAnchorConsumed?: () => void;
  /**
   * The search text, when the PARENT owns it (BACKLOG-2509).
   *
   * OPTIONAL, and all-or-nothing with `onSearchQueryChange`: supply both and
   * this list is controlled; supply neither and it keeps its own `useState`,
   * which is what the transaction-flow pickers want — a modal that closes has
   * no search worth remembering.
   *
   * The Contacts screen supplies both because below 1200px it replaces this
   * whole list with the detail card, and state inside an unmounted component is
   * not a memory — the same reason `pendingAnchor` is held by the parent.
   *
   * SESSION-ONLY by decision (founder, 2026-08-06: "search is a moment, filters
   * are a setup"). The parent holds it in plain state; nothing persists it, and
   * the grouped Source/Role filter remains the only thing this component writes
   * to localStorage.
   */
  searchQuery?: string;
  /** Called with the new search text. Pairs with `searchQuery` — see above. */
  onSearchQueryChange?: (query: string) => void;
}

// ---------------------------------------------------------------------------
// Grouped Source/Role filter persistence (Contacts screen only).
// The grouped model lives in `contactFilterModel.ts`; this component owns its
// localStorage persistence via the one key below.
// ---------------------------------------------------------------------------
const FILTER_MODEL_STORAGE_KEY = "contactModal.filterModel.v1";

/** Serialized shape persisted under FILTER_MODEL_STORAGE_KEY. */
interface PersistedContactFilters {
  sources: string[];
  roles: string[];
}

/** Build ContactFilters from a persisted payload, guarding source leaf ids. */
function fromPersisted(payload: PersistedContactFilters): ContactFilters {
  const validSources = new Set<string>(ALL_SOURCE_LEAF_IDS as string[]);
  const sources = new Set<string>(
    Array.isArray(payload.sources) ? payload.sources.filter((id) => validSources.has(id)) : [],
  );
  const roles = new Set<string>(Array.isArray(payload.roles) ? payload.roles : []);
  return { sources, roles };
}

/** Load the persisted filter model, falling back to defaults. */
function loadContactFilters(): ContactFilters {
  try {
    const stored = localStorage.getItem(FILTER_MODEL_STORAGE_KEY);
    if (stored) return fromPersisted(JSON.parse(stored) as PersistedContactFilters);
  } catch {
    // Ignore malformed localStorage — fall back to defaults.
  }
  return { sources: defaultSourceSelection(), roles: defaultRoleSelection() };
}

/** Persist the filter model under the single owned key. */
function saveContactFilters(filters: ContactFilters): void {
  try {
    const payload: PersistedContactFilters = {
      sources: Array.from(filters.sources),
      roles: Array.from(filters.roles),
    };
    localStorage.setItem(FILTER_MODEL_STORAGE_KEY, JSON.stringify(payload));
  } catch {
    // Ignore localStorage write errors.
  }
}

/**
 * The rendered row for a contact id, or null (BACKLOG-2459).
 *
 * A scan rather than a `[data-contact-id="..."]` selector: contact ids come from
 * an address book and are not guaranteed to be CSS-identifier-safe, and
 * `CSS.escape` is not universally present in test runtimes. A linear scan over
 * the rendered rows is exact and cannot throw on a hostile id.
 */
function findRowElement(container: HTMLElement | null, contactId: string): HTMLElement | null {
  if (!container) return null;
  const rows = container.querySelectorAll<HTMLElement>("[data-contact-id]");
  for (const row of Array.from(rows)) {
    if (row.getAttribute("data-contact-id") === contactId) return row;
  }
  return null;
}

/** All ENABLED leaf ids across the given groups (disabled leaves are unselectable). */
function enabledLeafIds(groups: { children: { id: string; disabled?: boolean }[] }[]): string[] {
  return groups.flatMap((g) => g.children.filter((c) => !c.disabled).map((c) => c.id));
}

/** A TRUE select-all selection (every enabled source + role leaf). */
function trueSelectAll(): ContactFilters {
  return {
    sources: new Set<string>(enabledLeafIds(SOURCE_GROUPS)),
    roles: new Set<string>(enabledLeafIds(ROLE_GROUPS)),
  };
}

/** Trigger summary for the Source dropdown: "All" / "None" / "N selected". */
function formatSourceSummary(selected: Set<string>): string {
  const all = enabledLeafIds(SOURCE_GROUPS);
  const count = all.filter((id) => selected.has(id)).length;
  if (count === 0) return "None";
  if (count === all.length) return "All";
  return `${count} selected`;
}

/**
 * Trigger summary for the Role dropdown. Names a single fully-selected group
 * when exactly that group is selected, otherwise "All" / "None" / "N selected".
 */
function formatRoleSummary(selected: Set<string>): string {
  const all = enabledLeafIds(ROLE_GROUPS);
  const count = all.filter((id) => selected.has(id)).length;
  if (count === 0) return "None";
  if (count === all.length) return "All";
  for (const group of ROLE_GROUPS) {
    const groupEnabled = group.children.filter((c) => !c.disabled).map((c) => c.id);
    if (groupEnabled.length === 0) continue;
    const allInGroup = groupEnabled.every((id) => selected.has(id));
    if (allInGroup && count === groupEnabled.length) return group.label;
  }
  return `${count} selected`;
}

/**
 * A label and the controls it names, as ONE wrappable unit — BACKLOG-2471,
 * point 4 of the founder's 7 Aug spec.
 *
 * THE DEFECT THIS DELETES. The controls row is `flex-wrap`. The labels used to
 * be bare siblings of their controls inside it, so every child was an
 * independent wrap candidate. In the band of widths where the label still fits
 * on line one but the controls after it no longer do, the browser broke the
 * line between them and left the word `Filter:` stranded alone above its own
 * dropdowns. `Sort:` had the identical shape.
 *
 * WHY A COMPONENT AND NOT A WRAP RULE. The founder: *"put them all as a part of
 * the same wrap component so they all move together."* A `flex-nowrap` or a
 * `whitespace-nowrap` tuned to today's widths would look right today and regress
 * the moment someone appends a control — which has already happened once, when
 * BACKLOG-2626 added `Autolinked` to this row. Grouping makes "they move
 * together" structural: a cluster is a single flex item in the wrapping row, so
 * the line can only break BETWEEN clusters, never inside one. Either the whole
 * group sits on line one or the whole group moves to line two; the intermediate
 * state the founder saw has no way to exist.
 *
 * Two rules hold this, and `ContactSearchList.controlClusters-2471.test.tsx`
 * asserts both:
 *   1. This wrapper does NOT set `flex-wrap` — its children cannot split.
 *   2. Every element child of `contact-controls` IS a cluster. A new control
 *      dropped in beside the clusters rather than inside one fails that test,
 *      which is the regression the founder is actually worried about.
 *
 * No `role="group"` here: the sort segmented control already carries one, and
 * nesting a second unlabelled group only adds noise for a screen reader. The
 * grouping being asserted is a LAYOUT fact, so it is carried by a data
 * attribute rather than by ARIA.
 *
 * Spacing is unchanged from before the grouping: the row's `gap-x-3` reproduces
 * the old 8px gap + the `ml-1` that used to sit on the `Filter:` label (12px
 * between clusters), and this `gap-2` reproduces the old 8px between a label and
 * its controls.
 */
function ControlCluster({
  label,
  testId,
  children,
}: {
  label: string;
  testId: string;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <div className="flex items-center gap-2" data-control-cluster="" data-testid={testId}>
      <span className="text-xs text-gray-400 flex-shrink-0">{label}</span>
      {children}
    </div>
  );
}

export function ContactSearchList({
  contacts,
  externalContacts = [],
  selectedIds,
  onSelectionChange,
  onImportContact,
  onExternalSelect,
  showDetailLine = false,
  showAddButtonForImported = false,
  onContactClick,
  onOpenContactQuestions,
  activeContactId,
  onAddManually,
  addedContactIds = new Set(),
  isLoading = false,
  error = null,
  searchPlaceholder = "Search contacts...",
  filterMode = "off",
  selectionMode = "checkbox",
  initialSortOrder = "recent",
  className = "",
  compact = false,
  onVisibleCountChange,
  onAnchorCapture,
  pendingAnchor = null,
  onAnchorConsumed,
  searchQuery: controlledSearchQuery,
  onSearchQueryChange,
}: ContactSearchListProps): React.ReactElement {
  const isAddMode = selectionMode === "add";

  // BACKLOG-2509 — the search text, owned here or by the parent.
  //
  // Resolved ONCE, into the two names the rest of this component already used,
  // so there is exactly one value the render reads and one setter the handlers
  // call. Deliberately NOT a `useState` seeded from the prop: that shape looks
  // equivalent and silently resets the box on every remount, which is the exact
  // bug this item exists to fix.
  const [internalSearchQuery, setInternalSearchQuery] = useState("");
  const isSearchControlled =
    controlledSearchQuery !== undefined && onSearchQueryChange !== undefined;
  const searchQuery = isSearchControlled ? controlledSearchQuery : internalSearchQuery;
  const setSearchQuery = isSearchControlled ? onSearchQueryChange : setInternalSearchQuery;
  const [sortOrder, setSortOrder] = useState<ContactSortOrder>(initialSortOrder);
  const [importingIds, setImportingIds] = useState<Set<string>>(new Set());
  const [focusedIndex, setFocusedIndex] = useState(-1);

  const showFilterUI = filterMode !== "off";

  // Grouped Source/Role filter selection. Persistent (Contacts screen) seeds from
  // localStorage; ephemeral (transaction flows) opens on a TRUE select-all and is
  // never persisted; "off" leaves this unused.
  const initialFilters = useMemo(
    () => (filterMode === "persistent" ? loadContactFilters() : trueSelectAll()),
    [filterMode],
  );
  /**
   * BACKLOG-2471 PR F, renamed by BACKLOG-2626 — the `Autolinked` filter.
   *
   * DELIBERATELY NOT PERSISTED, unlike Source and Role. Founder decision D4 made
   * `searchQuery` session-only for the same reason, and this is the stronger
   * case: an empty search box is VISIBLY empty, while an active filter reads as
   * "this is the whole list". A forgotten filter would hide the rest of the
   * address book with nothing on screen admitting it.
   *
   * So it is plain state — not in `ContactFilters`, not in the
   * `contactModal.filterModel.v1` payload, and no migration of either.
   */
  const [autolinkedOnly, setAutolinkedOnly] = useState(false);
  const [selectedSources, setSelectedSources] = useState<Set<string>>(initialFilters.sources);
  const [selectedRoles, setSelectedRoles] = useState<Set<string>>(initialFilters.roles);

  // Persist filter changes ONLY in persistent mode. Ephemeral filters never
  // touch the shared key (no inherit, no clobber).
  useEffect(() => {
    if (filterMode !== "persistent") return;
    saveContactFilters({ sources: selectedSources, roles: selectedRoles });
  }, [selectedSources, selectedRoles, filterMode]);

  const handleSourcesChange = useCallback((next: Set<string>) => setSelectedSources(next), []);
  const handleRolesChange = useCallback((next: Set<string>) => setSelectedRoles(next), []);

  const searchInputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // Which rows are external — by reference, robust regardless of id shape. A
  // surviving external contact is the same object reference passed in.
  const externalSet = useMemo(
    () => new Set<ExtendedContact>(externalContacts),
    [externalContacts],
  );

  // ---------------------------------------------------------------------------
  // Frozen visible ORDER (BACKLOG-2355).
  //
  // The rendered order is a snapshot of `stableIdentityKey`s ("orderKeys") that
  // is recomputed ONLY when an explicit ordering input changes — search, sort,
  // or the Source/Role filter — plus once when data first arrives. It is NOT
  // recomputed on `contacts` / `externalContacts` (background refreshes) nor on
  // `selectedIds` (selection). Selecting an external contact auto-imports it,
  // which swaps its DB id and flips its recency null->real; freezing the order
  // keeps its row in place (the imported twin reclaims the slot via its shared
  // `stableIdentityKey`) instead of re-sorting and jumping.
  //
  // The freeze runs in a layout effect (not during render — preserving the
  // BACKLOG-2352 "no refs in render" win) so a sort/search/filter change never
  // paints a stale order for a frame.
  // ---------------------------------------------------------------------------
  const [orderKeys, setOrderKeys] = useState<string[]>([]);

  // Only meaningful as absent (0) vs present (>0): flips false->true once when
  // the picker first receives data, so the initial order is frozen exactly once.
  // Background refreshes keep it `true`, so they never re-freeze the order.
  const hasData = contacts.length + externalContacts.length > 0;

  useLayoutEffect(() => {
    const list = assembleFilterSearch({
      contacts,
      externalContacts,
      searchQuery,
      filters: showFilterUI ? { sources: selectedSources, roles: selectedRoles } : null,
    });
    setOrderKeys(sortContacts(list, sortOrder).map(stableIdentityKey));
    // Deps are the EXPLICIT ordering inputs only (+ first-data seed). `contacts`
    // / `externalContacts` / `selectedIds` are read by closure but intentionally
    // NOT subscribed to — that omission is the freeze. See block comment above.
  }, [searchQuery, sortOrder, showFilterUI, selectedSources, selectedRoles, hasData]);

  // BACKLOG-2357 — ADDITIVE merge of late-arriving identities into the frozen
  // order. External contacts resolve a beat after imported ones (getAvailable),
  // and genuinely-new contacts can appear on a refresh; the freeze above snapshots
  // ONLY what was present on first data, so those identities never get a frozen
  // slot and are positioned LIVE by projectOntoOrder — free to move when their
  // recency changes on select/import (the founder's Paul/Daniel jump). This
  // appends ONLY keys not already frozen, at their sorted position, and preserves
  // the existing order EXACTLY. It is NOT a re-freeze: adding contacts/
  // externalContacts to the freeze effect's deps instead would re-sort on every
  // background refresh and reintroduce the jump. The functional updater means we
  // never subscribe to `orderKeys` (no stale-closure re-run) and `mergeNewOrderKeys`
  // returns the same reference when nothing is new, so a pure background refresh
  // bails out with no state change.
  useLayoutEffect(() => {
    const sortedKeys = sortContacts(
      assembleFilterSearch({
        contacts,
        externalContacts,
        searchQuery,
        filters: showFilterUI ? { sources: selectedSources, roles: selectedRoles } : null,
      }),
      sortOrder,
    ).map(stableIdentityKey);
    setOrderKeys((prev) => mergeNewOrderKeys(prev, sortedKeys));
  }, [contacts, externalContacts, searchQuery, sortOrder, showFilterUI, selectedSources, selectedRoles]);

  // The list to render: current (live) data projected onto the frozen order.
  // Pure, no side effects. Background refreshes and selection update row DATA in
  // place without reordering; genuinely new contacts merge in at their sorted
  // position; contacts that vanish (search/filter/removal) drop out.
  //
  // BACKLOG-2400: in "add" mode, selected contacts DROP OUT of the list (they
  // have moved to the caller's Added column). The freeze (`orderKeys`) is NOT
  // touched by this — every contact keeps its frozen slot — so deselecting a
  // contact (via the Added column's ✕) returns its row to its exact original
  // position. This is a final render-time filter, applied AFTER projection.
  const selectedSet = useMemo(() => new Set(selectedIds), [selectedIds]);
  const visibleContacts = useMemo(() => {
    const projected = projectOntoOrder(
      assembleFilterSearch({
        contacts,
        externalContacts,
        searchQuery,
        filters: showFilterUI ? { sources: selectedSources, roles: selectedRoles } : null,
      }),
      orderKeys,
      sortOrder,
    );
    const afterAdd = isAddMode ? projected.filter((c) => !selectedSet.has(c.id)) : projected;
    // BACKLOG-2471 PR F: applied LAST, on the same list the rows render from, so
    // the control's visibility and the rows it reveals cannot come from two
    // predicates. BACKLOG-2626 switched the predicate to the BADGE, so the rows
    // this reveals are exactly the rows wearing `Autolinked` — one rule, decided
    // in `getReviewStateByContact`, read here and by `ContactRow`.
    return autolinkedOnly
      ? afterAdd.filter((c) => c.review_state?.badge === "autolinked")
      : afterAdd;
  }, [contacts, externalContacts, searchQuery, sortOrder, showFilterUI, selectedSources, selectedRoles, orderKeys, isAddMode, selectedSet, autolinkedOnly]);

  /**
   * How many contacts the app linked on its own — counted from the SAME array
   * the filter above narrows, before it is narrowed.
   *
   * Not a second query and not a prop: a control that offers a set it cannot
   * produce is the "Review 12 opening onto 9" defect in miniature, and the only
   * way it cannot happen is for the visibility test and the rows to have one
   * source. The NUMBER is no longer shown (`11abce67`); it survives only as the
   * hidden-at-zero test.
   */
  const autolinkedCount = useMemo(
    () => contacts.filter((c) => c.review_state?.badge === "autolinked").length,
    [contacts],
  );

  // Count of contacts hidden by the Source/Role FILTERS only (not search).
  // Zero when the filter UI is off. Drives the "N hidden" escape hatches.
  //
  // BACKLOG-2370: this used to run over the output of a renderer-side dedup
  // pass, which has been deleted — this list no longer decides whether two
  // records are the same person, so the only rows it can hide are the ones the
  // FILTERS hide, and the count is over everything the main process returned.
  const categoryHiddenCount = useMemo((): number => {
    if (!showFilterUI) return 0;
    const filters = { sources: selectedSources, roles: selectedRoles };
    return assembleContacts(contacts, externalContacts).filter(
      (contact) => !matchesContactFilters(contact, filters),
    ).length;
  }, [showFilterUI, contacts, externalContacts, selectedSources, selectedRoles]);

  // "Show all" = TRUE select-all (BACKLOG-2141): reveal EVERYTHING, incl. the
  // Inferred sources and every role leaf.
  const handleShowAll = useCallback(() => {
    const all = trueSelectAll();
    setSelectedSources(all.sources);
    setSelectedRoles(all.roles);
  }, []);

  // Reset focused index when list changes.
  useEffect(() => {
    setFocusedIndex(-1);
  }, [visibleContacts.length]);

  // Report the rendered row count upward (BACKLOG-2141). Fired from an effect.
  useEffect(() => {
    onVisibleCountChange?.(visibleContacts.length);
  }, [visibleContacts.length, onVisibleCountChange]);

  // Toggle selection for an imported/selectable contact.
  const handleSelect = useCallback(
    (contactId: string) => {
      if (selectedIds.includes(contactId)) {
        onSelectionChange(selectedIds.filter((id) => id !== contactId));
      } else {
        onSelectionChange([...selectedIds, contactId]);
      }
    },
    [selectedIds, onSelectionChange],
  );

  // Import an external contact (optionally auto-select the imported result).
  const handleImport = useCallback(
    async (contact: ExtendedContact, autoSelect: boolean = false) => {
      if (!onImportContact || importingIds.has(contact.id)) return;

      setImportingIds((prev) => new Set(prev).add(contact.id));
      try {
        const imported = await onImportContact(contact);
        if (autoSelect) {
          onSelectionChange([...selectedIds, imported.id]);
        }
      } catch (err) {
        logger.error("Failed to import contact:", err);
      } finally {
        setImportingIds((prev) => {
          const next = new Set(prev);
          next.delete(contact.id);
          return next;
        });
      }
    },
    [onImportContact, importingIds, selectedIds, onSelectionChange],
  );

  // Selecting an external contact auto-imports it — UNLESS the caller wants it
  // selected by identity instead (BACKLOG-2591). `onExternalSelect` WINS: see
  // its docblock for why an import path must be unreachable in linking mode.
  const handleExternalSelect = useCallback(
    async (contact: ExtendedContact) => {
      if (onExternalSelect) {
        onExternalSelect(contact);
        return;
      }
      if (onImportContact) await handleImport(contact, true);
    },
    [onExternalSelect, onImportContact, handleImport],
  );

  /**
   * BACKLOG-2459 — measure the user's place before the detail view takes over.
   *
   * Reads the live DOM rather than a stored index because that is what "stay
   * put" is measured against: where the row sits ON SCREEN inside this
   * container. When there is no row to measure the offset is 0 — the anchor
   * still carries the CONTACT, which is the part that matters; only the
   * fine-grained "same place on screen" is lost.
   */
  const captureAnchor = useCallback(
    (contact: ExtendedContact): void => {
      if (!onAnchorCapture) return;
      const container = listRef.current;
      const row = findRowElement(container, contact.id);
      const viewportOffset =
        container && row
          ? row.getBoundingClientRect().top - container.getBoundingClientRect().top
          : 0;
      onAnchorCapture({
        contact,
        orderIds: visibleContacts.map((c) => c.id),
        viewportOffset,
      });
    },
    [onAnchorCapture, visibleContacts],
  );

  /**
   * BACKLOG-2459 — put the user back where they were.
   *
   * A layout effect so the restore is painted in the same frame the list
   * reappears; the user never sees the top of the list flash past. It re-runs as
   * `visibleContacts` settles, and consumes the anchor only once the resolution
   * actually lands on a row — an anchor that resolves to nothing is a list that
   * has not finished reloading, not a list without the contact.
   */
  useLayoutEffect(() => {
    if (!pendingAnchor) return;
    const container = listRef.current;
    if (!container) return;

    const resolution = resolveContactAnchor(visibleContacts, pendingAnchor);
    if (resolution.index < 0 || !resolution.contact) return;

    const row = findRowElement(container, resolution.contact.id);
    if (!row) return;

    container.scrollTop = scrollTopForAnchor({
      currentScrollTop: container.scrollTop,
      containerTop: container.getBoundingClientRect().top,
      rowTop: row.getBoundingClientRect().top,
      viewportOffset: pendingAnchor.viewportOffset,
    });
    onAnchorConsumed?.();
  }, [pendingAnchor, visibleContacts, onAnchorConsumed]);

  // Row click behavior by mode/type.
  const handleRowSelect = useCallback(
    (contact: ExtendedContact, isExternal: boolean) => {
      if (onContactClick) {
        captureAnchor(contact);
        onContactClick(contact);
        return;
      }
      // BACKLOG-2591: `onExternalSelect` opens this branch too — without it a
      // link picker's external rows would fall through to plain `handleSelect`
      // and never reach the caller at all.
      if (
        isExternal &&
        (onImportContact || onExternalSelect) &&
        !selectedIds.includes(contact.id)
      ) {
        handleExternalSelect(contact);
      } else {
        handleSelect(contact.id);
      }
    },
    [
      handleSelect,
      handleExternalSelect,
      onContactClick,
      onImportContact,
      onExternalSelect,
      selectedIds,
      captureAnchor,
    ],
  );

  const handleImportButtonClick = useCallback(
    (contact: ExtendedContact) => handleImport(contact, false),
    [handleImport],
  );

  // Keyboard navigation.
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      switch (e.key) {
        case "ArrowDown":
          e.preventDefault();
          setFocusedIndex((i) => (i < visibleContacts.length - 1 ? i + 1 : i));
          break;
        case "ArrowUp":
          e.preventDefault();
          setFocusedIndex((i) => (i > 0 ? i - 1 : 0));
          break;
        case "Enter": {
          e.preventDefault();
          if (focusedIndex >= 0 && focusedIndex < visibleContacts.length) {
            const contact = visibleContacts[focusedIndex];
            handleRowSelect(contact, externalSet.has(contact));
          }
          break;
        }
        case "Escape":
          e.preventDefault();
          setSearchQuery("");
          setFocusedIndex(-1);
          searchInputRef.current?.focus();
          break;
      }
    },
    [visibleContacts, focusedIndex, handleRowSelect, externalSet],
  );

  const handleSearchChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setSearchQuery(e.target.value);
    setFocusedIndex(-1);
  };

  // Mirrors the GroupedMultiSelect trigger's neutral palette (gray/white, purple
  // focus ring) — the active option is emphasized with a subtle gray fill, not a
  // new filled-accent visual language.
  const sortButtonClass = (active: boolean): string =>
    `px-3 py-2 text-sm transition-colors focus:outline-none focus:ring-2 focus:ring-inset focus:ring-purple-500 ${
      active ? "bg-gray-100 text-gray-900 font-semibold" : "bg-white text-gray-500 font-medium hover:bg-gray-50"
    }`;

  return (
    <div
      className={`flex flex-col overflow-hidden ${className}`}
      data-testid="contact-search-list"
    >
      {/* Search bar + controls - flex-shrink-0 keeps them pinned at top */}
      <div className="flex-shrink-0">
        {/* Search Input and Add Manually Button */}
        <div className="p-2 sm:p-3 border-b border-gray-200">
          <div className="flex items-center gap-2">
            <div className="relative flex-1">
              <input
                ref={searchInputRef}
                type="text"
                value={searchQuery}
                onChange={handleSearchChange}
                onKeyDown={handleKeyDown}
                placeholder={searchPlaceholder}
                className="w-full pl-10 pr-4 py-2.5 sm:py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-purple-500 focus:border-purple-500 focus:outline-none text-gray-900 bg-white text-sm sm:text-base min-h-[44px]"
                aria-label="Search contacts"
                data-testid="contact-search-input"
              />
              <svg
                className="w-5 h-5 text-gray-400 absolute left-3 top-1/2 -translate-y-1/2"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
                aria-hidden="true"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"
                />
              </svg>
            </div>
            {onAddManually && (
              <button
                type="button"
                onClick={onAddManually}
                className="flex-shrink-0 px-2 py-2 sm:px-3 text-sm font-medium text-purple-600 hover:text-purple-700 hover:bg-purple-50 rounded-lg transition-colors flex items-center gap-1"
                data-testid="add-manually-button"
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 6v6m0 0v6m0-6h6m-6 0H6" />
                </svg>
                <span className="hidden sm:inline">Add Manually</span>
                <span className="sm:hidden">Add</span>
              </button>
            )}
          </div>
        </div>

        {/*
          Sort control (always visible) + Source/Role grouped filters (filter
          modes only). Each label travels with the controls it names — see
          `ControlCluster`. This row wraps BETWEEN clusters and nowhere else, so
          anything added here must go INSIDE a cluster, not beside one.
        */}
        <div
          className="px-2 sm:px-3 py-2 border-b border-gray-100 flex items-center gap-x-3 gap-y-2 flex-wrap"
          data-testid="contact-controls"
        >
          <ControlCluster label="Sort:" testId="contact-sort-cluster">
            <div
              role="group"
              aria-label="Sort order"
              className="inline-flex rounded-lg border border-gray-300 overflow-hidden"
              data-testid="contact-sort-control"
            >
              <button
                type="button"
                onClick={() => setSortOrder("recent")}
                aria-pressed={sortOrder === "recent"}
                className={sortButtonClass(sortOrder === "recent")}
                data-testid="sort-recent"
              >
                Recent
              </button>
              <button
                type="button"
                onClick={() => setSortOrder("alphabetical")}
                aria-pressed={sortOrder === "alphabetical"}
                className={`${sortButtonClass(sortOrder === "alphabetical")} border-l border-gray-300`}
                data-testid="sort-alphabetical"
              >
                Alphabetical
              </button>
              {/*
                BACKLOG-2626, folding in `11abce67` — the chip became an OPTION.

                It used to be a standalone amber pill reading `Needs review · N`.
                Three things changed, all of them the founder's:

                1. **`Autolinked`, not `Needs review`.** These are the contacts the
                   matcher was CONFIDENT about — it attached the record without
                   asking. The genuinely uncertain ones are the open questions.
                   Labelling the confident set "needs review" inverts the signal.
                2. **No count.** *"Just the word."* A number turns a lens into a
                   backlog, and there is nothing here the user is behind on.
                3. **Inside the Sort control**, as one of its options rather than a
                   badge beside it — his words, and it is why this button sits in
                   the same bordered group as Recent and Alphabetical.

                It remains a FILTER rather than a sort: pressing it narrows the list
                and pressing it again restores it, and the chosen sort order is
                untouched either way. That is deliberate and is what he described —
                the control is one segmented cluster, not one exclusive choice.

                Still hidden at zero, like the header's review button: a filter that
                can only ever return an empty list is a dead control.
              */}
              {autolinkedCount > 0 && (
                <button
                  type="button"
                  onClick={() => setAutolinkedOnly((on) => !on)}
                  aria-pressed={autolinkedOnly}
                  className={`${sortButtonClass(autolinkedOnly)} border-l border-gray-300`}
                  data-testid="filter-autolinked"
                >
                  {BADGE_LABELS.autolinked}
                </button>
              )}
            </div>
          </ControlCluster>

          {showFilterUI && (
            <ControlCluster label="Filter:" testId="contact-filter-cluster">
              <GroupedMultiSelect
                groups={SOURCE_GROUPS}
                selected={selectedSources}
                onChange={handleSourcesChange}
                triggerLabel="Source"
                summaryFormatter={formatSourceSummary}
                testId="source-filter"
              />
              <GroupedMultiSelect
                groups={ROLE_GROUPS}
                selected={selectedRoles}
                onChange={handleRolesChange}
                triggerLabel="Role"
                summaryFormatter={formatRoleSummary}
                testId="role-filter"
              />
            </ControlCluster>
          )}
        </div>
      </div>

      {/* Contact List */}
      <div
        ref={listRef}
        className="flex-1 min-h-0 overflow-y-auto"
        role="listbox"
        aria-multiselectable="true"
        aria-label="Contact list"
        onKeyDown={handleKeyDown}
        data-testid="contact-list"
      >
        {/* Loading State */}
        {isLoading && (
          <div className="p-8 text-center" data-testid="loading-state">
            <div
              className="w-8 h-8 border-4 border-purple-600 border-t-transparent rounded-full animate-spin mx-auto mb-2"
              role="status"
              aria-label="Loading"
            />
            <p className="text-gray-500">Loading contacts...</p>
          </div>
        )}

        {/* Error State */}
        {!isLoading && error && (
          <div className="p-8 text-center" data-testid="error-state">
            <svg
              className="w-12 h-12 text-red-400 mx-auto mb-3"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
              aria-hidden="true"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"
              />
            </svg>
            <p className="text-red-600">{error}</p>
          </div>
        )}

        {/* Empty State */}
        {!isLoading && !error && visibleContacts.length === 0 &&
          (showFilterUI && categoryHiddenCount > 0 && !searchQuery ? (
            /* Filtered-empty escape hatch (BACKLOG-2141): filters hid every row. */
            <div className="p-8 text-center text-gray-500" data-testid="empty-state-filtered">
              <svg
                className="w-16 h-16 text-gray-300 mx-auto mb-4"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
                aria-hidden="true"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M3 4a1 1 0 011-1h16a1 1 0 011 1v2.586a1 1 0 01-.293.707l-6.414 6.414a1 1 0 00-.293.707V17l-4 4v-6.879a1 1 0 00-.293-.707L3.293 7.293A1 1 0 013 6.586V4z"
                />
              </svg>
              <p className="mb-3">
                No contacts match your filters
                {" — "}
                {categoryHiddenCount} hidden.
              </p>
              <button
                type="button"
                onClick={handleShowAll}
                className="px-4 py-2 text-sm font-medium text-purple-600 hover:text-purple-700 hover:bg-purple-50 rounded-lg transition-colors"
                data-testid="show-all-filters"
              >
                Show all
              </button>
            </div>
          ) : (
            /* Generic empty state: truly no contacts, or search matched nothing. */
            <div className="p-8 text-center text-gray-500" data-testid="empty-state">
              <svg
                className="w-16 h-16 text-gray-300 mx-auto mb-4"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
                aria-hidden="true"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0zm6 3a2 2 0 11-4 0 2 2 0 014 0zM7 10a2 2 0 11-4 0 2 2 0 014 0z"
                />
              </svg>
              {searchQuery ? (
                <p>No contacts match &quot;{searchQuery}&quot;</p>
              ) : isAddMode && selectedIds.length > 0 ? (
                // BACKLOG-2400: the list is empty in "add" mode only because every
                // available contact has already moved to the Added column.
                <p data-testid="all-added-message">All contacts added</p>
              ) : (
                <p>No contacts available</p>
              )}
            </div>
          ))}

        {/* Contact List Items */}
        {!isLoading &&
          !error &&
          visibleContacts.map((contact, index) => {
            const isExternal = externalSet.has(contact);
            const isSelected =
              selectedIds.includes(contact.id) ||
              (!!activeContactId && activeContactId === contact.id);
            const isImporting = importingIds.has(contact.id);
            const isAdded = addedContactIds.has(contact.id);
            // Selection mode (audit/edit): checkboxes, no buttons.
            // Preview mode (contacts screen): buttons, no checkboxes.
            const isSelectionMode = !onContactClick;

            return (
              <ContactRow
                key={contact.id}
                contact={contact}
                isExternal={isExternal}
                isSelected={isSelected}
                isAdded={isAdded}
                isAdding={isImporting}
                // BACKLOG-2400 "add" mode: swap the checkbox for a "+ Add"
                // button. Selected rows are already filtered out above, so a
                // visible row is always addable.
                showCheckbox={isAddMode ? false : isSelectionMode}
                showAddButton={isAddMode}
                showImportButton={
                  // BACKLOG-2591: `!onExternalSelect` is the fence. In linking
                  // mode an import would CREATE a contact — the one thing this
                  // surface must never do — so the button is suppressed on the
                  // prop that declares linking, not left to the caller to also
                  // remember to omit `onImportContact`.
                  !isAddMode && !compact && !isSelectionMode && !onExternalSelect && !!onImportContact && (isExternal || showAddButtonForImported)
                }
                compact={compact}
                showDetailLine={showDetailLine}
                // BACKLOG-2556: `collapsedRecords` was passed here. The fold
                // that produced them is deleted, so there is nothing to pass.
                onSelect={() => handleRowSelect(contact, isExternal)}
                onImport={() => handleImportButtonClick(contact)}
                // BACKLOG-2603: undefined unless the consumer asked for it, so
                // the badge stays a plain status everywhere it already was.
                onOpenQuestions={
                  onOpenContactQuestions
                    ? () => onOpenContactQuestions(contact)
                    : undefined
                }
                className={focusedIndex === index ? "ring-2 ring-inset ring-purple-500" : ""}
              />
            );
          })}

        {/*
          Partial-filter "show more" action row (BACKLOG-2141): some rows shown
          AND some hidden by the Source/Role filters. Rendered INSIDE the
          scrollable list flow, AFTER the last visible row — clicking anywhere
          performs the "Show all" select-all. Gated on `!searchQuery` so
          search-narrowing never masquerades as filter-hiding.
        */}
        {!isLoading &&
          !error &&
          showFilterUI &&
          visibleContacts.length > 0 &&
          categoryHiddenCount > 0 &&
          !searchQuery && (
            <div data-testid="filter-hidden-footer">
              <button
                type="button"
                onClick={handleShowAll}
                className="w-full px-4 py-3 border-t border-gray-200 bg-white hover:bg-gray-50 active:bg-gray-100 transition-colors flex flex-col items-center gap-0.5 text-center focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-purple-500 min-h-[44px]"
                data-testid="show-all-filters-footer"
              >
                <span className="text-sm font-medium text-purple-600">
                  Show {categoryHiddenCount} more{" "}
                  {categoryHiddenCount === 1 ? "contact" : "contacts"}
                </span>
                <span className="text-xs text-gray-400">hidden by your filters</span>
              </button>
            </div>
          )}
      </div>
    </div>
  );
}

export default ContactSearchList;
