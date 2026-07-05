import type { Config } from 'tailwindcss';
import preset from '@keepr/design-system/tailwind-preset';

const config: Config = {
  // Design tokens (primary/success/warning/danger palettes) come from the
  // shared preset — see packages/design-system/DESIGN-SYSTEM.md.
  presets: [preset as Config],
  content: [
    './app/**/*.{js,ts,jsx,tsx,mdx}',
    './components/**/*.{js,ts,jsx,tsx,mdx}',
    './lib/**/*.{js,ts,jsx,tsx,mdx}',
    // Design-system primitives (both paths: workspace symlink locally,
    // standalone install on Vercel) so their classes survive purge.
    '../packages/design-system/src/**/*.{js,ts,jsx,tsx}',
    './node_modules/@keepr/design-system/src/**/*.{js,ts,jsx,tsx}',
  ],
  theme: {
    extend: {},
  },
  plugins: [],
};

export default config;
