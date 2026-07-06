# Keepr Design System

Shared visual language for the **admin portal** and **broker portal**. The system was
extracted from the admin portal (the design reference) so both apps render the same
professional look: dark `gray-900` sidebar chrome, `gray-50` content canvas, white
bordered cards, sky-blue `primary` accents, lucide icons, and a `text-sm` body scale.

- **Tokens** live in `tailwind-preset.js` (single source of truth for colors).
- **Primitives** live in `src/` (raw TypeScript source, transpiled by each portal's Next build).
- **Chrome** (sidebar/layout) stays per-app because it embeds each app's RBAC and
  navigation logic — but both follow the same recipes documented below.

## Consuming the package

Each portal wires the design system three ways (all three are required — see
"Vercel constraint" below):

```jsonc
// <portal>/package.json
"dependencies": { "@keepr/design-system": "file:../packages/design-system" }
```

```ts
// <portal>/tailwind.config.ts
import preset from '@keepr/design-system/tailwind-preset';
const config: Config = {
  presets: [preset],
  content: [
    './app/**/*.{js,ts,jsx,tsx,mdx}',
    './components/**/*.{js,ts,jsx,tsx,mdx}',
    './lib/**/*.{js,ts,jsx,tsx,mdx}',
    // Both globs so primitive classes survive purge locally (workspace symlink)
    // and on Vercel (standalone install):
    '../packages/design-system/src/**/*.{js,ts,jsx,tsx}',
    './node_modules/@keepr/design-system/src/**/*.{js,ts,jsx,tsx}',
  ],
};
```

```js
// <portal>/next.config.mjs
transpilePackages: ['@keepr/design-system'],
webpack: (config) => {
  // The package ships raw TS source living outside the portal dir; make its
  // bare imports (react, lucide-react) resolve against the portal's own
  // node_modules when webpack has followed the symlink to the real path.
  config.resolve.modules = [...(config.resolve.modules ?? ['node_modules']), path.resolve(__dirname, 'node_modules')];
  return config;
},
```

**Vercel constraint (important):** each portal deploys as a separate Vercel project
whose Root Directory is the portal folder, and `npm install` runs standalone there
(see the committed `admin-portal/package-lock.json` and the historical
"NOT from @keepr/shared per Vercel deploy limitation" comments). Workspace
specifiers (`"*"`) 404 on Vercel; the `file:../packages/design-system` dependency
works only when "Include source files outside of the Root Directory" is enabled in
the Vercel project settings (the default for current projects). After changing a
portal's `package.json`, regenerate `admin-portal/package-lock.json` standalone:
`cd admin-portal && npm install --package-lock-only --ignore-scripts --workspaces=false`.

**lucide-react is a peer dependency** with range `>=0.468.0 <2.0.0` because admin
ships 0.468.0 and broker 1.7.0. Any icon used inside the design system (or shared
recipes) must exist in **both** versions — stick to long-standing icons and avoid
brand icons (removed in 1.x) and 1.x-only additions.

## Tokens

| Token | Scale | Hues |
|---|---|---|
| `primary` | 50–950 | Tailwind **sky** — brand accent for buttons, links, focus rings, active states |
| `success` | 50–800 | Tailwind green |
| `warning` | 50–800 | Tailwind amber |
| `danger` | 50–800 | Tailwind red |

Everything else uses stock Tailwind grays/hues. **Normalize legacy accents:**
`blue-600`/`indigo-600` action colors → `primary-600`; keep semantic hue pills
(status colors) on their stock hues.

Raw hex values for non-Tailwind contexts (inline-styled global-error pages):
`import { colors } from '@keepr/design-system'`.

## Core conventions

- **Type scale**: page title `text-2xl font-bold text-gray-900` + subtitle `mt-1 text-sm text-gray-500`;
  card/dialog title `text-lg font-semibold text-gray-900`; stat value `text-2xl font-semibold text-gray-900`;
  default body/controls `text-sm`; captions/badges `text-xs`.
- **Gray hierarchy**: `gray-900` headings, `gray-700` labels/secondary-button text, `gray-600` prose,
  `gray-500` subtitles/table headers/meta, `gray-400` placeholders/muted icons, `gray-300` empty-state icons,
  `border-gray-300` controls, `border-gray-200` cards/dividers.
- **Radii**: `rounded-md` buttons/inputs/alerts; `rounded-lg` cards/tables/modals/dropdowns; `rounded-full` pills/avatars; bare `rounded` skeletons/micro-chips.
- **Shadows**: `shadow-sm` cards → `shadow-lg` dropdowns → `shadow-xl` modals. Backdrop `bg-black/50` at `fixed inset-0 z-50`.
- **Icons (lucide)**: `h-5 w-5` top-level nav/dialog close/stat tiles; `h-4 w-4` inside buttons/sub-nav/tabs; `h-3.5 w-3.5` in `text-xs` buttons; `h-3 w-3` inline spinners/sort arrows; `h-12 w-12 text-gray-300` empty states.
- **Focus**: buttons `focus:ring-2 focus:ring-primary-500 focus:ring-offset-2`; inputs `focus:ring-1 focus:ring-primary-500 focus:border-primary-500`.
- **Spacing rhythm**: layout provides `p-6 bg-gray-50` (pages do not re-pad); page header `mb-6`; forms `space-y-4`; button groups `gap-3`; grids `gap-4`.
- **Status pill formula**: `bg-{hue}-100 text-{hue}-800`. Semantics: gray=pending/none, blue=in-progress/info, yellow=testing, green=completed/active, red=blocked/critical, orange=deferred/high, purple=reopened/resolved, amber=waiting, indigo=epic.
- **No toast library**: errors render inline via `<Alert>`.
- **Loading**: `<Skeleton>` blocks mirroring final layout; `<Spinner>`/`<LoadingState>` (lucide `Loader2`).

## Primitives

All accept `className` for composition. Import from `@keepr/design-system`.

| Primitive | Use |
|---|---|
| `Button` / `buttonClasses` | `primary` \| `secondary` \| `danger` \| `dangerOutline` \| `success` \| `warning`; sizes `md`/`sm`/`xs`. `buttonClasses()` styles `<Link>`s as buttons. Loading state = swap the label text (no embedded spinners). |
| `Card`, `CardHeader`, `CardTitle`, `CardDescription`, `CardContent`, `CardFooter` | White `rounded-lg shadow-sm border-gray-200` surfaces; `padding` none/sm/md/lg; `hover` for clickable cards. |
| `Badge` / `badgeHueClasses` | Status pills using the hue formula. |
| `Alert` | Inline `error`/`success`/`warning`/`info` boxes. |
| `Label`, `Input`, `Select`, `Textarea`, `Checkbox`, `FieldError`, `FieldHelp`, `SearchInput`, `inputClasses` | Form controls with primary focus rings. |
| `TableContainer`, `Table`, `TableHead`, `TableBody`, `Tr`, `Th`, `Td`, `TableEmptyRow`, `PaginationBar`, `PaginationButton` | The admin table recipe: `bg-gray-50` uppercase headers, `divide-y` rows, `hover:bg-gray-50` clickable rows, gray-50 pagination bars. |
| `Modal`, `ModalBody`, `ModalFooter` | `sm` confirm panel (max-w-md p-6) or `lg` form dialog (max-w-2xl, bordered header). Escape/backdrop dismiss, `dismissible={false}` while submitting. |
| `ConfirmationDialog` | Confirm/cancel dialog; `isDestructive` adds the red `AlertTriangle` treatment. |
| `PageHeader` | h1 + subtitle + right-aligned actions, `mb-6`. |
| `StatCard` | KPI card with colored icon tile (`text-{hue}-600 bg-{hue}-50`). |
| `EmptyState` | Centered icon + title + description (+ action), with or without card chrome. |
| `Skeleton`, `CardSkeleton` | Pulsing placeholders. |
| `Spinner`, `LoadingState` | Loader2-based spinners. |

## Chrome recipes (per-app, copy exactly)

**App shell** (dashboard layout):

```tsx
<div className="flex min-h-screen">
  <Sidebar collapsed={collapsed} onToggle={() => setCollapsed(!collapsed)} />
  <div className="flex-1 flex flex-col min-w-0">
    <main className="flex-1 p-6 bg-gray-50 overflow-auto">{children}</main>
  </div>
</div>
```

**Sidebar** (`aside`): `sticky top-0 h-screen flex flex-col bg-gray-900 text-white transition-all duration-200` +
`w-64` expanded / `w-16` collapsed. Logo row `px-6 py-5 border-b border-gray-800` with wordmark
`text-xl font-bold` ("Keepr.") + qualifier `text-xs font-medium text-gray-400 uppercase tracking-wider`
("Admin"/"Broker Portal") and a `PanelLeftClose`/`PanelLeftOpen` toggle. Nav container
`flex-1 py-4 space-y-1 overflow-y-auto scrollbar-hide px-3` (`px-2` collapsed). Nav item
`flex items-center gap-3 px-3 py-2 rounded-md text-sm font-medium transition-colors`, active
`bg-gray-800 text-white`, idle `text-gray-300 hover:bg-gray-800 hover:text-white`, icons `h-5 w-5 shrink-0`
(sub-items `pl-9` + `h-4 w-4`). User footer `border-t border-gray-800 px-3 py-4` with `h-8 w-8` avatar
(fallback `bg-primary-600` initial circle), name `text-sm text-gray-300 truncate`, role `text-xs text-gray-500`,
and a Sign Out row (lucide `LogOut`).

**Page scaffold**: optional `max-w-7xl mx-auto` (wide) / `max-w-4xl mx-auto` (narrow) wrapper →
`<PageHeader>` → content sections (`space-y-6`).

**Stacking & fixed elements**: the z ladder is `z-30` fixed content bars < `z-40` sidebar <
`z-50` banners/modals/overlays. Anything `position: fixed` anchored to the viewport's left
edge inside the dashboard must offset itself past the sidebar with the shell-provided CSS
variable: `left-[var(--sidebar-w,0px)]` (or `left-[calc(var(--sidebar-w,0px)_+_1.5rem)]`
for floating buttons). The shell sets `--sidebar-w` to the live sidebar width (16rem
expanded / 4rem collapsed), and the `0px` fallback keeps the classes correct outside the
dashboard chrome.

**Login/centered pages**: `min-h-screen flex items-center justify-center bg-gray-50 py-12 px-4 sm:px-6 lg:px-8`
with a `max-w-md w-full space-y-8` column; wordmark h1 `text-3xl font-bold text-gray-900`, portal name
`mt-2 text-xl text-gray-600`. OAuth buttons: `w-full flex items-center justify-center gap-3 px-4 py-3 border
border-gray-300 rounded-lg shadow-sm bg-white text-gray-700 hover:bg-gray-50 focus:ring-2 focus:ring-offset-2
focus:ring-primary-500 disabled:opacity-50 transition-colors` (keep provider brand SVGs verbatim).

## Adoption status & migration

- **broker-portal**: fully adopted (chrome + pages + components).
- **admin-portal**: consumes the token preset; its components already match the recipes
  (they are the source). Migrate admin components to the shared primitives opportunistically —
  when touching a file, replace hand-rolled buttons/cards/badges/tables with the primitives
  and normalize `blue-*` accents to `primary-*`. Do not mass-migrate in unrelated PRs.
- **New UI in either portal**: use the primitives; do not hand-roll new button/card/badge/input styles.
