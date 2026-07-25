/**
 * Keepr Companion color palette.
 * Values sourced from Tailwind CSS defaults to match the desktop app styling.
 */

export const colors = {
  // Primary (blue)
  primary: {
    50: '#eff6ff',
    100: '#dbeafe',
    200: '#bfdbfe',
    300: '#93c5fd',
    400: '#60a5fa',
    500: '#3b82f6',
    600: '#2563eb',
    700: '#1d4ed8',
    800: '#1e40af',
    900: '#1e3a8a',
  },

  // Gray (slate)
  gray: {
    50: '#f8fafc',
    100: '#f1f5f9',
    200: '#e2e8f0',
    300: '#cbd5e1',
    400: '#94a3b8',
    500: '#64748b',
    600: '#475569',
    700: '#334155',
    800: '#1e293b',
    900: '#0f172a',
  },

  // Success (green)
  success: {
    50: '#f0fdf4',
    100: '#dcfce7',
    400: '#4ade80',
    500: '#22c55e',
    600: '#16a34a',
    700: '#15803d',
  },

  // Error / Danger (red)
  danger: {
    50: '#fef2f2',
    100: '#fee2e2',
    400: '#f87171',
    500: '#ef4444',
    600: '#dc2626',
    700: '#b91c1c',
  },

  // Warning (amber)
  warning: {
    50: '#fffbeb',
    400: '#fbbf24',
    500: '#f59e0b',
    600: '#d97706',
  },

  // Keepr brand identity — sourced pixel-for-pixel from the live landing site
  // (keeprcompliance.com). Do NOT substitute these values; they are the
  // canonical brand palette (BACKLOG-2245 / BACKLOG-2246).
  brand: {
    /** Wordmark text "Keepr" — landing CSS `.wordmark{color:#101322}` */
    wordmark: '#101322',
    /** Accent dot "." after the wordmark, and the logomark dot */
    dot: '#f5a524',
    /** Logomark background indigo — sampled from icon.png (srgb 87,76,232) */
    indigo: '#574CE8',
  },

  // Login screen palette — matched exactly to the desktop login
  // (src/components/Login.tsx) so the companion reads as the same product.
  // BACKLOG-2253. Do NOT substitute these values.
  login: {
    /** Screen background base under the radial indigo glow */
    background: '#F1F2F8',
    /** Indigo used for the top radial glow, at 10% opacity in CSS */
    glow: 'rgba(79,70,229,0.10)',
    /** Card border */
    cardBorder: '#E7E8F0',
    /** Card / heading ink */
    ink: '#14162B',
    /** Muted label (eyebrow, legal footer) */
    muted: '#9297A6',
    /** Legal link text */
    link: '#6C7180',
    /** Primary button gradient — green-500 → teal-500 (left → right) */
    gradientStart: '#22C55E',
    gradientEnd: '#14B8A6',
    /** Indigo glow behind the brand mark, at 30% opacity */
    markGlow: 'rgba(79,70,229,0.30)',
    /** Card shadow ink (0 12px 34px -12px rgba(20,22,43,0.16)) */
    cardShadow: '#14162B',
    /** Error box — matches desktop red-50 / red-200 / red-800 */
    errorBg: '#FEF2F2',
    errorBorder: '#FECACA',
    errorText: '#991B1B',
  },

  // Base
  white: '#ffffff',
  black: '#000000',
  transparent: 'transparent',
} as const;

export type ColorToken = typeof colors;
