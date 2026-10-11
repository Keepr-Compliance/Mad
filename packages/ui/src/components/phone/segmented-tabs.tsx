'use client';

import * as React from 'react';
import { cn } from '../../lib/cn';

/**
 * Phone kit — segmented tabs.
 *
 * Two modes:
 *  - tab mode (no `href` on items): `role=tablist`, roving tabindex (only the
 *    selected tab is in the Tab order), Arrow/Home/End move selection + focus,
 *    each tab `aria-controls` the panel id the app renders.
 *  - link mode (every item has `href`): route tabs — a `<nav>` of links with
 *    `aria-current="page"` on the selected one, no tab roles. Pass `renderLink`
 *    to use the app router's link component.
 *
 * Consumers: BACKLOG-3898 (support queue), BACKLOG-3899 (ticket conversation),
 * BACKLOG-3900 (projects), BACKLOG-3901 (plans).
 */
export interface SegmentedTabItem {
  value: string;
  label: string;
  count?: number;
  href?: string;
}

export interface SegmentedTabsLinkArgs {
  href: string;
  className: string;
  'aria-current'?: 'page';
  children: React.ReactNode;
}

export interface SegmentedTabsProps {
  items: SegmentedTabItem[];
  value: string;
  onValueChange?: (value: string) => void;
  ariaLabel: string;
  /** Tab mode: id of the tab panel the app renders for the selected tab. */
  panelId?: string;
  /** Link mode: render a router link (defaults to `<a>`). */
  renderLink?: (args: SegmentedTabsLinkArgs) => React.ReactNode;
  className?: string;
}

const ITEM =
  'inline-flex min-h-11 shrink-0 items-center justify-center whitespace-nowrap rounded-md px-3 text-sm font-medium transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-500';
const SELECTED = 'bg-white text-gray-900 shadow-sm';
const IDLE = 'text-gray-600 [@media(hover:hover)]:hover:text-gray-900';

function Label({ item }: { item: SegmentedTabItem }) {
  return (
    <>
      {item.label}
      {typeof item.count === 'number' ? (
        <span className="ml-1.5 rounded-full bg-gray-200 px-1.5 text-xs text-gray-700">{item.count}</span>
      ) : null}
    </>
  );
}

export function SegmentedTabs({
  items,
  value,
  onValueChange,
  ariaLabel,
  panelId,
  renderLink,
  className,
}: SegmentedTabsProps) {
  const baseId = React.useId();
  const tabRefs = React.useRef<Array<HTMLButtonElement | null>>([]);
  const linkMode = items.length > 0 && items.every((i) => typeof i.href === 'string');
  const container = cn(
    'flex gap-1 overflow-x-auto rounded-lg border border-gray-200 bg-gray-50 p-1',
    className
  );

  if (linkMode) {
    const link =
      renderLink ??
      ((args: SegmentedTabsLinkArgs) => (
        <a href={args.href} className={args.className} aria-current={args['aria-current']}>
          {args.children}
        </a>
      ));
    return (
      <nav aria-label={ariaLabel} className={container}>
        {items.map((item) => (
          <React.Fragment key={item.value}>
            {link({
              href: item.href as string,
              className: cn(ITEM, item.value === value ? SELECTED : IDLE),
              'aria-current': item.value === value ? 'page' : undefined,
              children: <Label item={item} />,
            })}
          </React.Fragment>
        ))}
      </nav>
    );
  }

  const selectedIndex = Math.max(
    0,
    items.findIndex((i) => i.value === value)
  );

  const moveTo = (index: number) => {
    const next = items[(index + items.length) % items.length];
    if (!next) return;
    onValueChange?.(next.value);
    tabRefs.current[(index + items.length) % items.length]?.focus();
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLButtonElement>, index: number) => {
    switch (e.key) {
      case 'ArrowRight':
        e.preventDefault();
        moveTo(index + 1);
        break;
      case 'ArrowLeft':
        e.preventDefault();
        moveTo(index - 1);
        break;
      case 'Home':
        e.preventDefault();
        moveTo(0);
        break;
      case 'End':
        e.preventDefault();
        moveTo(items.length - 1);
        break;
      default:
    }
  };

  return (
    <div role="tablist" aria-label={ariaLabel} aria-orientation="horizontal" className={container}>
      {items.map((item, index) => {
        const selected = index === selectedIndex;
        return (
          <button
            key={item.value}
            ref={(el) => {
              tabRefs.current[index] = el;
            }}
            type="button"
            role="tab"
            id={`${baseId}-tab-${item.value}`}
            aria-selected={selected}
            aria-controls={panelId}
            tabIndex={selected ? 0 : -1}
            onClick={() => onValueChange?.(item.value)}
            onKeyDown={(e) => onKeyDown(e, index)}
            className={cn(ITEM, selected ? SELECTED : IDLE)}
          >
            <Label item={item} />
          </button>
        );
      })}
    </div>
  );
}
