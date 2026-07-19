import * as React from 'react';
import { cn } from '../lib/cn';

/**
 * Wordmark — the Keepr text wordmark: "Keepr" in the current text color with a
 * trailing gold accent dot (#F5A524), matching the app mark's dot and the
 * landing-page wordmark.
 *
 * Presentational only. Renders a single <span> so it drops into an existing
 * heading (e.g. <h1><Wordmark /></h1>) without changing layout — the caller
 * still controls font size/weight/color of the letters via the parent element
 * or `className`. Only the dot is colored, so the "Keepr" letters keep whatever
 * text color they inherit.
 */

/** The Keepr brand gold, used for the wordmark dot and the app-mark dot. */
export const KEEPR_DOT_COLOR = '#F5A524';

export interface WordmarkProps {
  /** Extra classes for the root <span> (e.g. font size/weight from the caller). */
  className?: string;
}

export function Wordmark({ className }: WordmarkProps) {
  return (
    <span data-testid="wordmark" className={cn(className)}>
      Keepr<span style={{ color: KEEPR_DOT_COLOR }}>.</span>
    </span>
  );
}

export default Wordmark;
