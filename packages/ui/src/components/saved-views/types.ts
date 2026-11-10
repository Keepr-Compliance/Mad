import type { ReactNode } from 'react';

/**
 * SavedViews types (BACKLOG-4083).
 *
 * The kit component is STORAGE-AGNOSTIC: it never reads or writes views
 * itself. The adopter (admin-portal, BACKLOG-4084) owns the store, the blob
 * shape (filters plus the time range) and how a view is applied. Every prop
 * below has a 4084 caller; see the PR body's prop-to-caller table.
 */

/** What the component needs from a view. The adopter's own view type extends it. */
export interface SavedViewItem {
  id: string;
  name: string;
  /** Read only when `pinning` is given (pin button state, badge count, cap). */
  pinned?: boolean;
  /**
   * The user's access to this view (BACKLOG-4087). Missing means 'owner', so an
   * adopter that never sets it renders exactly as before sharing existed.
   * 'editor' and 'viewer' rows are listed under "Shared with you", after the
   * user's own rows, without Default, Pin or Delete. Hiding them is
   * presentation only: the server functions refuse those writes on their own.
   */
  access?: SavedViewAccess;
  /** Who shared the view. Shown on shared rows ("shared by <ownerName>"); ignored on own rows. */
  ownerName?: string;
}

/** BACKLOG-4087. */
export type SavedViewAccess = 'owner' | 'editor' | 'viewer';

/**
 * What an editor may change on a shared view (BACKLOG-4087): the filters and
 * the metric, nothing else. A CLOSED type on purpose: an object literal that
 * also carries `name`, `pinned` or a default flag is a type error
 * (saved-views.contract.test-d.tsx), and the component builds the payload
 * from these two fields only, so extra fields never reach `onUpdate` at
 * runtime either.
 */
export interface SavedViewUpdate<F = unknown, M = unknown> {
  filters: F;
  metric: M;
}

/** Sharing support (BACKLOG-4087). Absent: no Share, Update or Leave buttons. */
export interface SavedViewsSharing<V extends SavedViewItem, F = unknown, M = unknown> {
  /**
   * Open the adopter's ShareDialog for `view`. Offered on the user's own rows only. The panel closes first.
   * Optional (BACKLOG-4144): absent, own rows get no Share while shared rows keep Update and Leave.
   */
  onShare?: (view: V) => void;
  /** The user stops seeing a view shared with them. Called only after the in-panel confirm. */
  onLeave: (view: V) => void;
  /**
   * Save the page's current filters and metric into a view shared with the
   * user as an editor. Offered on 'editor' rows only. The payload holds
   * exactly `filters` and `metric`. Without `updateMetric` both come from
   * `current()` at click time. With `updateMetric` (BACKLOG-4142) the filters
   * come from `current()` and the metric is the one picked in the form.
   */
  onUpdate: (view: V, payload: SavedViewUpdate<F, M>, options?: SavedViewUpdateOptions) => void;
  /** The page's current filters and metric. Read when an editor updates a view. */
  current: () => SavedViewUpdate<F, M>;
  /**
   * Let an editor change the view's metric (BACKLOG-4142). Absent: Update is
   * one click with `current()`, as before. Given: Update opens an inline form
   * in the panel (same pattern as the Leave confirm) holding `render(...)`,
   * seeded with `initial(view)`, with Cancel and "Update view". The confirm
   * sends `{ filters: current().filters, metric: <picked> }` with
   * `{ metricPicked: true }` as the third argument, so an editor who
   * changes nothing sends the view's own metric back, never the page's.
   */
  updateMetric?: SavedViewUpdateMetric<V, M>;
}

/**
 * Passed as `onUpdate`'s third argument from the `updateMetric` form only
 * (BACKLOG-4142). Its presence tells the adopter that `payload.metric` was
 * picked by the editor; a one-click Update never passes it, so an adopter can
 * keep the view's own metric when it is missing.
 */
export interface SavedViewUpdateOptions {
  metricPicked: true;
}

/** BACKLOG-4142. See `SavedViewsSharing.updateMetric`. */
export interface SavedViewUpdateMetric<V extends SavedViewItem, M = unknown> {
  /** The metric the form starts with: the view's own. */
  initial: (view: V) => M;
  /** The picker. Controlled: render `value` and call `onChange` with the new metric. */
  render: (value: M, onChange: (next: M) => void) => ReactNode;
}

