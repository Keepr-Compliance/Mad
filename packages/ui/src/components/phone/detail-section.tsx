'use client';

import * as React from 'react';
import { ChevronRight } from 'lucide-react';
import { cn } from '../../lib/cn';

/**
 * Phone kit — grouped label/value rows (detail screens).
 * A row is a button when `onClick` is set, a link when `href` is set, plain
 * text otherwise. Tappable rows are 48px tall and show a chevron.
 *
 * Consumers: BACKLOG-3899 (ticket conversation), BACKLOG-3900 (projects),
 * BACKLOG-3902 (broker users).
 */
export interface DetailSectionProps {
  title?: string;
  children: React.ReactNode;
  className?: string;
}

export function DetailSection({ title, children, className }: DetailSectionProps) {
  const headingId = React.useId();
  return (
    <section aria-labelledby={title ? headingId : undefined} className={cn('space-y-2', className)}>
      {title ? (
        <h3 id={headingId} className="px-1 text-xs font-medium uppercase tracking-wider text-gray-500">
          {title}
        </h3>
      ) : null}
      <div className="divide-y divide-gray-200 overflow-hidden rounded-lg border border-gray-200 bg-white">
        {children}
      </div>
    </section>
  );
}

export interface DetailRowLinkArgs {
  href: string;
  className: string;
  children: React.ReactNode;
}

export interface DetailRowProps {
  label: React.ReactNode;
  value?: React.ReactNode;
  onClick?: () => void;
  href?: string;
  renderLink?: (args: DetailRowLinkArgs) => React.ReactNode;
  /** Show the chevron on tappable rows (default true). */
  chevron?: boolean;
  className?: string;
}

export function DetailRow({
  label,
  value,
  onClick,
  href,
  renderLink,
  chevron = true,
  className,
}: DetailRowProps) {
  const tappable = Boolean(onClick || href);
  const cls = cn(
    'flex w-full items-center gap-3 px-4 text-left text-sm',
    tappable
      ? 'min-h-12 focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary-500 [@media(hover:hover)]:hover:bg-gray-50'
      : 'min-h-11 py-2',
    className
  );
  const body = (
    <>
      <span className="shrink-0 text-gray-500">{label}</span>
      <span className="ml-auto min-w-0 truncate text-right text-gray-900">{value}</span>
      {tappable && chevron ? <ChevronRight className="h-4 w-4 shrink-0 text-gray-400" aria-hidden="true" /> : null}
    </>
  );
  if (href) {
    if (renderLink) return <>{renderLink({ href, className: cls, children: body })}</>;
    return (
      <a href={href} className={cls}>
        {body}
      </a>
    );
  }
  if (onClick) {
    return (
      <button type="button" onClick={onClick} className={cls}>
        {body}
      </button>
    );
  }
  return <div className={cls}>{body}</div>;
}
