'use client';

/**
 * InlineAssigneePicker -- Shared inline dropdown for changing item assignee.
 *
 * Used by both TaskTable and KanbanCard. Shows list of assignable users
 * with search filtering.
 *
 * Two usage modes:
 *   1. "itemId" mode: pass itemId, calls assignItem RPC directly
 *   2. "callback" mode: pass onUpdate callback with the selected user ID
 *
 * Two display variants:
 *   - 'avatar' (card style): shows avatar circle + name
 *   - 'text' (table style): shows name text only
 */

import { useState, useEffect, useRef, useCallback } from 'react';
import { Check } from 'lucide-react';
import { assignItem } from '@/lib/pm-queries';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AssignableUser {
  id: string;
  display_name: string | null;
  email: string;
}

interface BaseProps {
  assigneeId: string | null;
  users: AssignableUser[];
  /** 'avatar' shows avatar circle + name (KanbanCard), 'text' shows name only (TaskTable) */
  variant?: 'avatar' | 'text';
  /** For 'text' variant: map of user ID -> display info */
  userMap?: Map<string, { display_name: string | null; email: string }>;
}

interface WithItemIdProps extends BaseProps {
  itemId: string;
  onUpdated: () => void;
}

interface WithCallbackProps extends BaseProps {
  onUpdate: (userId: string | null) => void;
}

type InlineAssigneePickerProps = WithItemIdProps | WithCallbackProps;

function isIdMode(props: InlineAssigneePickerProps): props is WithItemIdProps {
  return 'itemId' in props;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function InlineAssigneePicker(props: InlineAssigneePickerProps) {
  const { assigneeId, users, variant = 'avatar', userMap } = props;
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [error, setError] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  useEffect(() => {
    if (open) {
      requestAnimationFrame(() => {
        searchInputRef.current?.focus();
      });
    } else {
      setSearch('');
      setError(null);
    }
  }, [open]);

  const filteredUsers = search.trim()
    ? users.filter((u) => {
        const term = search.toLowerCase();
        const name = (u.display_name || '').toLowerCase();
        const email = u.email.toLowerCase();
        return name.includes(term) || email.includes(term);
      })
    : users;

  const handleSearchKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      e.stopPropagation();
      if (e.key === 'Escape') {
        setOpen(false);
      }
    },
    [],
  );

  async function handleSelect(userId: string | null) {
    setOpen(false);
    setError(null);
    if (userId === assigneeId) return;
    if (isIdMode(props)) {
      try {
        await assignItem(props.itemId, userId);
        props.onUpdated();
      } catch (err) {
        console.error('Failed to assign user:', err);
        setError('Failed to assign');
      }
    } else {
      props.onUpdate(userId);
    }
  }

  // Resolve display name
  const currentUser = users.find((u) => u.id === assigneeId);
  const displayName = variant === 'text'
    ? (assigneeId && userMap?.has(assigneeId)
        ? (userMap.get(assigneeId)!.display_name || userMap.get(assigneeId)!.email)
        : null)
    : (currentUser
        ? (currentUser.display_name || currentUser.email)
        : null);
  const initials = currentUser
    ? (currentUser.display_name || currentUser.email)
        .split(' ')
        .map((w) => w[0])
        .slice(0, 2)
        .join('')
        .toUpperCase()
    : null;

  // Render trigger button based on variant
  function renderTrigger() {
    if (variant === 'text') {
      return (
        <button
          onClick={(e) => {
            e.preventDefault();
            setOpen(!open);
          }}
          className="text-sm text-left cursor-pointer hover:text-primary-600 transition-colors"
        >
          {displayName ? (
            <span className="text-gray-700">{displayName}</span>
          ) : (
            <span className="text-gray-300">Unassigned</span>
          )}
        </button>
      );
    }
    // avatar variant (KanbanCard style)
    return (
      <button
        onClick={(e) => {
          e.preventDefault();
          setOpen(!open);
        }}
        className="flex items-center gap-1.5 text-xs text-gray-600 hover:text-gray-900 transition-colors"
      >
        {currentUser ? (
          <>
            <div className="w-5 h-5 rounded-full bg-blue-100 flex items-center justify-center flex-shrink-0">
              <span className="text-[10px] text-blue-700 font-medium">
                {initials}
              </span>
            </div>
            <span className="truncate max-w-[80px]">
              {currentUser.display_name || currentUser.email}
            </span>
          </>
        ) : (
          <span className="text-gray-400">Unassigned</span>
        )}
      </button>
    );
  }

  return (
    <div ref={ref} className="relative" onClick={(e) => e.stopPropagation()}>
      {renderTrigger()}
      {error && (
        <span className="absolute top-full left-0 mt-1 text-xs text-red-500 whitespace-nowrap">
          {error}
        </span>
      )}
      {open && (
        <div className="absolute left-0 top-full mt-1 bg-white border rounded-md shadow-lg z-20 w-48">
          {/* Search input */}
          <div className="p-1.5 border-b border-gray-100">
            <input
              ref={searchInputRef}
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              onKeyDown={handleSearchKeyDown}
              onClick={(e) => e.stopPropagation()}
              onMouseDown={(e) => e.stopPropagation()}
              placeholder="Search users..."
              className="w-full px-2 py-1 text-xs text-gray-900 bg-gray-50 border border-gray-200 rounded focus:outline-none focus:border-primary-300 focus:ring-1 focus:ring-primary-300 placeholder-gray-400"
            />
          </div>
          {/* User list */}
          <div className="py-1 max-h-40 overflow-y-auto">
            <button
              onClick={() => handleSelect(null)}
              className={`w-full text-left px-3 py-1.5 text-xs hover:bg-gray-50 ${
                !assigneeId ? 'bg-primary-50 text-primary-700' : 'text-gray-400'
              }`}
            >
              Unassigned
            </button>
            {filteredUsers.map((user) => (
              <button
                key={user.id}
                onClick={() => handleSelect(user.id)}
                className={`w-full text-left px-3 py-1.5 text-xs hover:bg-gray-50 flex items-center justify-between ${
                  user.id === assigneeId ? 'bg-primary-50 text-primary-700' : 'text-gray-700'
                }`}
              >
                <span className="truncate">
                  {user.display_name || user.email}
                </span>
                {user.id === assigneeId && (
                  <Check className="h-3 w-3 text-primary-600 flex-shrink-0" />
                )}
              </button>
            ))}
            {filteredUsers.length === 0 && search.trim() && (
              <p className="px-3 py-1.5 text-xs text-gray-400">No matches</p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
