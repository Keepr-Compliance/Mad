/**
 * AppMark
 *
 * The Keepr app mark ("roofline K"): an indigo squircle tile with a white custom
 * K whose stem tops out in a roof gable (real-estate nod) and a gold accent dot.
 * Presentational only — no window.api, no effects, StrictMode-safe.
 *
 * The mark is inlined as SVG (source: keepr-logo-assets/mark.svg) so it renders
 * identically regardless of the host system font — the K is a custom drawn glyph,
 * never a font character. The linear gradient id is made unique per instance with
 * useId() so multiple marks on one page never collide.
 */

import React, { useId } from "react";

export interface AppMarkProps {
  /** Rendered width/height in pixels (the mark is square). Defaults to 32. */
  size?: number;
  /** Extra classes for the root <svg>. */
  className?: string;
  /** Accessible title. When omitted the mark is decorative (aria-hidden). */
  title?: string;
}

export function AppMark({ size = 32, className, title }: AppMarkProps) {
  // Unique gradient id per instance avoids collisions when several marks render.
  const gradientId = `keepr-appmark-gradient-${useId()}`;

  return (
    <svg
      data-testid="app-mark"
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 512 512"
      width={size}
      height={size}
      className={className}
      role={title ? "img" : undefined}
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
      <g fill="#FFFFFF">
        <path
          d="M190 256 L300 382"
          stroke="#FFFFFF"
          strokeWidth="52"
          strokeLinecap="butt"
          fill="none"
        />
        <path
          d="M190 254 L292 176"
          stroke="#FFFFFF"
          strokeWidth="52"
          strokeLinecap="butt"
          fill="none"
        />
        <path d="M156 178 L182 154 L208 178 L208 382 L156 382 Z" />
      </g>
      <circle cx="352" cy="352" r="19" fill="#F5A524" />
    </svg>
  );
}

export default AppMark;
