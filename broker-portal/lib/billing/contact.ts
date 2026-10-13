/**
 * The billing contact's email — BACKLOG-3848.
 *
 * ONE function decides the address, and both sides read it:
 *   - the "Receipts sent to" / "Invoices sent to" label on the Billing page
 *     (lib/billing/personalBilling.ts);
 *   - the Agent plan receipt Keepr sends (lib/billing/agentReceipt.ts).
 *     (Stripe emails the per-export receipt, founder 2026-10-13.)
 * So the page never shows one address while the receipt goes to another
 * (SR PR-1 review, binding on PR-2).
 *
 * Source: the Stripe Customer's `email` in this mode (what Edit contact writes),
 * else the sign-in email (a deleted customer, or a customer with no email).
 */

import type Stripe from 'stripe';

export function billingContactEmail(
  customer: Stripe.Customer | Stripe.DeletedCustomer | null | undefined,
  signInEmail: string | null
): string | null {
  const live = customer && !('deleted' in customer && customer.deleted) ? (customer as Stripe.Customer) : null;
  const email = live?.email?.trim();
  return email ? email : signInEmail;
}

/** The billing contact's name, or null. */
export function billingContactName(customer: Stripe.Customer | Stripe.DeletedCustomer | null | undefined): string | null {
  const live = customer && !('deleted' in customer && customer.deleted) ? (customer as Stripe.Customer) : null;
  return live?.name?.trim() ? live.name : null;
}

export const CONTACT_NAME_MAX = 100;
export const CONTACT_EMAIL_MAX = 254;
const EMAIL_SHAPE = /^[^\s@<>(),;:"[\]]+@[^\s@<>(),;:"[\]]+\.[^\s@<>(),;:"[\]]+$/;

export type ContactInput = { name: string | null; email: string };

/** Trim and check a contact edit. Returns the clean values or a message for the person. */
export function validateContact(raw: { name?: unknown; email?: unknown }): ContactInput | { error: string } {
  const name = typeof raw.name === 'string' ? raw.name.trim() : '';
  const email = typeof raw.email === 'string' ? raw.email.trim() : '';
  if (name.length > CONTACT_NAME_MAX) return { error: `Name can be at most ${CONTACT_NAME_MAX} characters.` };
  if (!email) return { error: 'Enter an email address for receipts.' };
  if (email.length > CONTACT_EMAIL_MAX || !EMAIL_SHAPE.test(email)) return { error: 'Enter a valid email address.' };
  return { name: name || null, email };
}
