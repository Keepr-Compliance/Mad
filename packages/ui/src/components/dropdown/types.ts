import type { ReactNode, Ref } from 'react';

/**
 * Dropdown types (BACKLOG-4032 slice 1).
 *
 * Slice 1 builds: single choice, field trigger, search, description,
 * disabled + hint, invalid. Fields and props marked RESERVED are typed now so
 * later modes (multi, filter trigger, groups, counts, leading icons, clear)
 * are additive and do not change an existing signature. They render nothing
 * in slice 1.
 */
export interface DropdownOption<V extends string = string> {
  value: V;
  label: string;
  /** Second line under the label (text-xs; text-sm in comfortable rows). Searched by the filter. */
  description?: string;
  /** Shown greyed out; cannot be picked; skipped by the arrow keys. */
  disabled?: boolean;
  /** Why the row is disabled. Rendered under the label and used as the row's accessible description. */
  hint?: string;
  /** Extra search terms that are not shown. */
  keywords?: readonly string[];
  /** RESERVED (not rendered in slice 1): dot, icon or avatar before the label. */
  leading?: ReactNode;
  /** RESERVED (not rendered in slice 1): right-aligned count. */
  count?: number;
  /** RESERVED (not rendered in slice 1): section header the option sits under. */
  group?: string;
}

/**
 * Every Dropdown needs an accessible name: a visible `label`, or an
 * `ariaLabel` when there is no visible label (filter bars).
 */
export type DropdownLabelling =
  | { label: string; ariaLabel?: undefined }
  | { ariaLabel: string; label?: undefined };

interface DropdownBaseProps<V extends string> {
  options: readonly DropdownOption<V>[];
  /** id of the trigger button. Defaults to a generated id. */
  id?: string;
  /** Trigger text when nothing is chosen. */
  placeholder?: string;
  /** Show the search field at the top of the panel. Default true. */
  searchable?: boolean;
  /** Placeholder of the search field. Also its accessible name when given. */
  searchPlaceholder?: string;
  /** Text when the search matches nothing. Default "No results". */
  emptyText?: string;
  /** Marks the field invalid (danger border + ring, aria-invalid). */
  invalid?: boolean;
  /** Error message under the field (role=alert, linked by aria-describedby). */
  error?: string;
  disabled?: boolean;
  /**
   * Trigger look. 'field' (default): full-width form field. 'filter': the
   * compact report-filter pill (same classes as MultiSelect's trigger), no
   * visible label (the label / ariaLabel still names it), panel at least
   * `min-w-56` wide. The pill turns blue only when it has a value AND
   * `onClear` is given (a removable filter).
   */
  variant?: 'field' | 'filter';
  /** Leading icon inside the trigger (decorative; mark it aria-hidden). */
  triggerIcon?: ReactNode;
  /** Ref to the trigger button, e.g. to return focus to it from another popover. */
  triggerRef?: Ref<HTMLButtonElement>;
  /**
   * Where the options open. 'popover' (default): the inline panel under the
   * trigger. 'sheet': a BottomSheet titled by the label, comfortable rows, a
   * pick commits and closes (no footer). The parent chooses, e.g.
   * `presentation={isPhone ? 'sheet' : 'popover'}`; the component does no
   * matchMedia. Commit-on-pick is single mode only: multi mode is popover
   * only (its sheet needs a pending selection + Apply footer, RESERVED).
   */
  presentation?: 'popover' | 'sheet';
  className?: string;
}

export type DropdownSingleProps<V extends string = string> = DropdownBaseProps<V> &
  DropdownLabelling & {
    /** Omitted or 'single': one value. `mode: 'multi'` is DropdownMultiProps. */
    mode?: 'single';
    value: V | null;
    onChange: (value: V) => void;
    /**
     * Clear back to no value, for the filter trigger. Single mode: only marks
     * the filter pill as removable (blue while it has a value); the clear X is
     * RESERVED in single mode (not rendered).
     */
    onClear?: () => void;
  };

