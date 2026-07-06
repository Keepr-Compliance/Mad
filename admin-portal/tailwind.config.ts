import type { Config } from 'tailwindcss';
import preset from '@keepr/ui/tailwind-preset';

const config: Config = {
  // Design tokens (primary/success/warning/danger palettes) AND the shadcn
  // semantic layer (bg-primary, border-input, --radius…) come from the @keepr/ui
  // preset, which itself re-exports the @keepr/design-system preset — so the
  // numeric token scales stay available and there is NO double-inclusion (the
  // design-system preset is pulled in exactly once, via @keepr/ui).
  // See packages/ui/tailwind-preset.js and packages/ui/README.md.
  presets: [preset as Config],
  content: [
    './app/**/*.{js,ts,jsx,tsx,mdx}',
    './components/**/*.{js,ts,jsx,tsx,mdx}',
    './lib/**/*.{js,ts,jsx,tsx,mdx}',
    // Shared package primitives (both paths: workspace symlink locally,
    // standalone install on Vercel) so their classes survive purge.
    '../packages/design-system/src/**/*.{js,ts,jsx,tsx}',
    './node_modules/@keepr/design-system/src/**/*.{js,ts,jsx,tsx}',
    '../packages/ui/src/**/*.{js,ts,jsx,tsx}',
    './node_modules/@keepr/ui/src/**/*.{js,ts,jsx,tsx}',
  ],
  theme: {
    extend: {},
  },
  plugins: [],
};

export default config;
