import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";

/**
 * A single selectable child option within a group.
 */
export interface GroupOption {
  /** Stable id used as the key in the parent-owned `selected` Set. */
  id: string;
  /** Human-readable label. */
  label: string;
  /** When true the option renders disabled, never toggles, and is excluded from its parent's tri-state calc. */
  disabled?: boolean;
  /** Optional hint (e.g. "no data") shown next to a disabled option. Data-driven, not a permanent state. */
  hint?: string;
}

/**
 * A group of options with a tri-state parent header (checked / unchecked / indeterminate over ENABLED children).
 *
 * `standalone` groups render as a single top-level checkbox with no parent/child tri-state
 * (e.g. a future "Unassigned" toggle). A `standalone` group MUST contain exactly one child,
 * and its selection keys on `children[0].id` — this is the contract T3 relies on to predict
 * the selection key.
 */
export interface OptionGroup {
  /** Stable id for the group (used for React keys and test ids). */
  id: string;
  /** Group header label. */
  label: string;
  /** Child options. For `standalone` groups this MUST contain exactly one child. */
  children: GroupOption[];
  /**
   * Render a single top-level checkbox instead of a parent + children.
   * The toggle keys on `children[0].id`. Requires exactly one child.
   */
  standalone?: boolean;
}

export interface GroupedMultiSelectProps {
  /** Groups to render. */
  groups: OptionGroup[];
  /** Parent-owned set of selected child ids. The component never mutates this Set. */
  selected: Set<string>;
  /** Called with a NEW Set on every change. The input `selected` is never mutated. */
  onChange: (next: Set<string>) => void;
  /** Label for the trigger button (e.g. "Source", "Role"). Also used as the panel's aria-label. */
  triggerLabel: string;
  /** Optional formatter for the trigger's summary text. Defaults to "All" / "None" / "N selected". */
  summaryFormatter?: (selected: Set<string>, groups: OptionGroup[]) => string;
  /** Disable the whole control. */
  disabled?: boolean;
  /** Extra class names for the root element. */
  className?: string;
  /** Override the base test id (defaults to "grouped-multiselect"). */
  testId?: string;
}

/** All child ids across all groups (both standalone and normal). */
function allChildIds(groups: OptionGroup[]): string[] {
  const ids: string[] = [];
  for (const group of groups) {
    for (const child of group.children) {
      ids.push(child.id);
    }
  }
  return ids;
}

/** Enabled (non-disabled) children of a group. */
function enabledChildren(group: OptionGroup): GroupOption[] {
  return group.children.filter((c) => !c.disabled);
}

type ParentState = "checked" | "unchecked" | "indeterminate";

/**
 * Computes a group's parent tri-state over ENABLED children only.
 * A group with zero enabled children is "unchecked" (and the parent renders disabled — see below).
 */
function computeParentState(group: OptionGroup, selected: Set<string>): ParentState {
  const enabled = enabledChildren(group);
  if (enabled.length === 0) return "unchecked";
  const selectedCount = enabled.filter((c) => selected.has(c.id)).length;
  if (selectedCount === 0) return "unchecked";
  if (selectedCount === enabled.length) return "checked";
  return "indeterminate";
}

/** Default summary: "All" (every child selected), "None", or "N selected". */
function defaultSummary(selected: Set<string>, groups: OptionGroup[]): string {
  const ids = allChildIds(groups);
  const selectedCount = ids.filter((id) => selected.has(id)).length;
  if (selectedCount === 0) return "None";
  if (selectedCount === ids.length) return "All";
  return `${selectedCount} selected`;
}

/**
 * Counts the focusable rows (for roving keyboard focus), matching the render order:
 * - normal group: the parent header (if it has ≥1 enabled child) then each enabled child
 * - standalone group: the single child if enabled
 * Disabled rows are excluded. Kept in lockstep with the `nextRowRef()` cursor at render time.
 */
function countFocusableRows(groups: OptionGroup[]): number {
  let count = 0;
  for (const group of groups) {
    if (group.standalone) {
      const child = group.children[0];
      if (child && !child.disabled) count += 1;
      continue;
    }
    const enabled = enabledChildren(group);
    if (enabled.length > 0) count += 1; // parent header
    count += enabled.length; // enabled children
  }
  return count;
}

/**
 * GroupedMultiSelect
 *
 * A generic, controlled, accessible grouped multi-select dropdown.
 *
 * - Controlled: the parent owns the `selected` Set of child ids and receives a NEW Set on every change.
 * - Tri-state group headers computed over ENABLED children only; disabled children never toggle and are
 *   excluded from the parent state. A group with no enabled children renders a disabled, unchecked header.
 * - `standalone` groups render a single top-level checkbox keyed on `children[0].id` (no tri-state).
 * - Accessibility: the panel is a `role="group"` of real `<input type="checkbox">` rows. Indeterminate
 *   parents are set via ref, which the browser exposes as `aria-checked="mixed"`. Roving keyboard focus
 *   (Arrow Up/Down, Space/Enter toggle, Esc closes and returns focus to the trigger, Tab closes).
 *   Opening the panel moves focus to the first enabled row.
 * - Outside-click and Esc close the panel via a local listener — no external hook dependency.
 *
 * @example
 * <GroupedMultiSelect
 *   triggerLabel="Source"
 *   groups={sourceGroups}
 *   selected={selectedSources}
 *   onChange={setSelectedSources}
 * />
 */
