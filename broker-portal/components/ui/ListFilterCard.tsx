'use client';

/**
 * Desktop search + filters card shared by Users Management and Submissions
 * (BACKLOG-3904): one Card holding a search box and native selects. Below
 * sm the controls stack; from sm up they sit in one row. Pages hide it below
 * md and show their phone filter bar instead.
 */

import type { ChangeEvent } from 'react';
import { Card, SearchInput, Select } from '@keepr/design-system';

export interface ListFilterOption {
  value: string;
  label: string;
}

export interface ListFilterSelect {
  id: string;
  /** Screen-reader label (the control shows no visible label). */
  label: string;
  value: string;
  onChange: (_value: string) => void;
  options: ListFilterOption[];
}

export interface ListFilterCardProps {
  search: {
    id: string;
    label: string;
    placeholder: string;
    value: string;
    onChange: (_value: string) => void;
    /** Called on Enter in the search box. */
    onSubmit?: () => void;
  };
  filters: ListFilterSelect[];
}

export default function ListFilterCard({ search, filters }: ListFilterCardProps) {
  return (
    <Card padding="sm">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center">
        {/* Search Input */}
        <div className="flex-1">
          <label htmlFor={search.id} className="sr-only">
            {search.label}
          </label>
          <SearchInput
            className="!text-base md:!text-sm"
            id={search.id}
            type="text"
            placeholder={search.placeholder}
            value={search.value}
            onChange={(e: ChangeEvent<HTMLInputElement>) => search.onChange(e.target.value)}
            onKeyDown={
              search.onSubmit
                ? (e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      search.onSubmit?.();
                    }
                  }
                : undefined
            }
          />
        </div>

        {filters.map((f) => (
          <div key={f.id} className="sm:w-40">
            <label htmlFor={f.id} className="sr-only">
              {f.label}
            </label>
            <Select
              className="!text-base md:!text-sm"
              id={f.id}
              value={f.value}
              onChange={(e) => f.onChange(e.target.value)}
            >
              {f.options.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </Select>
          </div>
        ))}
      </div>
    </Card>
  );
}
