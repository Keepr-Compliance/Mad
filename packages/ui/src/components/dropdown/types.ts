import type { ReactNode } from 'react';

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
  /** Trigger look. Only 'field' is built; 'filter' is RESERVED. */
  variant?: 'field';
  /**
   * Where the options open. 'popover' (default): the inline panel under the
   * trigger. 'sheet': a BottomSheet titled by the label, comfortable rows, a
   * pick commits and closes (no footer). The parent chooses, e.g.
   * `presentation={isPhone ? 'sheet' : 'popover'}`; the component does no
   * matchMedia. Commit-on-pick is single mode only: a later multi mode in a
   * sheet needs a footer button.
   */
  presentation?: 'popover' | 'sheet';
  className?: string;
}

export type DropdownSingleProps<V extends string = string> = DropdownBaseProps<V> &
  DropdownLabelling & {
    /** Only 'single' is built. 'multi' is RESERVED and will join this union as its own member. */
    mode?: 'single';
    value: V | null;
    onChange: (value: V) => void;
    /** RESERVED (not rendered in slice 1): clear back to no value, for the filter trigger. */
    onClear?: () => void;
  };

/**
 * Discriminated on `mode`. Today the union has one member; a later
 * `DropdownMultiProps` (`mode: 'multi'`, `value: V[]`, `onChange(v: V[])`) is
 * added alongside it without changing the single signature.
 */
export type DropdownProps<V extends string = string> = DropdownSingleProps<V>;

export interface DropdownOptionsProps<V extends string = string> {
  options: readonly DropdownOption<V>[];
  value: V | null;
  /** Called when an enabled row is picked (click or Enter). */
  onSelect: (value: V) => void;
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
  /** Called when Tab is pressed in the focus host (the parent closes its popover). */
  onTabOut?: () => void;
  /** 'default' = desktop popover rows (min-h-9 text-sm); 'comfortable' = phone sheet rows (min-h-12 text-base). */
  size?: 'default' | 'comfortable';
  className?: string;
}

/**
 * Internal row model. Slice 1 only produces `option` rows; `header` is
 * reserved for groups so keyboard navigation already skips non-option rows.
 */
export type DropdownRow<V extends string = string> =
  | { kind: 'option'; option: DropdownOption<V>; id: string; labelId: string }
  | { kind: 'header'; label: string; id: string };
