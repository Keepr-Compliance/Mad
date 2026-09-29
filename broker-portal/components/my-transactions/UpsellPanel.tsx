/**
 * My Transactions upsell — BACKLOG-3080.
 *
 * Shown to a brokerage agent whose brokerage's plan does not include My
 * Transactions. Presentational only: it takes no props and reads nothing, so it
 * renders the same for every request (the detail route shows it for any id and
 * never echoes that id).
 */

import Link from 'next/link';
import { PageHeader } from '@keepr/design-system';
import { MY_TRANSACTIONS_UPGRADE_HREF } from '@/lib/support/ticketPresets';

export const MY_TRANSACTIONS_UPSELL_TEXT =
  "My Transactions isn't included in your brokerage's plan. If you'd like to view your transactions online, contact sales to upgrade your plan.";

export function UpsellPanel() {
  return (
    <div className="max-w-7xl mx-auto">
      <PageHeader title="My Transactions" />
      <div className="bg-white shadow-sm border border-gray-200 rounded-lg p-8 text-center">
        <p className="text-sm text-gray-600 max-w-xl mx-auto">{MY_TRANSACTIONS_UPSELL_TEXT}</p>
        <Link
          href={MY_TRANSACTIONS_UPGRADE_HREF}
          className="mt-6 inline-flex items-center px-4 py-2 rounded-md text-sm font-medium bg-primary-600 text-white hover:bg-primary-700 transition-colors"
        >
          Contact sales
        </Link>
      </div>
    </div>
  );
}
