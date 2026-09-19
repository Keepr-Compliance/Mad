import React, { useCallback, useEffect, useRef, useState } from "react";

/**
 * BACKLOG-3156 stage C — THE ROW'S OVERFLOW MENU.
 *
 * ===========================================================================
 * WHY A MENU AND NOT THE BUTTON THAT WAS THERE
 * ===========================================================================
 * The approved design merges the status pill and the action into ONE control
 * per row, and the connected state of that control is a LABEL: it reads
 * "Connected" and does nothing when clicked. That leaves disconnecting without
 * a home, and the two candidates were a hover-swap (green chip becomes a red
 * Disconnect while pointed at) and this — an overflow menu.
 *
 * The hover swap was rejected because it has no touch equivalent: on a tablet
 * the row would either disconnect on tap, which is the glance-and-tap accident
 * the whole decision exists to prevent, or offer no way to disconnect at all.
 * A menu behaves the same with a mouse and a finger.
 *
 * ===========================================================================
 * WHAT THIS COMPONENT DOES AND DOES NOT DO
 * ===========================================================================
 * It renders a trigger and, while open, a small panel of items. It does not
 * decide whether an item is destructive, does not confirm anything, and does
 * not know what a connection is — a caller that needs a confirmation step
 * builds one and passes the opener as `onSelect`. `settingsConnectionControl-3156`
 * asserts the confirmation gate on the CALLER, where it lives.
 *
 * Dismissal: selecting an item closes it, Escape closes it, a pointer press
 * outside the wrapper closes it, and pressing the trigger again toggles it.
 * The outside-press listener is attached to `document` only while the menu is
 * open. This is a deliberate departure from `ImportInfoPopover`, whose
 * `onMouseDown`/`preventDefault` pairing means clicking elsewhere does NOT
 * close it — that model is survivable for a panel of prose and is not for a
 * panel with a destructive item in it, which should not be able to sit open
 * behind a click the user aimed somewhere else.
 */

export interface ConnectionMenuItem {
  /** Visible text of the item. */
  label: string;
  /**
   * Accessible name. All rows show the same word ("Disconnect"), so the
   * visible label alone cannot tell a screen reader which account it acts on.
   */
  ariaLabel: string;
  onSelect: () => void;
  /** Rendered as `data-testid`. */
  testId: string;
  disabled?: boolean;
  /** Native tooltip — used to say WHY an item is disabled. */
  title?: string;
  /** `destructive` paints the item red. It changes nothing about behaviour. */
  tone?: "default" | "destructive";
}

interface ConnectionMenuProps {
  items: ConnectionMenuItem[];
  /** Accessible name of the ⋮ trigger, e.g. "Gmail connection options". */
  triggerAriaLabel: string;
  /** Prefix for the two testids: `${testId}-trigger` and `${testId}-menu`. */
  testId: string;
}

export function ConnectionMenu({
  items,
  triggerAriaLabel,
  testId,
}: ConnectionMenuProps): React.ReactElement {
  const [open, setOpen] = useState(false);
  const wrapperRef = useRef<HTMLDivElement | null>(null);

  const close = useCallback(() => setOpen(false), []);

  useEffect(() => {
    if (!open) return;

    const onPointerDown = (event: MouseEvent): void => {
      const target = event.target;
      if (
        wrapperRef.current &&
        target instanceof Node &&
        !wrapperRef.current.contains(target)
      ) {
        close();
      }
    };
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") close();
    };

    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open, close]);

  return (
    <div className="relative" ref={wrapperRef}>
      <button
        type="button"
        onClick={() => setOpen((wasOpen) => !wasOpen)}
        className="p-1 -mr-1 text-gray-400 hover:text-gray-600 rounded transition-colors"
        aria-label={triggerAriaLabel}
        aria-haspopup="menu"
        aria-expanded={open}
        data-testid={`${testId}-trigger`}
      >
        {/* Kebab: three dots stacked vertically. */}
        <svg className="w-4 h-4" viewBox="0 0 24 24" fill="currentColor">
          <circle cx="12" cy="5" r="2" />
          <circle cx="12" cy="12" r="2" />
          <circle cx="12" cy="19" r="2" />
        </svg>
      </button>
      {open && (
        <div
          role="menu"
          data-testid={`${testId}-menu`}
          className="absolute right-0 top-full mt-1 min-w-[10rem] py-1 bg-white rounded-lg shadow-lg border border-gray-200 z-20"
        >
          {items.map((item) => (
            <button
              key={item.testId}
              type="button"
              role="menuitem"
              aria-label={item.ariaLabel}
              title={item.title}
              disabled={item.disabled}
              data-testid={item.testId}
              onClick={() => {
                close();
                item.onSelect();
              }}
              className={`block w-full text-left px-3 py-2 text-sm transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${
                item.tone === "destructive"
                  ? "text-red-700 hover:bg-red-50"
                  : "text-gray-700 hover:bg-gray-50"
              }`}
            >
              {item.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