export function GroupedMultiSelect({
  groups,
  selected,
  onChange,
  triggerLabel,
  summaryFormatter,
  disabled = false,
  className = "",
  testId = "grouped-multiselect",
}: GroupedMultiSelectProps): React.ReactElement {
  const [open, setOpen] = useState(false);

  const rootRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  // Refs to each focusable row's input, indexed by focus order (disabled rows excluded).
  const rowRefs = useRef<(HTMLInputElement | null)[]>([]);
  // Current roving-focus index (a ref so keydown handlers read/write it synchronously
  // without relying on state-update timing).
  const activeIndexRef = useRef(0);

  const summary = (summaryFormatter ?? defaultSummary)(selected, groups);

  /** Emit a new Set with `id` toggled to `nextSelected`. Never mutates the input Set. */
  const setChildSelected = useCallback(
    (id: string, nextSelected: boolean) => {
      const next = new Set(selected);
      if (nextSelected) {
        next.add(id);
      } else {
        next.delete(id);
      }
      onChange(next);
    },
    [selected, onChange]
  );

  /** Toggle a single child (no-op if disabled handled by caller). */
  const toggleChild = useCallback(
    (child: GroupOption) => {
      if (child.disabled) return;
      setChildSelected(child.id, !selected.has(child.id));
    },
    [selected, setChildSelected]
  );

  /** Toggle a whole group's enabled children (parent header click). */
  const toggleGroup = useCallback(
    (group: OptionGroup) => {
      const enabled = enabledChildren(group);
      if (enabled.length === 0) return; // no-op: disabled parent
      const next = new Set(selected);
      const state = computeParentState(group, selected);
      // If all enabled are selected, clear them; otherwise select all enabled.
      const selectAll = state !== "checked";
      for (const child of enabled) {
        if (selectAll) {
          next.add(child.id);
        } else {
          next.delete(child.id);
        }
      }
      onChange(next);
    },
    [selected, onChange]
  );

  // Number of focusable rows, kept in lockstep with the `nextRowRef()` cursor at render time.
  const focusableRowCount = useMemo(() => countFocusableRows(groups), [groups]);

  // Close on outside click (mousedown) or Escape while open. Local listener — no external hook.
  useEffect(() => {
    if (!open) return;

    const handleMouseDown = (event: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
        triggerRef.current?.focus();
      }
    };

    document.addEventListener("mousedown", handleMouseDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handleMouseDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [open]);

  // On open, move focus into the panel (first enabled row). The effect runs after the
  // panel has committed, so the row refs are already populated — no rAF needed.
  useEffect(() => {
    if (open) {
      activeIndexRef.current = 0;
      rowRefs.current[0]?.focus();
    }
  }, [open]);

  const moveFocus = useCallback(
    (delta: number) => {
      const count = focusableRowCount;
      if (count === 0) return;
      const nextIndex = (activeIndexRef.current + delta + count) % count;
      activeIndexRef.current = nextIndex;
      rowRefs.current[nextIndex]?.focus();
    },
    [focusableRowCount]
  );

  const handlePanelKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      switch (event.key) {
        case "ArrowDown":
          event.preventDefault();
          moveFocus(1);
          break;
        case "ArrowUp":
          event.preventDefault();
          moveFocus(-1);
          break;
        case "Tab":
          // Let focus leave naturally, but close the panel.
          setOpen(false);
          break;
        // Space/Enter on a checkbox toggles it natively; no extra handling needed.
        default:
          break;
      }
    },
    [moveFocus]
  );

  // Reset the row-ref array before each render so stale refs don't linger.
  rowRefs.current = [];
  let focusIndexCursor = 0;
  const nextRowRef = (): ((el: HTMLInputElement | null) => void) => {
    const index = focusIndexCursor;
    focusIndexCursor += 1;
    return (el: HTMLInputElement | null) => {
      rowRefs.current[index] = el;
    };
  };

  return (
    <div
      ref={rootRef}
      className={`relative inline-block text-left ${className}`.trim()}
      data-testid={testId}
    >
      <button
        ref={triggerRef}
        type="button"
        disabled={disabled}
        aria-haspopup="true"
        aria-expanded={open}
        onClick={() => setOpen((prev) => !prev)}
        className="inline-flex items-center justify-between gap-2 min-w-[140px] px-3 py-2 text-sm border border-gray-300 rounded-lg bg-white text-gray-900 hover:bg-gray-50 focus:ring-2 focus:ring-purple-500 focus:border-purple-500 focus:outline-none disabled:opacity-50 disabled:cursor-not-allowed"
        data-testid={`${testId}-trigger`}
      >
        <span className="font-medium">{triggerLabel}</span>
        <span className="text-gray-500 truncate" data-testid={`${testId}-summary`}>
          {summary}
        </span>
        <svg
          className={`w-4 h-4 text-gray-400 flex-shrink-0 transition-transform ${open ? "rotate-180" : ""}`}
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
          aria-hidden="true"
        >
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {open && (
        <div
          role="group"
          aria-label={triggerLabel}
          onKeyDown={handlePanelKeyDown}
          className="absolute z-20 mt-1 min-w-full w-max max-w-xs bg-white border border-gray-200 rounded-lg shadow-lg py-1 max-h-80 overflow-y-auto"
          data-testid={`${testId}-panel`}
        >
          {groups.map((group) => {
            if (group.standalone) {
              const child = group.children[0];
              if (!child) return null;
              const isChecked = selected.has(child.id);
              const ref = child.disabled ? undefined : nextRowRef();
              return (
                <label
                  key={group.id}
                  className={`flex items-center gap-2 px-3 py-2 text-sm font-medium ${
                    child.disabled
                      ? "text-gray-400 cursor-not-allowed"
                      : "text-gray-900 hover:bg-gray-50 cursor-pointer"
                  }`}
                  data-testid={`${testId}-option-${child.id}`}
                >
                  <input
                    ref={ref}
                    type="checkbox"
                    checked={isChecked}
                    disabled={child.disabled}
                    aria-disabled={child.disabled || undefined}
                    onChange={() => toggleChild(child)}
                    className="h-4 w-4 rounded border-gray-300 text-purple-600 focus:ring-purple-500"
                    data-testid={`${testId}-checkbox-${child.id}`}
                  />
                  <span className="flex-1">{child.label}</span>
                  {child.hint && (
                    <span className="text-xs text-gray-400" data-testid={`${testId}-hint-${child.id}`}>
                      {child.hint}
                    </span>
                  )}
                </label>
              );
            }

            const enabled = enabledChildren(group);
            const parentDisabled = enabled.length === 0;
            const parentState = computeParentState(group, selected);
            const parentRef = parentDisabled ? undefined : nextRowRef();

            return (
              <div key={group.id} role="group" aria-label={group.label}>
                {/* Group header (tri-state parent) */}
                <label
                  className={`flex items-center gap-2 px-3 py-2 text-sm font-semibold border-t border-gray-100 first:border-t-0 ${
                    parentDisabled
                      ? "text-gray-400 cursor-not-allowed"
                      : "text-gray-900 hover:bg-gray-50 cursor-pointer"
                  }`}
                  data-testid={`${testId}-group-${group.id}`}
                >
                  <input
                    ref={(el) => {
                      if (el) el.indeterminate = parentState === "indeterminate";
                      if (parentRef) parentRef(el);
                    }}
                    type="checkbox"
                    checked={parentState === "checked"}
                    disabled={parentDisabled}
                    aria-disabled={parentDisabled || undefined}
                    onChange={() => toggleGroup(group)}
                    className="h-4 w-4 rounded border-gray-300 text-purple-600 focus:ring-purple-500"
                    data-testid={`${testId}-group-checkbox-${group.id}`}
                  />
                  <span className="flex-1">{group.label}</span>
                </label>

                {/* Children */}
                {group.children.map((child) => {
                  const isChecked = selected.has(child.id);
                  const childRef = child.disabled ? undefined : nextRowRef();
                  return (
                    <label
                      key={child.id}
                      className={`flex items-center gap-2 pl-8 pr-3 py-1.5 text-sm ${
                        child.disabled
                          ? "text-gray-400 cursor-not-allowed"
                          : "text-gray-700 hover:bg-gray-50 cursor-pointer"
                      }`}
                      data-testid={`${testId}-option-${child.id}`}
                    >
                      <input
                        ref={childRef}
                        type="checkbox"
                        checked={isChecked}
                        disabled={child.disabled}
                        aria-disabled={child.disabled || undefined}
                        onChange={() => toggleChild(child)}
                        className="h-4 w-4 rounded border-gray-300 text-purple-600 focus:ring-purple-500"
                        data-testid={`${testId}-checkbox-${child.id}`}
                      />
                      <span className="flex-1">{child.label}</span>
                      {child.hint && (
                        <span className="text-xs text-gray-400" data-testid={`${testId}-hint-${child.id}`}>
                          {child.hint}
                        </span>
                      )}
                    </label>
                  );
                })}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

export default GroupedMultiSelect;
