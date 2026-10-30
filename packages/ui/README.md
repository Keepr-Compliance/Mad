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
    // @keepr/ui classes survive purge. Local and Vercel builds both install
    // from the repo root, so ../packages is the source; the node_modules glob
    // is a second path to the same files:
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
| `Dropdown` (+ `DropdownOptions`, `filterDropdownOptions`) | inline popover (no Radix) | Single choice, searchable, option description, disabled + hint, invalid + error. See **Dropdown** below. |

## Report kit (BACKLOG-3502a)

Desktop report pieces in `src/components/report/`, exported from the package
root. Each is a copy of behaviour an admin report already ships, with a test
for the way it is most likely to be built wrong. No `next/*` imports:
navigation arrives as callbacks.

| Export | What it is |
|---|---|
| `SortableTh` | `<th scope="col">` with `aria-sort` (`ascending` / `descending` / `none`) and a button. |
| `useSortState`, `nextSort` | Same column flips; a new column opens at `defaultDirectionFor(key)`. |
| `useClickOutside` | `mousedown` outside a ref, only while `enabled`. |
| `MultiSelect`, `MultiSelectOptions` | Desktop trigger ("Label" / "Label (n)") + popover; a sibling "Clear <Label> filter" button. `MultiSelectOptions` is the one list (optional Select all / Clear all rows via `bulkActions`, optional `count` per option), purely controlled. |
| `FilterBar`, `FilterCaption` | Filter row shell (Clear shown only while filtered); the "<lead>: <period> · <filters>" caption. |
| `PeriodPicker` | Period select; From / To only for `customKey`; dates commit when complete or on blur. |
| `StatCard` | Superset of the design-system `StatCard`: `subtitle`, `footer`, `tone="critical"` (red only for a number above 0), `onClick` + `pressed` toggle, `valueProps`, `purple` hue. |
| `ShowMoreFooter` | "Showing n of N …" + "Show k more" (k = min(step, remaining)) + "Show all". |
| `TruncationNotice` | The row-cap notice: names the cap, the period, and "a floor, not a total". |
| `useReportUrlState`, `readFirst`, `readList`, `readSort`, `writeSort`, `writeParam`, `buildParamUrl` | State mirrored to the query string with `history.replaceState` (never `pushState`); helpers that keep params they do not own. |

**Phone multi-select recipe.** `FilterSelectButton` (value "n selected") opens
a `BottomSheet` holding `<MultiSelectOptions bulkActions={false} />`. The sheet
header (`headerAction`) carries "Select all" / "Clear" text buttons
(`min-h-11 px-2 text-sm font-semibold text-primary-700`); the parent holds a
*pending* selection and the footer button (`primaryAction`) applies it. Pass
the button's ref as the sheet's `returnFocusRef` (`FilterSelectButton` forwards
it) so focus goes back to it on close. The recipe is exercised in
`report/multi-select.test.tsx`.

### Not yet at parity with @keepr/design-system

The design system also ships `Badge`, `Table`, `Modal`, `PageHeader`,
`Spinner`, `SearchInput`, and Button variants `dangerOutline` / `success` /
`warning`. Those are out of scope for the Tier-1 seed; add in later waves.

## Dropdown (BACKLOG-4032)

Searchable single-choice picker. Built on an inline popover (a `relative`
wrapper and an `absolute z-50` panel), so it adds no dependency and needs no
jsdom polyfills.

```tsx
<Dropdown
  label="Role"                    // or ariaLabel="Role" when there is no visible label
  options={[{ value: 'admin', label: 'Admin', description: 'Manages users and billing' },
            { value: 'owner', label: 'Owner', disabled: true, hint: 'Only one owner' }]}
  value={role}                    // string | null, fully controlled
  onChange={setRole}
  placeholder="Select a role"
  searchPlaceholder="Search roles" // default search name: "Search <label>"
  invalid={!!err} error={err}
/>
```

- **Trigger label** is looked up in the full `options`, so a search that hides
  the selected row never blanks the trigger. The filter does not pin the
  selected row.
- **Keys** (in the search field, or the listbox when `searchable={false}`):
  ArrowDown/ArrowUp next/previous enabled row (no wrap), Home/End first/last
  enabled row, Enter picks, Tab closes. On the closed trigger ArrowDown,
  ArrowUp, Enter and Space open it. Disabled rows are skipped by the arrow
  keys; their `hint` is shown and is their accessible description.
