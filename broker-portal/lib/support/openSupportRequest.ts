/**
 * Open the in-app support request form (SupportWidget) from anywhere on a dashboard
 * page — BACKLOG-3851 PR-2f (I1).
 *
 * The widget is mounted once by DashboardShell and listens for this window event.
 * A preset fills the form: category and subcategory are matched by SLUG once the
 * categories have loaded (an unknown slug leaves the field blank); subject and
 * description are filled as given. Without a preset the form opens as before.
 */

import type { TicketPriority } from '@/lib/support-types';

export const SUPPORT_WIDGET_EVENT = 'open-support-widget';

export interface SupportRequestPreset {
  categorySlug?: string;
  subcategorySlug?: string;
  subject?: string;
  description?: string;
  /** low | normal | high | urgent (lib/support-types.ts); the form's default (normal) applies when absent. */
  priority?: TicketPriority;
}

export function openSupportRequest(preset?: SupportRequestPreset): void {
  window.dispatchEvent(new CustomEvent<SupportRequestPreset | undefined>(SUPPORT_WIDGET_EVENT, { detail: preset }));
}

/** Support categories (support_categories.slug) used by the out-of-licenses prompt. */
export const BILLING_CATEGORY_SLUG = 'billing-subscription';
export const PLAN_SEAT_CHANGE_SUBCATEGORY_SLUG = 'plan-seat-change';

/** The request the out-of-licenses prompt opens: Billing & Subscription / Plan/seat change. */
export function moreLicensesSupportPreset(organizationName?: string | null): SupportRequestPreset {
  const org = organizationName?.trim();
  return {
    categorySlug: BILLING_CATEGORY_SLUG,
    subcategorySlug: PLAN_SEAT_CHANGE_SUBCATEGORY_SLUG,
    subject: 'More licenses needed',
    description: org ? `We need more licenses for ${org}` : 'We need more licenses for our brokerage',
  };
}

/**
 * The request the suspended-brokerage banner opens (BACKLOG-3853): Billing & Subscription /
 * Invoice/payment issue, at the form's highest priority. TicketPriority is
 * low | normal | high | urgent; 'urgent' is the top value and is labelled "Urgent".
 */
export function orgSuspendedSupportPreset(organizationName?: string | null): SupportRequestPreset {
  const org = organizationName?.trim();
  return {
    categorySlug: BILLING_CATEGORY_SLUG,
    subcategorySlug: 'invoice-payment-issue',
    subject: 'Our brokerage account is suspended',
    description: org
      ? `Our brokerage account (${org}) is suspended. Please help us get it reinstated.`
      : 'Our brokerage account is suspended. Please help us get it reinstated.',
    priority: 'urgent',
  };
}
