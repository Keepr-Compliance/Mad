/**
 * Keepr @keepr/ui — Tailwind 3 preset (shadcn semantic layer).
 *
 * This preset wires shadcn/ui's CSS-variable conventions (bg-primary,
 * text-primary-foreground, bg-background, border-border, rounded-lg via
 * --radius, etc.) onto the Keepr design tokens. It does NOT redefine the
 * palette — it *extends* it:
 *
 *   1. It re-exports the @keepr/design-system preset, so the numeric token
 *      scales (primary-600, danger-50, success-700, …) remain available.
 *   2. It adds shadcn *semantic* colors that resolve to `hsl(var(--x))`,
 *      where every variable is declared in `src/styles/theme.css` and derived
 *      from the design tokens (colored semantics) or Tailwind's default gray
 *      scale (neutrals). See THEMING in README.md.
 *
 * Because both layers use `theme.extend`, Tailwind deep-merges them: e.g.
 * `primary` ends up with the full 50–950 scale AND `DEFAULT`/`foreground`, so
 * `bg-primary`, `bg-primary-600`, and `text-primary-foreground` all work.
 *
 * Consumers:
 *   presets: [require('@keepr/ui/tailwind-preset')]   // pulls design-system too
 * and must import `@keepr/ui/src/styles/theme.css` once at the app root, plus
 * add `@keepr/ui/src/**` to their `content` globs so the classes survive purge.
 */
module.exports = {
  presets: [require('@keepr/design-system/tailwind-preset')],
  theme: {
    extend: {
      colors: {
        border: 'hsl(var(--border))',
        input: 'hsl(var(--input))',
        ring: 'hsl(var(--ring))',
        background: 'hsl(var(--background))',
        foreground: 'hsl(var(--foreground))',
        primary: {
          DEFAULT: 'hsl(var(--primary))',
          foreground: 'hsl(var(--primary-foreground))',
        },
        secondary: {
          DEFAULT: 'hsl(var(--secondary))',
          foreground: 'hsl(var(--secondary-foreground))',
        },
        destructive: {
          DEFAULT: 'hsl(var(--destructive))',
          foreground: 'hsl(var(--destructive-foreground))',
        },
        success: {
          DEFAULT: 'hsl(var(--success))',
          foreground: 'hsl(var(--success-foreground))',
        },
        warning: {
          DEFAULT: 'hsl(var(--warning))',
          foreground: 'hsl(var(--warning-foreground))',
        },
        muted: {
          DEFAULT: 'hsl(var(--muted))',
          foreground: 'hsl(var(--muted-foreground))',
        },
        accent: {
          DEFAULT: 'hsl(var(--accent))',
          foreground: 'hsl(var(--accent-foreground))',
        },
        popover: {
          DEFAULT: 'hsl(var(--popover))',
          foreground: 'hsl(var(--popover-foreground))',
        },
        card: {
          DEFAULT: 'hsl(var(--card))',
          foreground: 'hsl(var(--card-foreground))',
        },
      },
      borderRadius: {
        lg: 'var(--radius)',
        md: 'calc(var(--radius) - 2px)',
        sm: 'calc(var(--radius) - 4px)',
      },
    },
  },
};