/**
 * Multi choice (BACKLOG-4032 slice 4a), popover only. A toggle (click or
 * Enter) commits at once and keeps the panel open. The panel always shows a
 * "Select all" / "Clear all" strip; both act on the whole option set (enabled
 * options only), not on the search results.
 *
 * RESERVED in multi: `presentation="sheet"` (needs a pending selection and an
 * Apply footer), option `count`, `group` headers, chips in the trigger, and a
 * prop to hide the bulk strip (no caller turns it off).
 */
export type DropdownMultiProps<V extends string = string> = Omit<DropdownBaseProps<V>, 'presentation'> &
  DropdownLabelling & {
    mode: 'multi';
    /** Fully controlled; the component keeps no copy. The pill reads "Label (n)" with n = value.length. */
    value: readonly V[];
    /** Called once per toggle, Select all or Clear all. Never on a search keystroke or Escape. */
    onChange: (value: V[]) => void;
    /**
     * Renders the sibling "Clear <Label> filter" X while value is non-empty
     * (the pill is blue then). Called alone: the parent sets the value to [].
     */
    onClear?: () => void;
    /** Popover only in multi. */
    presentation?: 'popover';
  };

/** Discriminated on `mode`: omitted / 'single' = DropdownSingleProps, 'multi' = DropdownMultiProps. */
export type DropdownProps<V extends string = string> = DropdownSingleProps<V> | DropdownMultiProps<V>;

/** Single: one value, `onSelect` on a pick (the parent closes). */
export interface DropdownOptionsSingleProps<V extends string = string> extends DropdownOptionsBaseProps<V> {
  mode?: 'single';
  value: V | null;
  /** Called when an enabled row is picked (click or Enter). */
  onSelect: (value: V) => void;
}

/** Multi: a toggle calls `onChange(next)`; the parent keeps the panel open. */
export interface DropdownOptionsMultiProps<V extends string = string> extends DropdownOptionsBaseProps<V> {
  mode: 'multi';
  value: readonly V[];
  /** Called with the next selection on a toggle, Select all or Clear all. */
  onChange: (value: V[]) => void;
}

export type DropdownOptionsProps<V extends string = string> = DropdownOptionsSingleProps<V> | DropdownOptionsMultiProps<V>;

interface DropdownOptionsBaseProps<V extends string = string> {
  options: readonly DropdownOption<V>[];
  /** Accessible name of the listbox (and, by default, of the search field). */
  ariaLabel: string;
  /** id of an element that labels the listbox. Takes precedence over ariaLabel for the listbox. */
  labelledBy?: string;
  searchable?: boolean;
  searchPlaceholder?: string;
  emptyText?: string;
  /** Controlled search text. Uncontrolled when omitted. */
  query?: string;
  onQueryChange?: (query: string) => void;
  /** Focus the search field (or the listbox when not searchable) on mount. */
  autoFocus?: boolean;
  /**
   * Called when Tab leaves the panel (the parent closes its popover): Tab or
   * Shift+Tab in the focus host. In multi, Tab first visits the enabled bulk
   * buttons and onTabOut fires on Tab from the last enabled one.
   */
  onTabOut?: () => void;
  /** 'default' = desktop popover rows (min-h-9 text-sm); 'comfortable' = phone sheet rows (min-h-12 text-base). */
  size?: 'default' | 'comfortable';
  /** Fill the parent's height: the list takes the remaining space and scrolls inside it (fixed-height phone sheet). */
  fill?: boolean;
  className?: string;
}

/**
 * Internal row model. Slice 1 only produces `option` rows; `header` is
 * reserved for groups so keyboard navigation already skips non-option rows.
 */
export type DropdownRow<V extends string = string> =
  | { kind: 'option'; option: DropdownOption<V>; id: string; labelId: string }
  | { kind: 'header'; label: string; id: string };
