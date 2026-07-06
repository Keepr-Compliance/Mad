# @keepr/ui

Keepr's shared **component library** — [shadcn/ui](https://ui.shadcn.com)-style
component source built on [Radix](https://www.radix-ui.com) primitives, themed
entirely by the [`@keepr/design-system`](../design-system/DESIGN-SYSTEM.md)
tokens.

This is **wave A** (BACKLOG-1750, epic BACKLOG-1747): it *seeds* the package.
No app consumes it yet — adoption is wave B.

## Why this exists (and how it relates to @keepr/design-system)

| Package | Role |
|---|---|
| `@keepr/design-system` | **Tokens** (`tokens.json`, Tailwind preset) + a set of dependency-free React primitives styled with token utility classes. The source of truth for the palette and visual recipes. |
| `@keepr/ui` (this) | **Behavioral component library**: shadcn-generated source where **Radix supplies accessibility** (focus trap, keyboard nav, ARIA roles, pointer semantics) and **styling flows from the design-system tokens** via a CSS-variable theming layer. |

The two are complementary: `@keepr/ui` components are restyled shadcn source
whose colors/radii come from the same tokens the design system defines, so they
render the same professional look while adding real a11y behavior for the
interactive pieces (dialogs, selects, checkboxes).

## The copy-in vs import policy (founder decision, BACKLOG-1747)

shadcn's default model is *copy-in* (you paste component source into each app).
Keepr instead uses the **shared-package / imported-component model** (the
Atlassian-style decision on 1747): the source lives here **once**, and apps
**import** it:

```tsx
import { Button, ConfirmationDialog } from '@keepr/ui';
```

We own the code (it's real source in `src/`, not a black-box dependency — edit
it freely), but there is a **single copy**. Do not paste these components into
app trees.

## Consuming the package (wave B)

Three wiring steps, mirroring `@keepr/design-system`:

```jsonc
// <app>/package.json
"dependencies": { "@keepr/ui": "file:../packages/ui" }
```

```ts
// <app>/tailwind.config.ts
import preset from '@keepr/ui/tailwind-preset';   // pulls in the design-system preset too
const config: Config = {
  presets: [preset],
  content: [
    './app/**/*.{js,ts,jsx,tsx,mdx}',
    './components/**/*.{js,ts,jsx,tsx,mdx}',
    // Both globs so @keepr/ui classes survive purge locally (symlink) and on
    // Vercel (standalone install):
    '../packages/ui/src/**/*.{js,ts,jsx,tsx}',
    './node_modules/@keepr/ui/src/**/*.{js,ts,jsx,tsx}',
  ],
};
```

```ts
// <app>/app/layout.tsx  (or the app root, ONCE)
import '@keepr/ui/src/styles/theme.css';   // declares the shadcn CSS variables
```

`react`, `react-dom`, and `lucide-react` are **peer dependencies** (lucide range
`>=0.468.0 <2.0.0`, matching the design system — icons must exist in both admin's
0.468 and broker's 1.7). Radix, `class-variance-authority`, `clsx`, and
`tailwind-merge` are bundled dependencies.

## Theming contract

Components never hardcode hex palette values. They reference **semantic Tailwind
classes** that `tailwind-preset.js` maps onto CSS variables declared in
`src/styles/theme.css`:

- `bg-primary`, `text-primary-foreground`, `bg-destructive`, `ring-ring`,
  `bg-background`, `text-foreground`, `border-input`, `bg-muted`, … →
  `hsl(var(--…))`.
- `rounded-lg / rounded-md / rounded-sm` → derived from `--radius`.
- The numeric token scales (`bg-primary-600`, `bg-danger-50`, …) remain
  available too, inherited from the design-system preset — the inline alert
  (`AlertBanner`) uses these scales directly to match the design system exactly.

**Where the values come from (source of truth = `tokens.json`):**

| CSS variable group | Source | Drift-free? |
|---|---|---|
| `--primary`, `--ring`, `--destructive`, `--success`, `--warning` (+ foregrounds) | HSL of the matching Keepr token (`primary-600`, `primary-500`, `danger-600`, `success-600`, `warning-600`) | Yes — by construction |
| `--background`, `--foreground`, `--card`, `--popover`, `--muted`, `--accent`, `--secondary`, `--border`, `--input` | Tailwind's default **gray** scale (`tokens.json` defines no grays), matching the design-system gray recipes | N/A — grays aren't tokenized |

HSL triplets (no `hsl()` wrapper) are used so Tailwind opacity modifiers work,
e.g. `hover:bg-primary/90` → `hsl(var(--primary) / 0.9)`.

## Component inventory (Tier 1 seed)

| Component | Built on | Notes / API vs @keepr/design-system |
|---|---|---|
| `Button` (`buttonVariants`) | Radix `Slot` + cva | variants `primary` / `secondary` / `destructive` / `ghost` (+ `outline`, `link`); sizes `sm` / `md` / `lg` (+ `icon`); `isLoading` (Loader2 + disabled + `aria-busy`); `asChild`. **`secondary` = the design-system white/bordered secondary (visually shadcn `outline`)**, not shadcn's gray fill. |
| `Card` family | div | `Card` / `Header` / `Title` / `Description` / `Content` / `Footer`. shadcn structure (padding on sub-parts) vs design-system's bordered header + `action` slot. |
| `EmptyState` | div | Same API as design-system (`title` / `description` / `icon` / `action` / `card`). |
| `Skeleton` | div | `animate-pulse rounded-md bg-muted`. |
| `AlertBanner` (+ `Title` / `Description`) | div | shadcn `Alert`, renamed to avoid clashing with `AlertDialog`. variants `info` / `success` / `warning` / `destructive` using token scales. |
| `ConfirmationDialog` | Radix `AlertDialog` | Drop-in for design-system's `ConfirmationDialog` (same props: `open`, `title`, `description`, `confirm/cancelLabel`, `onConfirm`, `onCancel`, `isDestructive`, `loading`). Full ARIA (`role="alertdialog"`, focus trap, labelled title+description). |
| `Dialog` set | Radix `Dialog` | `Dialog` / `Trigger` / `Content` / `Header` / `Footer` / `Title` / `Description` / `Close` / `Overlay`. |
| `AlertDialog` set | Radix `AlertDialog` | Low-level primitives behind `ConfirmationDialog`. |
| `Label` | Radix `Label` | Clicking focuses the control. |
| `Input`, `Textarea` | native | Keepr control recipe (border-input, primary focus ring). |
| `Checkbox` | Radix `Checkbox` | `role="checkbox"`, keyboard + `aria-checked`, indeterminate. |
| `Select` set | Radix `Select` | `Trigger` (`role="combobox"`) / `Content` / `Item` / `Value` / `Group` / `Label` / `Separator`. |

### Not yet at parity with @keepr/design-system

The design system also ships `Badge`, `Table`, `Modal`, `PageHeader`, `StatCard`,
`Spinner`, `SearchInput`, and Button variants `dangerOutline` / `success` /
`warning`. Those are out of scope for the Tier-1 seed; add in later waves.

## Testing

Tests run in an **isolated** jest project (jsdom + ts-jest + Radix polyfills),
separate from the root electron/app suite:

```bash
npm test -w @keepr/ui
# or
npx jest --config packages/ui/jest.config.js
```

`src/**/*.test.tsx` covers Button, Card, EmptyState, ConfirmationDialog (render /
variants / a11y roles / interaction), the theming contract, and a minimal
closed-trigger Select test (Radix Select's open flow is verified by real-browser
QA, not jsdom).

## Local quality gates

```bash
npm run type-check -w @keepr/ui   # tsc --noEmit (own tsconfig)
npm run lint -w @keepr/ui         # eslint with the leaf-boundary guard
npm test -w @keepr/ui             # jest
```
