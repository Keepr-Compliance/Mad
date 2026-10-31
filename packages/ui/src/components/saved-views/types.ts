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
}

/** Pin-as-card support. Only the reports that render pinned cards pass it. */
export interface SavedViewsPinning<V extends SavedViewItem> {
  /** Most pinned views allowed. Pinning or saving past it shows a message and calls nothing. */
  max: number;
  /** Pin or unpin `view`. Unpinning is always allowed, even at the cap. */
  onTogglePin: (view: V) => void;
}

export interface SavedViewsProps<V extends SavedViewItem> {
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
  /** Save the page's current state under `name` (trimmed, non-empty). The adopter builds the blob. */
  onSave: (name: string) => void;
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
}

/**
 * RESERVED — deliberately NOT in SavedViewsProps. Each needs a caller first.
 *
 * - Sharing / owner flags (`shared`, `owner`, per-user view / edit / owner
 *   rights): saved views are personal in 2.45 (founder decision). Sharing is
 *   its own item, BACKLOG-4087, merged with 3511 per-report access.
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
