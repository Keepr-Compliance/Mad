import type { ReactNode } from 'react';

/**
 * SharingDialog types (BACKLOG-3513 PR-1). The dialog is generic: it knows
 * people, roles and access levels, never what is being shared.
 */

/** Two levels plus Owner (founder ruling, 2026-11-10). Ordered: viewer < editor. */
export type SharingLevel = 'viewer' | 'editor';

/** One choice in the Access select and the row menu. */
export interface SharingLevelOption {
  value: SharingLevel;
  label: string;
  /** Second line, e.g. "Opens the report". */
  description?: string;
}

/** Someone, or a role, the item can be shared with. */
export interface SharingPrincipal {
  id: string;
  kind: 'person' | 'role';
  /** Display name. A role row reads "Role: <name>". */
  name: string;
  /** Second line, e.g. "Agent" or "4 people". */
  detail?: string;
  /**
   * The highest level this principal may hold (e.g. 'viewer' for an agent).
   * Levels above it are shown disabled. Presentation only: the server refuses
   * the write on its own.
   */
  maxLevel?: SharingLevel;
}

/** A principal that has access now. */
export interface SharingEntry extends SharingPrincipal {
  level: SharingLevel;
}

/** The one owner, listed first with no menu. */
export interface SharingOwner {
  id: string;
  name: string;
  /** The viewer of the dialog is the owner: the row reads "<name> (You)" ("You" when name is empty). */
  isYou?: boolean;
  /** Second line, e.g. "Broker · created this report". */
  detail?: string;
}

export interface SharingGeneralAccessOption {
  value: string;
  label: string;
  /** Shown under "Who can open it" while this option is selected. */
  description?: string;
}

/** "Who can open it": e.g. Only people added / Everyone in <org>. */
export interface SharingGeneralAccess {
  value: string;
  options: readonly SharingGeneralAccessOption[];
  onChange: (value: string) => void;
  disabled?: boolean;
  /** Visible label. Default "Who can open it". */
  label?: string;
}

/** A caller-owned block under General access, e.g. "What each person sees". */
export interface SharingExtraSection {
  title: string;
  content: ReactNode;
}

export interface SharingDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** What is being shared, for the title: Share “<name>”. */
  name: string;
  /** The line under the title. */
  description?: string;
  /** Access levels, lowest first. Default Can view / Can edit. */
  levels?: readonly SharingLevelOption[];
  /** Who may be added, from a server-side scoped function. Null while loading. */
  candidates: readonly SharingPrincipal[] | null;
  /**
   * Who has access now, owner excluded. Null while loading. A new `entries` array is the source of
   * truth: it replaces any row the dialog hid or re-levelled after a successful write. Keep it the
   * same array between reads (e.g. useMemo) so the dialog can tell a read from a re-render.
   */
  entries: readonly SharingEntry[] | null;
  owner?: SharingOwner;
  /** What the server said when it refused the last write, or null. */
  error: string | null;
  /** Placeholder of the add field. Default "Name or role". */
  searchPlaceholder?: string;
  /** Give every picked principal `level`, in one call. */
  onGrant: (principals: SharingPrincipal[], level: SharingLevel) => void;
  /**
   * Change an entry's level in place. Not called when the level is unchanged.
   * Return the write's promise to get the in-flight state: while it is pending the row reads
   * "Saving…" and its menu is disabled; on success the row shows the new level at once; on failure
   * the row is as before (show the refusal through `error`).
   */
  onChangeLevel: (entry: SharingEntry, level: SharingLevel) => void | Promise<unknown>;
  /**
   * Take access away. Called only after the in-dialog confirm.
   * Return the write's promise to get the in-flight state: while it is pending the row reads
   * "Removing…" and its menu is disabled (no second remove); on success the row leaves the list at
   * once; on failure it stays (show the refusal through `error`).
   */
  onRemove: (entry: SharingEntry) => void | Promise<unknown>;
  /** Make a person the owner. Absent: no "Make owner…" item. Called only after the confirm. */
  onTransferOwnership?: (entry: SharingEntry) => void;
  generalAccess?: SharingGeneralAccess;
  extraSection?: SharingExtraSection;
  /** Absent: no Copy link button. */
  onCopyLink?: () => void;
}
