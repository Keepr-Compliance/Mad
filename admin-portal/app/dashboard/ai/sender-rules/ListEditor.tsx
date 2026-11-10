'use client';

/**
 * One rule list (BACKLOG-4186): the items as chips, and for the owner an input that adds typed or
 * pasted items (validated with the server's predicates, lib/sender-rules/edit.ts) and an x per item.
 */

import { useState } from 'react';
import { X } from 'lucide-react';
import { Button, Input } from '@keepr/ui';
import { InfoTip } from './InfoTip';

export interface ListEditorProps {
  id: string;
  label: string;
  items: string[];
  cap: number;
  readOnly: boolean;
  /** Typed text -> the new items, or why some were refused. */
  onAdd?: (input: string) => string | null;
  onRemove?: (index: number) => void;
  /** Text for each item (sender names show their match). */
  format?: (item: string, index: number) => string;
  placeholder?: string;
  /** Extra control next to the input (the sender-name match). */
  extra?: React.ReactNode;
  /** The (i) tip next to the list's title. */
  tip?: string;
}

export function ListEditor({ id, label, items, cap, readOnly, onAdd, onRemove, format, placeholder, extra, tip }: ListEditorProps) {
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);

  const add = () => {
    if (!onAdd) return;
    const err = onAdd(text);
    setError(err);
    if (err === null) setText('');
  };

  return (
    <div className="space-y-2" data-testid={`list-${id}`}>
      <div className="flex items-baseline justify-between gap-2">
        <div className="flex items-center gap-1.5">
          <h4 className="text-sm font-medium text-gray-900">{label}</h4>
          {tip && <InfoTip label={label} text={tip} />}
        </div>
        <span className="text-xs text-gray-500">
          {items.length} / {cap}
        </span>
      </div>
      {items.length === 0 ? (
        <p className="text-sm text-gray-500">None.</p>
      ) : (
        <ul className="flex flex-wrap gap-1.5">
          {items.map((item, i) => (
            <li
              key={item + ':' + i}
              className="inline-flex items-center gap-1 rounded-md border border-gray-200 bg-gray-50 px-2 py-0.5 text-xs text-gray-800"
            >
              <span>{format ? format(item, i) : item}</span>
              {!readOnly && onRemove && (
                <button
                  type="button"
                  onClick={() => onRemove(i)}
                  aria-label={`Remove ${format ? format(item, i) : item}`}
                  className="rounded text-gray-400 hover:text-gray-700"
                >
                  <X className="h-3 w-3" />
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      {!readOnly && onAdd && (
        <div className="space-y-1">
          <div className="flex gap-2">
            <Input
              aria-label={`Add to ${label}`}
              value={text}
              placeholder={placeholder}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  add();
                }
              }}
              onPaste={(e) => {
                const pasted = e.clipboardData.getData('text');
                if (/[\n,]/.test(pasted) && onAdd) {
                  e.preventDefault();
                  const err = onAdd(pasted);
                  setError(err);
                }
              }}
              className="h-8"
            />
            {extra}
            <Button type="button" variant="secondary" size="sm" onClick={add}>
              Add
            </Button>
          </div>
          {error && (
            <p className="text-xs text-red-600" role="alert">
              {error}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
