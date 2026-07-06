'use client';

/**
 * TaskSearchBar - PM Backlog
 *
 * Debounced search input that uses the full-text search
 * via the pm_list_items RPC p_search parameter.
 */

import { useState, useEffect } from 'react';

interface TaskSearchBarProps {
  onSearch: (query: string) => void;
  placeholder?: string;
}

function useDebounce(value: string, delay: number): string {
  const [debouncedValue, setDebouncedValue] = useState(value);

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedValue(value), delay);
    return () => clearTimeout(timer);
  }, [value, delay]);

  return debouncedValue;
}

export function TaskSearchBar({
  onSearch,
  placeholder = 'Search backlog items...',
}: TaskSearchBarProps) {
  const [query, setQuery] = useState('');
  const debouncedQuery = useDebounce(query, 300);

  useEffect(() => {
    onSearch(debouncedQuery);
  }, [debouncedQuery, onSearch]);

  return (
    <div className="relative">
      <input
        type="text"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder={placeholder}
        className="w-full border border-gray-300 rounded-md pl-9 pr-8 py-2 text-sm text-gray-900 bg-white focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-primary-500"
      />
      <span className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 text-sm">
        &#x1F50D;
      </span>
      {query && (
        <button
          onClick={() => setQuery('')}
          className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600 text-sm"
        >
          &times;
        </button>
      )}
    </div>
  );
}
