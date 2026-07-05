/**
 * Keepr design tokens — Tailwind 3 preset.
 *
 * Single source of truth for the color palette shared by admin-portal and
 * broker-portal. Consume via `presets: [require('@keepr/design-system/tailwind-preset')]`
 * (or an ESM default import) in each portal's tailwind.config.ts.
 *
 * primary = Tailwind sky. success/warning/danger = Tailwind green/amber/red.
 * Hex values live in ./tokens.json so Tailwind classes and the JS `colors`
 * export (src/tokens.ts) can never drift.
 */
module.exports = {
  theme: {
    extend: {
      colors: require('./tokens.json'),
    },
  },
};