- **Escape** is caught by a window keydown listener in capture phase while the
  panel is open, so inside a kit `Dialog` / `AlertDialog` / `BottomSheet` /
  `Drawer` it closes the dropdown, not the dialog. First Escape clears a
  non-empty search; the next closes. Escape never changes the value.
- **Focus**: picking (Enter or click) and Escape return focus to the trigger. A
  click outside closes without moving focus.

### Dropdown vs Select

`Select` (Radix) is for a short, static list with no search. `Dropdown` is for
a list that needs search or richer rows (description, disabled with a reason).

### Clipping (no portal)

The panel is not portalled, so an ancestor with `overflow: hidden` clips it:

- `@keepr/design-system` `Table` is `overflow-hidden` unless `scrollX`. A
  Dropdown inside a table cell is clipped. Do not use it there until a portal
  variant exists.
- `@keepr/design-system` `Modal` is `max-h-[90vh] overflow-y-auto`: the panel
  scrolls inside the modal rather than overflowing it.
- A kit `Dialog` (`DialogContent`) sets no overflow, so it does not clip the
  panel. The Dialog is fixed and centered and the page cannot scroll while it
  is open, so the panel measures the trigger on open and opens **upward**
  (`data-side="top"`) when there is less than 300px below it and more room
  above (`dropdownSide`, BACKLOG-4007 People popups). Inside a Dialog, put a
  scrolling list in its own `max-h` + `overflow-y-auto` box and keep the
  Dropdown outside it.
- The portal page shells (broker `DashboardShell`, admin dashboard layout) wrap
  pages in `overflow-auto` `main`. That scrolls, it does not clip: a tall panel
  near the bottom extends the page and the active row is scrolled into view.

### Phone

**Field (forms): `presentation="sheet"`.** The same field trigger opens a
`BottomSheet` titled by the label instead of the popover. Rows are comfortable
(`min-h-12 text-base`, descriptions `text-sm`), the search sits above them, a
pick (tap or Enter) commits and closes, and there is no footer. The component
does no `matchMedia`; the parent chooses:

```tsx
const narrow = useMediaQuery('(max-width: 767px)'); // the portal's own hook
<Dropdown label="Role" presentation={narrow ? 'sheet' : 'popover'} ... />
```

`OrgPeoplePanel` passes it through as `pickerPresentation` (broker
`PeopleCard` sets it from that query). Commit-on-pick is single mode only.

**Filter bar: a recipe, not a component.** `FilterSelectButton` (value = the
picked label) + `BottomSheet` + `<DropdownOptions size="comfortable" autoFocus />`,
where `onSelect` sets the value and closes:

```tsx
const ref = React.useRef<HTMLButtonElement>(null);
<FilterSelectButton ref={ref} label="Role" value={label} expanded={open} onClick={() => setOpen(true)} />
<BottomSheet open={open} onOpenChange={setOpen} title="Role" returnFocusRef={ref}>
  <DropdownOptions options={options} value={value} ariaLabel="Role" size="comfortable" autoFocus
    onSelect={(v) => { setValue(v); setOpen(false); }} />
</BottomSheet>
```

Exercised in `dropdown/dropdown-sheet.test.tsx`. `FilterSelectButton` stays
the phone filter trigger (two lines, sized for the `PhoneFilterBar` grid).

Focus and keys in a sheet:
- Open: the search field (or the listbox when not searchable) has focus; it is
  marked `data-autofocus`, which `BottomSheet` honours even inside a `Dialog`.
- Close: focus returns to the trigger (`returnFocusRef`). Pass it in the
  recipe; a tapped button on iOS may not hold focus, so the sheet's fallback
  (the element focused at open) is not enough there.
- Escape: one press closes the sheet, even with search text (Radix closes only
  the top layer, so an enclosing `Dialog` stays open). The desktop popover
  keeps its two-stage Escape.

### Reserved for later modes (typed now, not rendered)

So later varieties are additive, these are already in the types and do nothing
in slice 1: `mode` (`'single'` today; `'multi'` joins the `DropdownProps`
union), `variant` (`'field'` today; `'filter'` later), `onClear`, option
`leading` / `count` / `group`, and an internal `header` row kind that the
keyboard already skips. Value types are generic (`Dropdown<V extends string>`).

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
