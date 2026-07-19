import * as React from 'react';
import { cn } from '../lib/cn';

/**
 * AppMark — the Keepr app mark: an indigo squircle tile with a white "K" and a
 * gold accent dot (matching the "Keepr." wordmark dot).
 *
 * Inlined as SVG (source: keepr-logo mark.svg) so it renders identically without
 * the system font. Presentational only. The linear-gradient id is made unique per
 * instance with useId() so multiple marks on one page never collide.
 */

export interface AppMarkProps {
  /** Rendered width/height in pixels (the mark is square). Defaults to 32. */
  size?: number;
  /** Extra classes for the root <svg>. */
  className?: string;
  /** Accessible title. When omitted the mark is decorative (aria-hidden). */
  title?: string;
}

export function AppMark({ size = 32, className, title }: AppMarkProps) {
  const gradientId = `keepr-appmark-gradient-${React.useId()}`;

  return (
    <svg
      data-testid="app-mark"
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 512 512"
      width={size}
      height={size}
      className={cn(className)}
      role={title ? 'img' : undefined}
      aria-hidden={title ? undefined : true}
    >
      {title ? <title>{title}</title> : null}
      <defs>
        <linearGradient id={gradientId} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#4F46E5" />
          <stop offset="1" stopColor="#6D5DF0" />
        </linearGradient>
      </defs>
      <rect width="512" height="512" rx="116" fill={`url(#${gradientId})`} />
      <text
        x="242"
        y="362"
        textAnchor="middle"
        fontFamily="-apple-system, BlinkMacSystemFont, 'Segoe UI', 'Helvetica Neue', Inter, system-ui, sans-serif"
        fontWeight="800"
        fontSize="296"
        fill="#FFFFFF"
      >
        K<tspan fill="#F5A524">.</tspan>
      </text>
    </svg>
  );
}
