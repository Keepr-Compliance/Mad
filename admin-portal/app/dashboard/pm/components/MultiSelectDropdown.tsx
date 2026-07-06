'use client';

/**
 * MultiSelectDropdown - PM Backlog
 *
 * A custom dropdown with checkboxes for multi-value selection.
 * Replaces native <select> elements to allow filtering by multiple values
 * (e.g., "In Progress" AND "Blocked" statuses at once).
 */

import { useState, useRef, useCallback } from 'react';
import { ChevronDown, X } from 'lucide-react';
import { Checkbox } from '@keepr/design-system';
import { useClickOutside } from '@/hooks/useClickOutside';

export interface MultiSelectOption {
  value: string;
  label: string;
}

interface MultiSelectDropdownProps {
  label: string;
  options: MultiSelectOption[];
  selected: string[];
  onChange: (selected: string[]) => void;
  /** Optional max-width class for the trigger button */
  className?: string;
}

export function MultiSelectDropdown({
  label,
  options,
  selected,
  onChange,
  className = '',
}: MultiSelectDropdownProps) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  // Close on click outside
  const close = useCallback(() => setOpen(false), []);
  useClickOutside(containerRef, close, open);

  function toggleValue(value: string) {
    if (selected.includes(value)) {
      onChange(selected.filter((v) => v !== value));
    } else {
      onChange([...selected, value]);
    }
  }

  function clearAll(e: React.MouseEvent) {
    e.stopPropagation();
    onChange([]);
  }

  const hasSelection = selected.length > 0;
  const triggerLabel = hasSelection ? `${label} (${selected.length})` : label;

  return (
    <div ref={containerRef} className={`relative ${className}`}>
      {/* Trigger button */}
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className={`inline-flex items-center gap-1.5 text-sm border rounded-md px-3 py-1.5 focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-primary-500 ${
          hasSelection
            ? 'border-primary-300 bg-primary-50 text-primary-700'
            : 'border-gray-300 bg-white text-gray-700'
        }`}
      >
        <span className="truncate">{triggerLabel}</span>
        {hasSelection ? (
          <X className="h-3.5 w-3.5 flex-shrink-0" onClick={clearAll} />
        ) : (
          <ChevronDown className="h-3.5 w-3.5 flex-shrink-0" />
        )}
      </button>

      {/* Dropdown panel */}
      {open && (
        <div className="absolute z-50 mt-1 w-56 bg-white border border-gray-200 rounded-lg shadow-lg py-1">
          {/* Clear option at top when selections exist */}
          {hasSelection && (
            <button
              type="button"
              onClick={(e) => {
                clearAll(e);
                setOpen(false);
              }}
              className="w-full text-left px-3 py-1.5 text-sm text-gray-500 hover:bg-gray-50 border-b border-gray-100"
            >
              Clear all
            </button>
          )}
          {/* Options with checkboxes */}
          {options.map((option) => {
            const isChecked = selected.includes(option.value);
            return (
              <label
                key={option.value}
                className="flex items-center gap-2 px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-50 cursor-pointer"
              >
                <Checkbox
                  checked={isChecked}
                  onChange={() => toggleValue(option.value)}
                />
                <span>{option.label}</span>
              </label>
            );
          })}
        </div>
      )}
    </div>
  );
}
