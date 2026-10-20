/**
 * Billing contact phone rule — BACKLOG-4007. The rule itself lives in @keepr/shared
 * (packages/shared/src/billing/phone.ts) so the admin portal uses the same one.
 */
export { PHONE_ERROR, normalizeBillingPhone, isValidBillingPhone, formatBillingPhoneInput } from '@keepr/shared';
