/**
 * "Account suspended" email to a brokerage's billing contact (BACKLOG-3853 PR-2, founder B4:
 * Keepr sends only "seats added" and "account suspended"; there is no reinstated email).
 * Sent once per suspension by the billing outbox (kind notify_org_suspended).
 *
 * BACKLOG-3853 PR-2B (founder 64e00066, 1e164f56): a Non-payment suspension carries a
 * "Pay overdue invoice" button to Stripe's hosted page of the oldest overdue invoice, and the
 * members sentence reads "members can't submit transactions, buy exports or invite people.
 * They can still view their own submissions." An Other suspension has no button.
 */

import { baseLayout } from './base-layout';
import type { AccountSuspendedParams, EmailContent } from '../types';

export const PAY_BUTTON_LABEL = 'Pay overdue invoice';

const MEMBERS =
  "While the account is suspended, members can't submit transactions, buy exports or invite people. They can still view their own submissions. Your data is kept.";
const MISTAKE = 'If you think this is a mistake, reply to this email or contact your Keepr account manager.';
const STRIPE_EMAIL = 'You can also pay from the link in the invoice email from Stripe.';

/** The non-payment lines after the members sentence, and the button URL if any. */
function nonPayment(params: AccountSuspendedParams): { before: string[]; url: string | null; after: string[] } {
  const p = params.payment;
  if (p.kind === 'invoice') {
    const access =
      p.overdueCount > 1
        ? `${p.overdueCount} invoices are past due; access returns once all are paid. The button opens the oldest.`
        : 'Access returns on its own shortly after the payment clears.';
    return { before: [], url: p.url, after: [access, STRIPE_EMAIL, MISTAKE] };
  }
  if (p.kind === 'stripe_email') {
    return {
      before: [
        'To restore access, pay the overdue invoice from the link in the invoice email from Stripe. Access returns on its own once every overdue invoice is paid.',
      ],
      url: null,
      after: [MISTAKE],
    };
  }
  return {
    before: ['Please contact your Keepr account manager about the overdue invoice to restore access.'],
    url: null,
    after: [MISTAKE],
  };
}

export function buildAccountSuspendedEmail(params: AccountSuspendedParams): EmailContent {
  const { brokerageName, reason } = params;
  const subject = `Your Keepr account for ${brokerageName} is suspended`;

  let before: string[];
  let url: string | null = null;
  let after: string[] = [];
  if (reason === 'non_payment') {
    const np = nonPayment(params);
    before = [`Keepr has suspended the account for ${brokerageName} because an invoice is past due.`, MEMBERS, ...np.before];
    url = np.url;
    after = np.after;
  } else {
    before = [
      `Keepr has suspended the account for ${brokerageName}.`,
      MEMBERS,
      'Please contact your Keepr account manager to restore access.',
    ];
  }

  const p = (l: string) =>
    `<p style="margin:0 0 12px 0; font-size:16px; color:#374151; line-height:1.6;">${escapeHtml(l)}</p>`;
  // Table-based button, as templates/invite.ts.
  const button = url
    ? `<table cellpadding="0" cellspacing="0" border="0" style="margin:8px 0 20px 0;">
        <tr>
          <td align="center" style="border-radius:6px; background-color:#4f46e5;">
            <a href="${escapeAttr(url)}"
               target="_blank"
               data-pay-overdue-invoice="true"
               style="display:inline-block; padding:14px 32px; font-size:16px; font-weight:600; color:#ffffff; text-decoration:none; border-radius:6px; background-color:#4f46e5;">
              ${PAY_BUTTON_LABEL}
            </a>
          </td>
        </tr>
      </table>`
    : '';

  const html = baseLayout({
    preheader: `The Keepr account for ${brokerageName} is suspended`,
    body: `
      <h1 style="margin:0 0 16px 0; font-size:22px; font-weight:700; color:#111827; line-height:1.3;">
        ${escapeHtml(subject)}
      </h1>
      ${before.map(p).join('\n      ')}
      ${button}
      ${after.map(p).join('\n      ')}
    `,
  });

  const textLines = [...before, ...(url ? [`${PAY_BUTTON_LABEL}: ${url}`] : []), ...after];
  const text = [subject, '', ...textLines.flatMap((l) => [l, ''])].join('\n').trimEnd();
  return { subject, html, text };
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function escapeAttr(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
