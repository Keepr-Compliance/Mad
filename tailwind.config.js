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
