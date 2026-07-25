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

  // Login screen palette — matched exactly to the broker-portal login
  // (app.keeprcompliance.com) so the companion reads as the same product.
  // BACKLOG-2253. Do NOT substitute these values.
  login: {
    /** Screen background base under the top indigo glow */
    background: '#F1F2F8',
    /** Indigo used for the top glow, at 10% opacity in CSS */
    glow: 'rgba(79,70,229,0.10)',
    /** Card border, input/OAuth borders, divider line */
    cardBorder: '#E7E8F0',
    /** Card / heading ink, OAuth label */
    ink: '#14162B',
    /** Muted label (eyebrow, divider "or", legal footer) */
    muted: '#9297A6',
    /** Legal link text */
    link: '#6C7180',
    /** Primary submit button — portal primary-600 = the AppMark indigo */
    primary: '#4F46E5',
    /** Input text (house rule: explicit dark text on white) — gray-900 */
    inputText: '#111827',
    /** Indigo glow behind the brand mark, at 30% opacity */
    markGlow: 'rgba(79,70,229,0.30)',
    /** Card shadow ink (0 12px 34px -12px rgba(20,22,43,0.16)) */
    cardShadow: '#14162B',
    /** Error box — matches portal/desktop red-50 / red-200 / red-800 */
    errorBg: '#FEF2F2',
    errorBorder: '#FECACA',
    errorText: '#991B1B',
  },

  // Official OAuth provider brand colors (portal OAuth button icons).
  oauth: {
    /** Google "G" fallback glyph (SVG unavailable → single-color mark) */
    google: '#4285F4',
    /** Microsoft four-square logo */
    msRed: '#F35325',
    msGreen: '#81BC06',
    msBlue: '#05A6F0',
    msYellow: '#FFBA08',
  },

  // Account / avatar palette — matched to the desktop Account screen
  // (BACKLOG-2254). Do NOT substitute these values.
  account: {
    /** Avatar diagonal gradient — blue-400 → purple-500 */
    avatarStart: '#60A5FA',
    avatarEnd: '#A855F7',
    /** Account header bar horizontal gradient — blue-500 → purple-600 */
    headerStart: '#3B82F6',
    headerEnd: '#9333EA',
    /** Primary name text — gray-900 */
    name: '#111827',
    /** Secondary email/label text — gray-600 */
    sub: '#4B5563',
    /** "Signed in with" pill bg / border */
    pillBg: '#F9FAFB',
    pillBorder: '#E5E7EB',
    /** Paired chip — blue-50 / blue-200 / blue-700 */
    chipBg: '#EFF6FF',
    chipBorder: '#BFDBFE',
    chipText: '#1D4ED8',
    /** Hairline row border — gray-100 */
    rowBorder: '#F3F4F6',
    /** Settings button — blue-500 */
    settingsBtn: '#3B82F6',
    /** Sign-out button — red-500 */
    signOutBtn: '#EF4444',
  },

  // Floating support "?" button — matches the desktop SupportWidget
  // (bg blue-500). BACKLOG-2255.
  support: {
    button: '#3B82F6',
  },

  // Base
  white: '#ffffff',
  black: '#000000',
  transparent: 'transparent',
} as const;

export type ColorToken = typeof colors;
