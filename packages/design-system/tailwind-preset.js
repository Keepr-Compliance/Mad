/**
 * Keepr design tokens — Tailwind 3 preset.
 *
 * Single source of truth for the color palette shared by admin-portal and
 * broker-portal. Consume via `presets: [require('@keepr/design-system/tailwind-preset')]`
 * (or an ESM default import) in each portal's tailwind.config.ts.
 *
 * primary = Tailwind sky. success/warning/danger = Tailwind green/amber/red.
 * The 50-950 primary scale and the 50/500/600 semantic stops are byte-identical
 * to the values both portals shipped before the preset existed; the extra
 * semantic stops (100/200/700/800) enable badge (`bg-success-100 text-success-800`)
 * and hover (`hover:bg-success-700`) recipes without falling back to raw hues.
 */
module.exports = {
  theme: {
    extend: {
      colors: {
        primary: {
          50: '#f0f9ff',
          100: '#e0f2fe',
          200: '#bae6fd',
          300: '#7dd3fc',
          400: '#38bdf8',
          500: '#0ea5e9',
          600: '#0284c7',
          700: '#0369a1',
          800: '#075985',
          900: '#0c4a6e',
          950: '#082f49',
        },
        success: {
          50: '#f0fdf4',
          100: '#dcfce7',
          200: '#bbf7d0',
          500: '#22c55e',
          600: '#16a34a',
          700: '#15803d',
          800: '#166534',
        },
        warning: {
          50: '#fffbeb',
          100: '#fef3c7',
          200: '#fde68a',
          500: '#f59e0b',
          600: '#d97706',
          700: '#b45309',
          800: '#92400e',
        },
        danger: {
          50: '#fef2f2',
          100: '#fee2e2',
          200: '#fecaca',
          500: '#ef4444',
          600: '#dc2626',
          700: '#b91c1c',
          800: '#991b1b',
        },
      },
    },
  },
};
