import type { Config } from 'tailwindcss';
import preset from '@keepr/ui/tailwind-preset';

const config: Config = {
  // The @keepr/ui preset extends the @keepr/design-system preset (it does
  // `presets: [require('@keepr/design-system/tailwind-preset')]` internally),
  // so consuming it alone gives BOTH the design-system token scales
  // (primary/success/warning/danger) AND the shadcn semantic layer
  // (bg-primary, border-input, rounded-lg via --radius, …). Do not also list
  // the design-system preset here — that would double-include it.
  presets: [preset as Config],
  content: [
    './app/**/*.{js,ts,jsx,tsx,mdx}',
    './components/**/*.{js,ts,jsx,tsx,mdx}',
    './lib/**/*.{js,ts,jsx,tsx,mdx}',
    // Design-system primitives (still consumed directly for the Tier-2
    // components) + the @keepr/ui component source, both paths (workspace
    // symlink locally, standalone install on Vercel) so their classes
    // survive purge.
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
