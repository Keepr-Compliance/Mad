/**
 * The brokerage's recent invoices — BACKLOG-3855 (founder e007a05a: date, amount,
 * Paid / Due / Overdue, Download PDF, Pay when due). Plain rows from lib/billing/orgInvoices.ts;
 * no Stripe ids. Rows are keyed by position.
 */

import { Badge, Table, TableBody, TableContainer, TableHead, Td, Th, Tr, type BadgeHue } from '@keepr/design-system';
import type { OrgInvoiceRow, OrgInvoiceStatus } from '@/lib/billing/orgInvoices';
import { formatMoney, formatUnixDay } from './format';

export const ORG_INVOICES_EMPTY = 'No invoices yet.';
export const ORG_INVOICES_UNAVAILABLE = 'Your invoices are unavailable right now.';

const STATUS: Record<OrgInvoiceStatus, [string, BadgeHue]> = {
  paid: ['Paid', 'green'],
  due: ['Due', 'yellow'],
  overdue: ['Overdue', 'red'],
  void: ['Void', 'gray'],
  unpaid: ['Unpaid', 'red'],
};

const linkClass = 'font-medium text-indigo-700 hover:underline';

export function OrgInvoicesTable({ rows }: { rows: OrgInvoiceRow[] | null }) {
  if (rows === null || rows.length === 0) {
    return (
      <p className="mt-3 text-sm text-gray-600" data-org-invoices={rows === null ? 'unavailable' : 'empty'}>
        {rows === null ? ORG_INVOICES_UNAVAILABLE : ORG_INVOICES_EMPTY}
      </p>
    );
  }
  return (
    <TableContainer scrollX className="mt-3">
      <Table>
        <TableHead>
          <tr>
            <Th>Date</Th>
            <Th>Amount</Th>
            <Th>Status</Th>
            <Th>
              <span className="sr-only">Actions</span>
            </Th>
          </tr>
        </TableHead>
        <TableBody>
          {rows.map((r, i) => {
            const [label, hue] = STATUS[r.status];
            return (
              <Tr key={i} data-org-invoice-row="">
                <Td emphasis="primary">{formatUnixDay(r.created)}</Td>
                <Td className="tabular-nums">{formatMoney(r.amountCents, r.currency)}</Td>
                <Td>
                  <Badge hue={hue}>{label}</Badge>
                </Td>
                <Td>
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
