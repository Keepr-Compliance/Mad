'use client';

/**
 * Commission Split Section — BACKLOG-3504.
 *
 * Third, full-width block on the user detail page, sibling to the
 * Membership/Activity grid and the IdP Groups block — not inside either
 * `<dl>`. Shown only when `canEdit`/viewing is permitted AND the subject's
 * role is one splits apply to (`splitAppliesToRole`); the caller
 * (UserDetailsCard) decides that and only renders this component when true.
 */

import { useState } from 'react';
import { Button, TableContainer, Table, TableHead, TableBody, Tr, Th, Td, TableEmptyRow } from '@keepr/design-system';
import AddSplitChangeModal from './AddSplitChangeModal';
import { formatUserDisplayName } from '@/lib/utils/userDisplay';
import { formatDate } from '@/lib/utils';
import { formatEffectiveDate, deriveCurrentSplit, type SplitAgreementHistoryRow } from '@/lib/splitAgreements';

interface CommissionSplitSectionProps {
  memberId: string;
  memberName: string;
  history: SplitAgreementHistoryRow[];
  canEdit: boolean;
}

export default function CommissionSplitSection({
  memberId,
  memberName,
  history,
  canEdit,
}: CommissionSplitSectionProps) {
  const [showAddChange, setShowAddChange] = useState(false);
  const current = deriveCurrentSplit(history);

  return (
    <div className="mt-6 pt-6 border-t border-gray-200">
      <div className="flex flex-wrap items-start justify-between gap-3 mb-4">
        <h2 className="text-lg font-semibold text-gray-900">Commission split</h2>
        {canEdit && (
          <Button variant="secondary" size="sm" onClick={() => setShowAddChange(true)}>
            Add a change
          </Button>
        )}
      </div>

      <div className="flex flex-wrap items-baseline gap-x-8 gap-y-3">
        <div className="flex flex-col">
          <span className="text-xl font-semibold text-gray-900">
            {current ? `${current.agent_pct}%` : '—'}
          </span>
          <span className="text-xs font-semibold uppercase tracking-wide text-gray-500 mt-1">Agent</span>
        </div>
        <div className="flex flex-col">
          <span className="text-xl font-semibold text-gray-900">
            {current ? `${current.brokerage_pct}%` : '—'}
          </span>
          <span className="text-xs font-semibold uppercase tracking-wide text-gray-500 mt-1">Brokerage</span>
        </div>
        {current ? (
          <p className="basis-full mt-1 text-sm text-gray-500">
            Effective from <strong className="text-gray-900 font-medium">{formatEffectiveDate(current.effective_from)}</strong>
          </p>
        ) : (
          <p className="basis-full mt-1 text-sm text-gray-500">No commission split on record.</p>
        )}
      </div>

      <p className="px-1 pt-5 text-xs font-semibold uppercase tracking-wide text-gray-500">History</p>
      <div className="mt-1">
        <TableContainer scrollX>
          <Table>
            <TableHead>
              <Tr>
                <Th scope="col">Effective from</Th>
                <Th scope="col">Agent %</Th>
                <Th scope="col">Brokerage %</Th>
                <Th scope="col">Set by</Th>
                <Th scope="col">Date</Th>
              </Tr>
            </TableHead>
            <TableBody>
              {history.length === 0 ? (
                <TableEmptyRow colSpan={5}>No changes recorded yet.</TableEmptyRow>
              ) : (
                history.map((row) => (
                  <Tr key={row.id}>
                    <Td emphasis="primary">{formatEffectiveDate(row.effective_from)}</Td>
                    <Td>{row.agent_pct}%</Td>
                    <Td>{row.brokerage_pct}%</Td>
                    <Td>{formatUserDisplayName(row.setByUser, row.setByUser?.email)}</Td>
                    <Td>{formatDate(row.set_at)}</Td>
                  </Tr>
                ))
              )}
            </TableBody>
          </Table>
        </TableContainer>
      </div>

      {canEdit && (
        <AddSplitChangeModal
          isOpen={showAddChange}
          onClose={() => setShowAddChange(false)}
          memberId={memberId}
          memberName={memberName}
          currentAgentPct={current?.agent_pct ?? 50}
        />
      )}
    </div>
  );
}
