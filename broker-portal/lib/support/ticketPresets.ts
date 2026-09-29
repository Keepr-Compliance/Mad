/**
 * Support ticket presets — BACKLOG-3080.
 *
 * A link can ask the dashboard's New Ticket page to open pre-filled, by naming
 * a preset KEY: `/dashboard/support/new?preset=my-transactions-upgrade`. The
 * key selects one of the fixed entries below. Nothing else in the URL is ever
 * read: no subject, description or category comes from a query parameter, so
 * a link can only choose among texts written here. The user sees and can edit
 * every field before submitting, through the existing ticket form.
 *
 * Categories are named by SLUG (support_categories.slug is UNIQUE) and mapped
 * to ids from the categories the form already loads. A slug that is missing
 * or inactive leaves the select blank; the text fields are still filled.
 *
 * Pure and client-safe: no imports.
 */

export interface TicketPreset {
  categorySlug: string;
  subcategorySlug: string;
  subject: string;
  description: string;
}

export const MY_TRANSACTIONS_UPGRADE_PRESET = 'my-transactions-upgrade';

/**
 * The presets. Wording of the My Transactions entry is the build default,
 * pending the founder's confirmation — change it here only.
 */
export const TICKET_PRESETS: Readonly<Record<string, TicketPreset>> = Object.freeze({
  [MY_TRANSACTIONS_UPGRADE_PRESET]: Object.freeze({
    categorySlug: 'billing-subscription',
    subcategorySlug: 'plan-seat-change',
    subject: 'Upgrade request: My Transactions',
    description:
      "I'd like my brokerage's plan to include My Transactions so I can view my submitted transactions on the web.",
  }),
});

/** The link the My Transactions upsell sends an agent to. */
export const MY_TRANSACTIONS_UPGRADE_HREF = `/dashboard/support/new?preset=${MY_TRANSACTIONS_UPGRADE_PRESET}`;

/**
 * The preset a request names, or null.
 *
 * Only a single string `preset` that is an OWN key of TICKET_PRESETS counts;
 * `__proto__`, `constructor`, arrays and unknown keys are null. No other
 * parameter is read.
 */
export function resolveTicketPreset(
  searchParams: Record<string, string | string[] | undefined> | null | undefined
): TicketPreset | null {
  const key = searchParams?.preset;
  if (typeof key !== 'string') return null;
  if (!Object.prototype.hasOwnProperty.call(TICKET_PRESETS, key)) return null;
  return TICKET_PRESETS[key];
}

interface CategoryNode {
  id: string;
  slug: string;
  children?: CategoryNode[];
}

/** Category and subcategory ids for a preset, from the loaded tree; '' when absent. */
export function presetCategoryIds(
  preset: TicketPreset,
  tree: CategoryNode[]
): { categoryId: string; subcategoryId: string } {
  const category = tree.find((c) => c.slug === preset.categorySlug);
  if (!category) return { categoryId: '', subcategoryId: '' };
  const sub = (category.children ?? []).find((c) => c.slug === preset.subcategorySlug);
  return { categoryId: category.id, subcategoryId: sub?.id ?? '' };
}
