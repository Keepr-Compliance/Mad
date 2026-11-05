/**
 * The brokerage's recent invoices — BACKLOG-3855 (founder e007a05a: date, amount,
 * Paid / Due / Overdue, Download PDF, Pay when due). Plain rows from lib/billing/orgInvoices.ts;
 * no Stripe ids. Rows are keyed by position.
 */

import { Badge, Table, TableBody, TableContainer, TableHead, Td, Th, Tr, type BadgeHue } from '@keepr/design-system';
import type { OrgInvoiceRow, OrgInvoiceStatus } from '@/lib/billing/orgInvoices';
import { formatMoney, formatUnixDay } from './format';
import { TOUCH_LINK } from './touch';

export const ORG_INVOICES_EMPTY = 'No invoices yet.';
export const ORG_INVOICES_UNAVAILABLE = 'Your invoices are unavailable right now.';

const STATUS: Record<OrgInvoiceStatus, [string, BadgeHue]> = {
  paid: ['Paid', 'green'],
  due: ['Due', 'yellow'],
  overdue: ['Overdue', 'red'],
  void: ['Void', 'gray'],
  unpaid: ['Unpaid', 'red'],
};

const linkClass = `font-medium text-indigo-700 hover:underline ${TOUCH_LINK}`;
// BACKLOG-4139/4157: below lg each row stacks (date with the status pill at the right of the same
// line, then the amount, then the actions, each on its own line), so nothing needs a sideways scroll. From lg up it is the plain table.
const ROW_STACK = 'max-lg:grid max-lg:grid-cols-[1fr_auto] max-lg:items-center max-lg:gap-x-4 max-lg:gap-y-1 max-lg:px-4 max-lg:py-3';

export function OrgInvoicesTable({ rows }: { rows: OrgInvoiceRow[] | null }) {
  if (rows === null || rows.length === 0) {
    return (
      <p className="mt-3 text-sm text-gray-600" data-org-invoices={rows === null ? 'unavailable' : 'empty'}>
        {rows === null ? ORG_INVOICES_UNAVAILABLE : ORG_INVOICES_EMPTY}
      </p>
    );
  }
  return (
    // relative: the sr-only "Actions" header is position:absolute; without it the label escapes the
    // scroller and widens the page whenever the table scrolls (BACKLOG-4139).
    <TableContainer scrollX className="relative mt-3">
      <Table className="max-lg:block">
        <TableHead className="max-lg:hidden">
          <tr>
            <Th>Date</Th>
            <Th>Amount</Th>
            <Th>Status</Th>
            <Th>
              <span className="sr-only">Actions</span>
            </Th>
          </tr>
        </TableHead>
        <TableBody className="max-lg:block">
          {rows.map((r, i) => {
            const [label, hue] = STATUS[r.status];
            return (
              <Tr key={i} data-org-invoice-row="" className={ROW_STACK}>
                <Td emphasis="primary" className="max-lg:col-start-1 max-lg:row-start-1 max-lg:p-0">{formatUnixDay(r.created)}</Td>
                <Td className="tabular-nums max-lg:col-span-2 max-lg:row-start-2 max-lg:p-0">{formatMoney(r.amountCents, r.currency)}</Td>
                <Td className="max-lg:col-start-2 max-lg:row-start-1 max-lg:justify-self-end max-lg:p-0 max-lg:text-right">
                  <Badge hue={hue}>{label}</Badge>
                </Td>
                <Td className="max-lg:col-span-2 max-lg:row-start-3 max-lg:p-0">
                  <span className="flex gap-4">
                    {r.pdfUrl ? (
                      <a className={linkClass} href={r.pdfUrl} target="_blank" rel="noopener noreferrer" data-billing-action="download_invoice">
                        Download PDF
                      </a>
                    ) : null}
                    {r.payUrl ? (
                      <a className={linkClass} href={r.payUrl} target="_blank" rel="noopener noreferrer" data-billing-action="pay_invoice">
                        Pay
                      </a>
                    ) : null}
                  </span>
                </Td>
              </Tr>
            );
          })}
        </TableBody>
      </Table>
    </TableContainer>
  );
}