/** How a view was saved when `pinning` is given (BACKLOG-4132). */
export interface SaveViewOptions {
  /** True from "Save current view as a card" (save and pin); false from "Save current view". */
  pin: boolean;
}

/** Pin-as-card support. Only the reports that render pinned cards pass it. */
export interface SavedViewsPinning<V extends SavedViewItem> {
  /** Most pinned views allowed. Pinning or saving as a card past it shows a message and calls nothing; a plain save is not capped. */
  max: number;
  /** Pin or unpin `view`. Unpinning is always allowed, even at the cap. */
  onTogglePin: (view: V) => void;
}

export interface SavedViewsProps<V extends SavedViewItem, F = unknown, M = unknown> {
  /**
   * The user's views for this report, or null when they could not be read.
   * Null FAILS CLOSED: the panel says saved views are not available yet and
   * offers no save form.
   */
  views: V[] | null;
  /** True while the list is being read. */
  loading: boolean;
  /** Which view, if any, the page's current state matches. Compared by id. */
  activeViewId: string | null;
  /**
   * What the store said when it refused the last write, or null. REQUIRED, not
   * optional: an adopter that forgets to wire it swallows the refusal, and that
   * must be a type error rather than a silence. A local validation message
   * (empty name, pin cap) wins over it.
   */
  writeError: string | null;
  /** Apply `view` to the page. The panel closes and focus returns to the trigger. */
  onApply: (view: V) => void;
  /** Delete `view`. No confirm (parity with the one-off selector). */
  onDelete: (view: V) => void;
  /**
   * Save the page's current state under `name` (trimmed, non-empty). The adopter builds the blob.
   * Without `pinning` it is called as `onSave(name)`. With `pinning` (BACKLOG-4132) the panel has
   * two save rows and passes which one was used: `{ pin: false }` from "Save current view",
   * `{ pin: true }` from "Save current view as a card". The adopter pins only on `pin: true`.
   */
  onSave: (name: string, options?: SaveViewOptions) => void;
  /** The sentence in the save form saying what a view keeps, e.g. "Saves the filters and the time range". */
  saveHint: string;
  /** The view that opens automatically with the report, or null. Compared by id. */
  defaultViewId: string | null;
  /**
   * Make `view` the default, or pass null to stop opening any view by default.
   * The per-row toggle calls `onSetDefault(view)` on a non-default row and
   * `onSetDefault(null)` on the current default.
   */
  onSetDefault: (view: V | null) => void;
  /** Pin-as-card support (iPhone sync and Exports only). Absent: no pin buttons, no badge. */
  pinning?: SavedViewsPinning<V>;
  /** Extra fields rendered inside the save form while it is open, e.g. a card's column and function selects. */
  saveFields?: ReactNode;
  /**
   * Reset the page to the report's built-in state (BACKLOG-4121). When given
   * and `activeViewId` matches a listed view, the trigger shows that view's
   * name and an X button beside it calls this. Absent: the plain "Views"
   * trigger, no X.
   */
  onClear?: () => void;
  /** Sharing support (BACKLOG-4087). Absent: no Share, Update or Leave buttons; shared rows still list read-only. */
  sharing?: SavedViewsSharing<V, F, M>;
}

/**
 * RESERVED — deliberately NOT in SavedViewsProps. Each needs a caller first.
 *
 * - Sharing: BUILT in BACKLOG-4087 (`access`, `ownerName`, `sharing`, ShareDialog).
 *   An editor changing the metric: BUILT in BACKLOG-4142 (`sharing.updateMetric`).
 *   Still reserved: renaming a shared view, an editor changing the pin or the
 *   default of a shared view, and re-sharing by a non-owner.
 * - `onRename`: no rename UI exists today and no 4084 caller renames.
 * - Delete key on a focused row: deleting has no confirm today, so a key that
 *   deletes the focused row would be easier to hit by accident than the
 *   button. Mouse and keyboard keep parity through the Delete button.
 * - `presentation: 'popover' | 'sheet'`: no 4084 caller passes 'sheet'. The
 *   admin report pickers stay popover (4032 S2 SR ruling, BACKLOG-3919). The
 *   in-kit Dropdown sheet was wired because it had a caller (org-people.tsx);
 *   this one has none. This panel also holds a text field (the view name), so
 *   a sheet version needs a footer with the save button, not commit-on-pick.
 */
