import tokens from '../tokens.json';

/**
 * Raw hex values for the design tokens, for contexts where Tailwind classes
 * are unavailable (e.g. global-error pages that render before CSS loads,
 * emails, canvas drawing). Sourced from ../tokens.json — the same file the
 * Tailwind preset consumes — so the two can never drift.
 */
export const colors = tokens;

/** Font stack used by both portals (Inter via next/font/google, with fallback). */
export const fontFamily = "Inter, system-ui, sans-serif";
