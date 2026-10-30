'use client';

import * as React from 'react';
import { AlertTriangle } from 'lucide-react';
import { cn } from '../../lib/cn';

/**
 * Report kit — StatCard (BACKLOG-3502a). A strict superset of
 * @keepr/design-system's StatCard (every prop it takes is accepted here with
 * the same meaning), plus what the admin report tiles add:
 *
 * - `subtitle` / `footer` under the value;
 * - `tone="critical"`: a warning icon by the label, and the value turns red
 *   ONLY when it is a number above zero — "0 stalled" is good news;
 * - `onClick` + `pressed`: the card becomes a toggle button (`aria-pressed`).
 *   Without `onClick` it is a plain `<div>`, never a button;
 * - `valueProps`: attributes for the value element (e.g. a `data-*` hook);
 * - `data-*` attributes on the card itself (e.g. `data-tile="failed"`).
 */
export type StatCardHue =
  | 'primary'
  | 'blue'
  | 'green'
  | 'yellow'
  | 'red'
  | 'gray'
  | 'indigo'
  | 'orange'
  | 'purple';

const ICON_TILE_CLASSES: Record<StatCardHue, string> = {
  primary: 'text-primary-600 bg-primary-50',
  blue: 'text-blue-600 bg-blue-50',
  green: 'text-green-600 bg-green-50',
  yellow: 'text-yellow-600 bg-yellow-50',
  red: 'text-red-600 bg-red-50',
  gray: 'text-gray-600 bg-gray-50',
  indigo: 'text-indigo-600 bg-indigo-50',
  orange: 'text-orange-600 bg-orange-50',
  purple: 'text-purple-600 bg-purple-50',
};

type DataAttributes = { [key: `data-${string}`]: string | undefined };

/**
 * `data-*` attributes need no declaration: JSX passes hyphenated attributes
 * through unchecked, and the card spreads them onto its root. (An index
 * signature here would stop the design-system props from being assignable.)
 */
export interface StatCardProps {
  label: React.ReactNode;
  value: React.ReactNode;
  /** lucide icon element, typically `<Icon className="h-5 w-5" />`. */
  icon?: React.ReactNode;
  hue?: StatCardHue;
  /** Optional trend chip, e.g. "+12%". */
  trend?: React.ReactNode;
  trendDirection?: 'up' | 'down' | 'neutral';
  className?: string;
  /** Small line under the value. */
  subtitle?: React.ReactNode;
  /** Free content at the bottom of the card. */
  footer?: React.ReactNode;
  tone?: 'default' | 'critical';
  /** Makes the card a toggle button. */
  onClick?: () => void;
  /** With `onClick`: whether the toggle is on. */
  pressed?: boolean;
  valueProps?: React.HTMLAttributes<HTMLParagraphElement> & DataAttributes;
}

export function StatCard({
  label,
  value,
  icon,
  hue = 'primary',
  trend,
  trendDirection = 'neutral',
  className,
  subtitle,
  footer,
  tone = 'default',
  onClick,
  pressed = false,
  valueProps,
  ...rest
}: StatCardProps) {
  const critical = tone === 'critical';
  const alarming = critical && typeof value === 'number' && value > 0;
  const { className: valueClassName, ...valueRest } = valueProps ?? {};

  const classes = cn(
    'rounded-lg border bg-white p-5 text-left',
    icon && 'flex items-center gap-4',
    onClick
      ? cn(
          'cursor-pointer transition',
          pressed ? 'border-primary-500 ring-2 ring-primary-200 bg-primary-50/30' : 'border-gray-200 hover:border-gray-300'
        )
      : 'border-gray-200',
    className
  );

  const body = (
    <>
      {icon ? <div className={cn('rounded-lg p-3', ICON_TILE_CLASSES[hue])}>{icon}</div> : null}
      <div className="min-w-0">
        <p className="flex items-center gap-1.5 text-sm font-medium text-gray-500">
          {critical ? <AlertTriangle className="h-3.5 w-3.5 text-red-600" aria-hidden="true" /> : null}
          <span className="truncate">{label}</span>
        </p>
        <div className="mt-1 flex items-baseline gap-2">
          <p
            {...valueRest}
            data-tone={alarming ? 'critical' : undefined}
            className={cn('text-2xl font-semibold tabular-nums', alarming ? 'text-red-700' : 'text-gray-900', valueClassName)}
          >
            {value}
          </p>
          {trend ? (
            <span
              className={cn(
                'text-xs font-medium',
                trendDirection === 'up' && 'text-green-600',
                trendDirection === 'down' && 'text-red-600',
                trendDirection === 'neutral' && 'text-gray-500'
              )}
            >
              {trend}
            </span>
          ) : null}
        </div>
        {subtitle ? <p className="mt-0.5 text-xs text-gray-500">{subtitle}</p> : null}
        {footer ? <div className="mt-3">{footer}</div> : null}
      </div>
    </>
  );

  if (!onClick) {
    return (
      <div data-slot="stat-card" {...rest} className={classes}>
        {body}
      </div>
    );
  }
  return (
    <button
      type="button"
      data-slot="stat-card"
      {...rest}
      onClick={onClick}
      aria-pressed={pressed ? true : false}
      className={classes}
    >
      {body}
    </button>
  );
}
