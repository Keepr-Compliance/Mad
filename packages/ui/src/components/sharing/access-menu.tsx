'use client';

import * as React from 'react';
import { Check } from 'lucide-react';
import { cn } from '../../lib/cn';
import { useClickOutside } from '../../lib/use-click-outside';

/**
 * The row's access menu (BACKLOG-3513): role="menu" with menuitemradio rows
 * for the levels, a separator, and menuitem actions. The kit has no menu
 * primitive (Dropdown is a listbox), so this one is local to sharing/.
 *
 * Keyboard: focus lands on the checked level (or the first enabled item);
 * ArrowUp/ArrowDown/Home/End move between enabled items; Enter/Space
 * activate (native buttons); Tab closes. Escape is caught on window in the
 * capture phase while open, the same way Dropdown does it, so the enclosing
 * Radix Dialog does not also close.
 *
 * A pointer-down outside `containerRef` (the row holding the trigger and the
 * menu) closes it without moving focus; a click on the trigger toggles.
 *
 * Disabled items stay in the menu with aria-disabled (so a screen reader
 * hears they exist), are skipped by the arrow keys and do nothing on click.
 */
export type AccessMenuItem =
  | {
      kind: 'radio';
      key: string;
      label: string;
      description?: string;
      checked: boolean;
      disabled?: boolean;
      hint?: string;
      onSelect: () => void;
    }
  | { kind: 'separator'; key: string }
  | {
      kind: 'action';
      key: string;
      label: string;
      tone?: 'danger';
      disabled?: boolean;
      hint?: string;
      onSelect: () => void;
    };

export interface AccessMenuProps {
  /** Accessible name of the menu, e.g. "Access for Jordan Lee". */
  ariaLabel: string;
  items: readonly AccessMenuItem[];
  /** Close the menu. `restoreFocus`: put focus back on the trigger. */
  onClose: (restoreFocus: boolean) => void;
  id?: string;
  /** The element holding the trigger and the menu. Pointer-down outside it closes the menu. Default: the menu. */
  containerRef?: React.RefObject<HTMLElement | null>;
}

export function AccessMenu({ ariaLabel, items, onClose, id, containerRef }: AccessMenuProps) {
  const menuRef = React.useRef<HTMLDivElement>(null);

  const enabledButtons = React.useCallback((): HTMLButtonElement[] => {
    const all = menuRef.current?.querySelectorAll<HTMLButtonElement>('[data-menu-item]') ?? [];
    return Array.from(all).filter((b) => b.getAttribute('aria-disabled') !== 'true');
  }, []);

  // Focus the checked level, else the first enabled item, on open.
  React.useEffect(() => {
    const checked = menuRef.current?.querySelector<HTMLButtonElement>('[data-menu-item][aria-checked="true"]');
    if (checked && checked.getAttribute('aria-disabled') !== 'true') checked.focus();
    else enabledButtons()[0]?.focus();
  }, [enabledButtons]);

  // Escape: window capture, so the Dialog's own Escape never sees it.
  const onCloseRef = React.useRef(onClose);
  onCloseRef.current = onClose;
  React.useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      e.preventDefault();
      onCloseRef.current(true);
    }
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);

  const closeFromOutside = React.useCallback(() => onCloseRef.current(false), []);
  useClickOutside(containerRef ?? menuRef, closeFromOutside, true);

  function onKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    const buttons = enabledButtons();
    if (buttons.length === 0) return;
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
    let next: number | null = null;
    if (e.key === 'ArrowDown') next = index < 0 ? 0 : (index + 1) % buttons.length;
    else if (e.key === 'ArrowUp') next = index < 0 ? buttons.length - 1 : (index - 1 + buttons.length) % buttons.length;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = buttons.length - 1;
    else if (e.key === 'Tab') {
      onClose(false);
      return;
    }
    if (next !== null) {
      e.preventDefault();
      buttons[next].focus();
    }
  }

  return (
    <div
      ref={menuRef}
      id={id}
      role="menu"
      aria-label={ariaLabel}
      data-slot="sharing-access-menu"
      onKeyDown={onKeyDown}
      className="flex w-full flex-col rounded-lg border border-gray-200 bg-white p-1 shadow-lg sm:w-72"
    >
      {items.map((item) => {
        if (item.kind === 'separator') {
          return <div key={item.key} role="separator" className="my-1 h-px bg-gray-200" />;
        }
        const disabled = item.disabled === true;
        const activate = () => {
          if (!disabled) item.onSelect();
        };
        if (item.kind === 'radio') {
          return (
            <button
              key={item.key}
              type="button"
              role="menuitemradio"
              aria-checked={item.checked}
              aria-disabled={disabled ? true : undefined}
              tabIndex={-1}
              data-menu-item=""
              onClick={activate}
              className={cn(
                'flex items-start gap-2 rounded-md px-2.5 py-2 text-left focus:bg-gray-100 focus:outline-none',
                item.checked && 'bg-gray-100',
                disabled ? 'cursor-not-allowed opacity-50' : 'hover:bg-gray-100'
              )}
            >
              <span className="mt-0.5 flex h-4 w-4 flex-shrink-0 items-center justify-center" aria-hidden="true">
                {item.checked ? <Check className="h-3.5 w-3.5 text-primary-700" strokeWidth={2.5} /> : null}
              </span>
              <span className="flex flex-col gap-0.5">
                <span className={cn('text-sm text-gray-900', item.checked && 'font-medium')}>{item.label}</span>
                {disabled && item.hint ? (
                  <span className="text-xs text-gray-500">{item.hint}</span>
                ) : item.description ? (
                  <span className="text-xs text-gray-500">{item.description}</span>
                ) : null}
              </span>
            </button>
          );
        }
        return (
          <button
            key={item.key}
            type="button"
            role="menuitem"
            aria-disabled={disabled ? true : undefined}
            tabIndex={-1}
            data-menu-item=""
            onClick={activate}
            className={cn(
              'flex flex-col gap-0.5 rounded-md py-2 pl-8 pr-2.5 text-left text-sm focus:bg-gray-100 focus:outline-none',
              item.tone === 'danger' ? 'text-danger-700' : 'text-gray-900',
              disabled ? 'cursor-not-allowed opacity-50' : 'hover:bg-gray-100'
            )}
          >
            <span>{item.label}</span>
            {disabled && item.hint ? <span className="text-xs text-gray-500">{item.hint}</span> : null}
          </button>
        );
      })}
    </div>
  );
}
