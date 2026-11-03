// BACKLOG-3863 (SR R5'/R6): the @keepr/ui preset, loaded by RELATIVE path so a
// worktree does not resolve it through node_modules into another checkout.
// The preset itself still does require('@keepr/design-system/tailwind-preset'),
// which Node resolves through node_modules; CI's `npm run build` is the
// authoritative check for that inner require.
import uiPreset from './packages/ui/tailwind-preset.js';

/** @type {import('tailwindcss').Config} */
export default {
  presets: [uiPreset],
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
    // Kit components the renderer imports (@keepr/ui) — keep their classes.
    "./packages/ui/src/**/*.{ts,tsx}",
  ],
  theme: {
    extend: {
      borderRadius: {
        // The preset maps `sm` to calc(var(--radius) - 4px) = 4px. Desktop's
        // rounded-*-sm corners stay Tailwind's 2px, so nothing existing moves.
        sm: '0.125rem',
      },
      // BACKLOG-4110 (dashboard mock v9): desktop-only warm neutrals + ink.
      // Placement A for 2.45; promoted to the kit (tokens.json) in 2.46.
      // `neutral` (Tailwind default) and `muted` (ui preset) are taken.
      colors: {
        warm: {
          page: '#F6F5F2', // dashboard page
          header: '#FAF9F7', // panel header strip, Todo group header, row hover
          chip: '#F1F0EC', // muted icon chip
          divider: '#EEECE7', // row dividers, neutral badge fill
          line: '#E6E4DF', // card / tile / panel / title-bar hairline, ring rail
          control: '#CBC8C1', // checkbox, tile hover border
          dot: '#B5B2AB', // reserved for BACKLOG-4115 "off" dot
        },
        ink: {
          DEFAULT: '#1C2430',
          muted: '#5B6470',
        },
      },
      keyframes: {
        indeterminate: {
          '0%': { transform: 'translateX(-100%)' },
          '100%': { transform: 'translateX(400%)' },
        },
      },
      animation: {
        indeterminate: 'indeterminate 1.5s ease-in-out infinite',
      },
    },
  },
  plugins: [],
}
