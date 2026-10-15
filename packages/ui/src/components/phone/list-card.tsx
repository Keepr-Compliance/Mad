'use client';

import * as React from 'react';
import { cn } from '../../lib/cn';

/**
 * Phone kit — list card (one row of a phone list: ticket, project, plan).
 * The whole card is ONE tap target: a link when `href` is set, a button when
 * `onClick` is set. `meta` / `secondary` must be non-interactive (pills, text) —
 * nesting links inside a link breaks the tap target and screen readers.
 * The card's accessible name is its title.
 *
 * Consumers: BACKLOG-3898 (support queue), BACKLOG-3900 (projects),
 * BACKLOG-3901 (plans).
 */
export interface ListCardLinkArgs {
  href: string;
  className: string;
  'aria-labelledby': string;
  children: React.ReactNode;
}

export interface ListCardProps {
  href?: string;
  onClick?: () => void;
  renderLink?: (args: ListCardLinkArgs) => React.ReactNode;
  /** Top line: id, pills, timestamps. Non-interactive. */
  meta?: React.ReactNode;
  title: React.ReactNode;
  secondary?: React.ReactNode;
  /** Decorative left stripe colour class, e.g. `bg-primary-500`. */
  accent?: string;
  className?: string;
}

export function ListCard({
  href,
  onClick,
  renderLink,
  meta,
  title,
  secondary,
  accent,
  className,
}: ListCardProps) {
  const titleId = React.useId();
  const body = (
    <>
      {accent ? (
        <span aria-hidden="true" className={cn('absolute inset-y-0 left-0 w-1 rounded-l-lg', accent)} />
      ) : null}
      {meta ? <div className="flex flex-wrap items-center gap-1.5 text-xs text-gray-500">{meta}</div> : null}
      <div id={titleId} className="line-clamp-2 text-sm font-medium text-gray-900">
        {title}
      </div>
      {secondary ? <div className="text-xs text-gray-500">{secondary}</div> : null}
    </>
  );
  const cls = cn(
    'relative flex min-h-11 w-full flex-col gap-1 rounded-lg border border-gray-200 bg-white px-4 py-3 text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-500',
    (href || onClick) && '[@media(hover:hover)]:hover:bg-gray-50',
    className
  );

  if (href) {
    if (renderLink) return <>{renderLink({ href, className: cls, 'aria-labelledby': titleId, children: body })}</>;
    return (
      <a href={href} className={cls} aria-labelledby={titleId} data-slot="list-card">
        {body}
      </a>
    );
  }
  if (onClick) {
    return (
      <button type="button" onClick={onClick} className={cls} aria-labelledby={titleId} data-slot="list-card">
        {body}
      </button>
    );
  }
  return (
    <div className={cls} data-slot="list-card">
      {body}
    </div>
  );
}
