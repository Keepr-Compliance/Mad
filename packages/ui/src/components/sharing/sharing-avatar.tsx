import * as React from 'react';
import { Users } from 'lucide-react';
import { cn } from '../../lib/cn';

/** "Jordan Lee" -> "JL"; "Priya" -> "PR"; blank -> "?". */
export function initialsOf(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return '?';
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return (words[0][0] + words[words.length - 1][0]).toUpperCase();
}

/** 32px round avatar: initials for a person, a people icon for a role. Decorative. */
export function SharingAvatar({
  kind,
  name,
  tone = 'default',
}: {
  kind: 'person' | 'role';
  name: string;
  tone?: 'default' | 'owner';
}) {
  return (
    <span
      aria-hidden="true"
      data-slot="sharing-avatar"
      className={cn(
        'flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full text-xs font-semibold',
        kind === 'role'
          ? 'bg-primary-100 text-primary-800'
          : tone === 'owner'
            ? 'bg-primary-700 text-white'
            : 'bg-gray-100 text-gray-700'
      )}
    >
      {kind === 'role' ? <Users className="h-4 w-4" /> : initialsOf(name)}
    </span>
  );
}

/** How a principal reads in rows, chips and confirms. */
export function displayName(p: { kind: 'person' | 'role'; name: string }): string {
  return p.kind === 'role' ? `Role: ${p.name}` : p.name;
}

/** Stable key: a role and a person may share an id. */
export function principalKey(p: { kind: 'person' | 'role'; id: string }): string {
  return `${p.kind}:${p.id}`;
}
