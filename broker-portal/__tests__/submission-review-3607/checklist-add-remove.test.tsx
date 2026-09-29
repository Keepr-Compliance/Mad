/**
 * Broker Remove, "Add it back", and the history lines — BACKLOG-3607, PR 3 (portal).
 *
 * FIXTURE PROVENANCE (every id and name invented):
 *   - History entries: the jsonb_build_object calls in
 *     supabase/migrations/20260929120000_backlog_3607_checklist_add_remove.sql
 *     (PR #2750 @ da1b43459), keys in the order written there:
 *       carry version diff   :509-524  {type, changed_at, changed_by, source 'version',
 *                                       checklist_key, template_id, checklist_name,
 *                                       from_version} + removed_checklist_id |
 *                                       added_at_review | after_broker_removal |
 *                                       replaced | parent_had_none
 *       add, un-remove       :318-326  {type 'checklist_added', ..., source 'review', readded true, ...}
 *       remove at review     :790-800  {type 'checklist_removed', ..., source 'review',
 *                                       checklist_id, checklist_key, template_id,
 *                                       checklist_name, linked_documents, linked_emails}
 *       restore              :936-948  {type 'checklist_added', ..., source 'review', restored true,
 *                                       restored_from_version, restored_from_checklist_id,
 *                                       checklist_id, checklist_key, template_id,
 *                                       checklist_name, ticks_restored}
 *   - RPC returns: remove :767 / :803-804; restore :894 / :904 / :909 / :951-952;
 *     add :328. Refusal: tick :203 `RAISE EXCEPTION 'checklist_removed' USING ERRCODE = '42501'`.
 *   - Sections: what lib/submissions/checklists.ts assembles (see the loader test below).
 */

import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import '@testing-library/jest-dom';

const mockRefresh = jest.fn();
jest.mock('next/navigation', () => ({ useRouter: () => ({ refresh: mockRefresh }) }));

const mockSetReviewerCheck = jest.fn();
const mockAddChecklist = jest.fn();
const mockRemoveChecklist = jest.fn();
const mockRestoreChecklist = jest.fn();
jest.mock('@/lib/actions/submissionChecklists', () => ({
  setReviewerCheck: (...a: unknown[]) => mockSetReviewerCheck(...a),
  addChecklistAtReview: (...a: unknown[]) => mockAddChecklist(...a),
  removeChecklistAtReview: (...a: unknown[]) => mockRemoveChecklist(...a),
  restoreChecklistAtReview: (...a: unknown[]) => mockRestoreChecklist(...a),
}));
jest.mock('@/components/submission/AttachmentViewerModal', () => ({ AttachmentViewerModal: () => null }));
jest.mock('next/link', () => ({
  __esModule: true,
  default: ({ href, children }: { href: string; children: React.ReactNode }) => <a href={href}>{children}</a>,
}));

import { ChecklistReview, removeConfirmText, type ChecklistReviewProps } from '@/components/submission/ChecklistReview';
import { StatusHistory } from '@/components/submission/StatusHistory';
import {
  agentRemovals,
  linkedEvidenceCounts,
  overallRequiredCount,
  type ChecklistItemView,
  type ChecklistSectionView,
} from '@/lib/submissions/checklistModel';
import {
  describeTypedEntry,
  showsActor,
  withoutBrokerReviewEntries,
  type StatusHistoryEntry,
} from '@/lib/submissions/history';
import { REVIEW_MESSAGES, reasonForReviewRpcError, reviewFailure } from '@/lib/submissions/reviewMessages';

// pii-allow-uuid: invented fixture ids below (whole block)
const REMOVED_V1_HEADER = '00000000-0000-4000-8000-000000360701'; // pii-allow-uuid: invented fixture id
const TPL_DISCLOSURES = '00000000-0000-4000-8000-000000360702'; // pii-allow-uuid: invented fixture id
const TPL_CONTRACT = '00000000-0000-4000-8000-000000360703'; // pii-allow-uuid: invented fixture id
const TPL_INSPECTION = '00000000-0000-4000-8000-000000360704'; // pii-allow-uuid: invented fixture id
const AGENT = 'agent-id';
const BROKER = 'broker-id';
const NAMES = { [AGENT]: 'Agent Fixture', [BROKER]: 'Broker Fixture' };

const at = '2026-09-29T10:00:00.000000+00:00';

/** carry :509-524 */
function versionEntry(
  t: 'checklist_added' | 'checklist_removed',
  over: Record<string, unknown> = {}
): StatusHistoryEntry {
  return {
    type: t,
    changed_at: at,
    changed_by: AGENT,
    source: 'version',
    checklist_key: TPL_DISCLOSURES,
    template_id: TPL_DISCLOSURES,
    checklist_name: 'Seller Disclosures',
    from_version: 1,
    ...over,
  } as StatusHistoryEntry;
}

/** restore :936-948 */
function restoredEntry(ticks: unknown): StatusHistoryEntry {
  return {
    type: 'checklist_added',
    changed_at: at,
    changed_by: BROKER,
    source: 'review',
    restored: true,
    restored_from_version: 1,
    restored_from_checklist_id: REMOVED_V1_HEADER,
    checklist_id: 'hdr-restored',
    checklist_key: TPL_DISCLOSURES,
    template_id: TPL_DISCLOSURES,
    checklist_name: 'Seller Disclosures',
    ticks_restored: ticks,
  } as StatusHistoryEntry;
}

/** remove :790-800 */
function brokerRemovedEntry(docs: number, emails: number): StatusHistoryEntry {
  return {
    type: 'checklist_removed',
    changed_at: at,
    changed_by: BROKER,
    source: 'review',
    checklist_id: 'hdr-contract',
    checklist_key: TPL_CONTRACT,
    template_id: TPL_CONTRACT,
    checklist_name: 'Purchase Contract',
    linked_documents: docs,
    linked_emails: emails,
  } as StatusHistoryEntry;
}

// ---------------------------------------------------------------------------
// History copy: one test per branch
// ---------------------------------------------------------------------------
describe('history lines (BACKLOG-3607)', () => {
  it.each([
    ['agent added', versionEntry('checklist_added'), 'Checklist added in version 2: Seller Disclosures'],
    ['agent removed', versionEntry('checklist_removed', { removed_checklist_id: REMOVED_V1_HEADER }), 'Checklist removed in version 2: Seller Disclosures'],
    [
      'agent removed one added at review',
      versionEntry('checklist_removed', { removed_checklist_id: REMOVED_V1_HEADER, added_at_review: true }),
      'Seller Disclosures, added at review, is not on version 2',
    ],
    [
      'neutral: previous version had none',
      versionEntry('checklist_added', { parent_had_none: true }),
      'Seller Disclosures — on version 2, not on version 1',
    ],
    [
      'still on after a broker removal',
      versionEntry('checklist_added', { after_broker_removal: true }),
      'Seller Disclosures is on version 2 although it was removed at review',
    ],
    [
      'replaced, removed half',
      versionEntry('checklist_removed', { removed_checklist_id: REMOVED_V1_HEADER, replaced: true }),
      'Checklist removed in version 2, then added again with different items: Seller Disclosures',
    ],
    ['replaced, added half', versionEntry('checklist_added', { replaced: true }), 'Checklist added again in version 2, with different items: Seller Disclosures'],
    [
      'broker added (3477, unchanged)',
      { type: 'checklist_added', changed_at: at, changed_by: BROKER, checklist_id: 'h', checklist_name: 'Seller Disclosures', template_id: TPL_DISCLOSURES } as StatusHistoryEntry,
      'Checklist added: Seller Disclosures',
    ],
    [
      'broker undid their removal',
      { type: 'checklist_added', changed_at: at, changed_by: BROKER, source: 'review', readded: true, checklist_id: 'h', checklist_name: 'Purchase Contract', template_id: TPL_CONTRACT } as StatusHistoryEntry,
      'Checklist removal undone: Purchase Contract',
    ],
    ['added back, 3 ticks', restoredEntry(3), 'Checklist added back: Seller Disclosures (3 earlier checks restored)'],
    ['added back, 1 tick', restoredEntry(1), 'Checklist added back: Seller Disclosures (1 earlier check restored)'],
    ['added back, no ticks', restoredEntry(0), 'Checklist added back: Seller Disclosures (no earlier checks to restore)'],
    ['broker removed, both counts', brokerRemovedEntry(3, 2), 'Checklist removed: Purchase Contract (3 documents and 2 emails linked)'],
    ['broker removed, one document', brokerRemovedEntry(1, 0), 'Checklist removed: Purchase Contract (1 document linked)'],
    ['broker removed, nothing linked', brokerRemovedEntry(0, 0), 'Checklist removed: Purchase Contract'],
  ])('%s', (_label, entry, text) => {
    expect(describeTypedEntry(entry)).toBe(text);
  });

  it('agent-written values are checked: a from_version that is not a number is not printed', () => {
    const text = describeTypedEntry(versionEntry('checklist_added', { from_version: '1; <b>x</b>' }));
    expect(text).toBe('Checklist added in the new version: Seller Disclosures');
  });

  it('the neutral line names nobody; every other new line names who wrote it', () => {
    expect(showsActor(versionEntry('checklist_added', { parent_had_none: true }))).toBe(false);
    expect(showsActor(versionEntry('checklist_added'))).toBe(true);
    expect(showsActor(versionEntry('checklist_removed'))).toBe(true);
    expect(showsActor(restoredEntry(2))).toBe(true);
  });

  it('rendered: "by <agent>" under an agent removal, not under the neutral line', () => {
    const entries = [
      { status: 'submitted', changed_at: '2026-09-29T09:00:00Z', changed_by: null, notes: null },
      { ...versionEntry('checklist_removed'), changed_by: 'Agent Fixture' },
      { ...versionEntry('checklist_added', { parent_had_none: true, checklist_name: 'Inspection' }), changed_by: 'Agent Fixture' },
    ] as StatusHistoryEntry[];
    render(<StatusHistory history={entries} currentStatus="submitted" submittedAt="2026-09-29T09:00:00Z" />);
    fireEvent.click(screen.getByRole('button', { name: /checklist change/ }));
    const lines = screen.getAllByTestId('typed-history-entry');
    const removedLine = lines.find((l) => l.textContent?.includes('Checklist removed in version 2'))!;
    const neutralLine = lines.find((l) => l.textContent?.includes('Inspection — on version 2'))!;
    expect(removedLine).toHaveTextContent('by Agent Fixture');
    expect(neutralLine).not.toHaveTextContent('by Agent Fixture');
  });

  it("the agent's timeline keeps the added-back line but not the count of the broker's ticks (D4)", () => {
    const agentView = withoutBrokerReviewEntries([restoredEntry(4)]);
    expect(agentView).toHaveLength(1);
    const text = describeTypedEntry(agentView[0]);
    expect(text).toBe('Checklist added back: Seller Disclosures');
    expect(text).not.toMatch(/\d/);
  });
});

// ---------------------------------------------------------------------------
// Refusal copy
// ---------------------------------------------------------------------------
describe('refusal copy (BACKLOG-3607)', () => {
  it('a tick on a removed checklist reads as removed, not as no permission', () => {
    const reason = reasonForReviewRpcError({ code: '42501', message: 'checklist_removed' });
    expect(reason).toBe('checklist_removed');
    expect(REVIEW_MESSAGES[reason]).not.toBe(REVIEW_MESSAGES.not_authorized);
  });

  it.each(['checklist_removed', 'not_removed', 'already_present', 'removed_here'] as const)('%s has plain copy, no code', (r) => {
    expect(reviewFailure(r).message).not.toMatch(/_|42501/);
  });
});

// ---------------------------------------------------------------------------
// Counts for the Remove confirmation
// ---------------------------------------------------------------------------
const item = (id: string, title: string, over: Partial<ChecklistItemView> = {}): ChecklistItemView => ({
  id,
  title,
  description: null,
  isRequired: true,
  isChecked: false,
  note: null,
  reviewerChecked: false,
  reviewerCheckedBy: null,
  reviewerCheckedAt: null,
  clearedReviewerId: null,
  clearedAt: null,
  links: [],
  ...over,
});
const attLink = (id: string, ...attIds: string[]) => ({
  id,
  kind: 'attachment',
  label: `${id}.pdf`,
  members: attIds.map((a) => ({ kind: 'attachment', submissionAttachmentId: a, submissionMessageId: null })),
});
const mailLink = (id: string, ...msgIds: string[]) => ({
  id,
  kind: 'email',
  label: id,
  members: msgIds.map((m) => ({ kind: 'email', submissionAttachmentId: null, submissionMessageId: m })),
});

const CONTRACT: ChecklistSectionView = {
  id: 'hdr-contract',
  templateId: TPL_CONTRACT,
  name: 'Purchase Contract',
  addedAtReviewBy: null,
  addedAtReviewAt: null,
  removedAtReviewBy: null,
  removedAtReviewAt: null,
  restoredFromChecklistId: null,
  items: [
    // att-1 and att-1b are two uploads of ONE local file (L-1): one document.
    item('i-1', 'Executed contract', { links: [attLink('l1', 'att-1'), attLink('l2', 'att-1b')] }),
    item('i-2', 'Addenda', { links: [attLink('l3', 'att-2', 'att-3'), mailLink('l4', 'msg-1')] }),
    // att-nolocal has no local id: not counted (the RPC's rule).
    item('i-3', 'Earnest money', { links: [attLink('l5', 'att-nolocal'), mailLink('l6', 'msg-2', 'msg-1')] }),
  ],
};
const LOCAL_ATT = new Map<string, string | null>([
  ['att-1', 'L-1'],
  ['att-1b', 'L-1'],
  ['att-2', 'L-2'],
  ['att-3', 'L-3'],
  ['att-nolocal', null],
]);
const LOCAL_MSG = new Map<string, string | null>([
  ['msg-1', 'M-1'],
  ['msg-2', 'M-2'],
]);

describe('linked counts (remove RPC rule, migration §6)', () => {
  it('one file uploaded twice is one document; no local id is not counted; emails separate', () => {
    expect(linkedEvidenceCounts(CONTRACT, LOCAL_ATT, LOCAL_MSG)).toEqual({ documents: 3, emails: 2 });
  });

  it.each([
    [{ documents: 3, emails: 2 }, '3 documents and 2 emails are linked to it. They stay on the deal; the checklist and its links are removed.'],
    [{ documents: 1, emails: 1 }, '1 document and 1 email are linked to it. They stay on the deal; the checklist and its links are removed.'],
    [{ documents: 1, emails: 0 }, '1 document is linked to it. It stays on the deal; the checklist and its links are removed.'],
    [{ documents: 0, emails: 1 }, '1 email is linked to it. It stays on the deal; the checklist and its links are removed.'],
    [{ documents: 0, emails: 2 }, '2 emails are linked to it. They stay on the deal; the checklist and its links are removed.'],
    [{ documents: 2, emails: 0 }, '2 documents are linked to it. They stay on the deal; the checklist and its links are removed.'],
    [{ documents: 0, emails: 0 }, 'No documents or emails are linked to it. The checklist is removed.'],
  ])('confirm copy for %j', (counts, text) => {
    expect(removeConfirmText(counts)).toBe(text);
  });
});

// ---------------------------------------------------------------------------
// The review page component
// ---------------------------------------------------------------------------
const DISCLOSURES_REMOVED: ChecklistSectionView = {
  id: 'hdr-disc-removed',
  templateId: TPL_INSPECTION,
  name: 'Inspection',
  addedAtReviewBy: null,
  addedAtReviewAt: null,
  removedAtReviewBy: BROKER,
  removedAtReviewAt: at,
  restoredFromChecklistId: null,
  items: [item('i-r1', 'Inspection report', { reviewerChecked: false })],
};

function renderReview(over: Partial<ChecklistReviewProps> = {}) {
  const props: ChecklistReviewProps = {
    submissionId: 'sub-v2',
    status: 'under_review',
    sections: [CONTRACT, DISCLOSURES_REMOVED],
    names: NAMES,
    canTick: true,
    canDecide: true,
    templates: [],
    messages: [],
    attachments: [],
    version: 2,
    linkedCounts: { [CONTRACT.id]: linkedEvidenceCounts(CONTRACT, LOCAL_ATT, LOCAL_MSG) },
    versionHistory: [],
    ...over,
  };
  return render(<ChecklistReview {...props} />);
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('Remove checklist', () => {
  it('the confirmation shows both counts, and Remove calls the remove action with the checklist id', async () => {
    mockRemoveChecklist.mockResolvedValue({ ok: true, status: 'removed', checklistId: CONTRACT.id });
    renderReview();
    fireEvent.click(screen.getByRole('button', { name: 'Remove checklist: Purchase Contract' }));
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByText('Remove Purchase Contract?')).toBeInTheDocument();
    expect(dialog).toHaveTextContent('3 documents and 2 emails are linked to it. They stay on the deal; the checklist and its links are removed.');
    expect(mockRemoveChecklist).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(mockRefresh).toHaveBeenCalled());
    expect(mockRemoveChecklist).toHaveBeenCalledWith('sub-v2', CONTRACT.id);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('a refusal stays in the dialog as plain copy', async () => {
    mockRemoveChecklist.mockResolvedValue(reviewFailure('superseded'));
    renderReview();
    fireEvent.click(screen.getByRole('button', { name: 'Remove checklist: Purchase Contract' }));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Remove' }));
    expect(await within(screen.getByRole('dialog')).findByRole('alert')).toHaveTextContent(REVIEW_MESSAGES.superseded);
    expect(mockRefresh).not.toHaveBeenCalled();
  });

  it('Cancel closes without calling anything', () => {
    renderReview();
    fireEvent.click(screen.getByRole('button', { name: 'Remove checklist: Purchase Contract' }));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(mockRemoveChecklist).not.toHaveBeenCalled();
  });

  it.each([
    ['needs_changes', null],
    ['under_review', 'newer'],
    ['under_review', 'uploading'],
  ] as const)('disabled on a closed version: status %s, superseded %s', (status, supersededBy) => {
    renderReview({ status, supersededBy });
    const btn = screen.getByRole('button', { name: 'Remove checklist: Purchase Contract' });
    expect(btn).toBeDisabled();
    fireEvent.click(btn);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('not offered to the agent, to a viewer who cannot tick, or on a decided version', () => {
    const a = renderReview({ viewer: 'agent' });
    expect(screen.queryByRole('button', { name: /Remove checklist/ })).not.toBeInTheDocument();
    a.unmount();
    const b = renderReview({ canTick: false });
    expect(screen.queryByRole('button', { name: /Remove checklist/ })).not.toBeInTheDocument();
    b.unmount();
    renderReview({ status: 'approved' });
    expect(screen.queryByRole('button', { name: /Remove checklist/ })).not.toBeInTheDocument();
  });
});

describe('a checklist removed at review', () => {
  it('is marked, counts toward nothing, and its items cannot be ticked', () => {
    renderReview();
    expect(screen.getByText('Removed at review')).toBeInTheDocument();
    // CONTRACT: 3 required, none ticked. The removed section's required item is not counted.
    expect(overallRequiredCount([CONTRACT, DISCLOSURES_REMOVED], 'reviewer')).toEqual({ done: 0, total: 3 });
    expect(screen.getAllByText('0 of 3 required')).toHaveLength(2); // overall + Purchase Contract
    expect(screen.queryByText(/of 1 required/)).not.toBeInTheDocument();
    // N-1: the leading number counts live checklists only (the removed one is not one of them).
    expect(screen.getByText('1 checklist · 1 removed at review')).toBeInTheDocument();
    fireEvent.click(screen.getByText('Expand all'));
    expect(screen.getByTestId('removed-banner')).toHaveTextContent('Removed by Broker Fixture at review');
    expect(screen.getByTestId('removed-banner')).toHaveTextContent('It is not on the agent’s next version.');
    const box = screen.getByRole('checkbox', { name: 'Checked: Inspection report' });
    expect(box).toBeDisabled();
    fireEvent.click(box);
    expect(mockSetReviewerCheck).not.toHaveBeenCalled();
  });

  it('Undo calls the add action with the template (un-remove), not restore', async () => {
    mockAddChecklist.mockResolvedValue({ ok: true, status: 'readded', checklistId: DISCLOSURES_REMOVED.id });
    renderReview();
    fireEvent.click(screen.getByText('Expand all'));
    fireEvent.click(screen.getByRole('button', { name: 'Undo removal: Inspection' }));
    await waitFor(() => expect(mockRefresh).toHaveBeenCalled());
    expect(mockAddChecklist).toHaveBeenCalledWith('sub-v2', TPL_INSPECTION);
    expect(mockRestoreChecklist).not.toHaveBeenCalled();
  });

  it('the agent sees it marked, addressed to them, with no Undo and no count', () => {
    renderReview({ viewer: 'agent' });
    expect(screen.getByText('Removed at review')).toBeInTheDocument();
    fireEvent.click(screen.getByText('Expand all'));
    const banner = screen.getByTestId('removed-banner');
    expect(banner).toHaveTextContent('It is not on your next version.');
    expect(banner).not.toHaveTextContent('the agent’s');
    expect(screen.queryByRole('button', { name: /Undo removal/ })).not.toBeInTheDocument();
  });

  it('a checklist with no template has no Undo', () => {
    renderReview({ sections: [{ ...DISCLOSURES_REMOVED, templateId: null }] });
    fireEvent.click(screen.getByText('Expand all'));
    expect(screen.getByTestId('removed-banner')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Undo removal/ })).not.toBeInTheDocument();
  });

  it('the Add picker offers a removed template again (Add un-removes it)', () => {
    renderReview({ templates: [{ id: TPL_INSPECTION, name: 'Inspection' }, { id: TPL_CONTRACT, name: 'Purchase Contract' }] });
    fireEvent.click(screen.getByRole('button', { name: /Add checklist/ }));
    expect(screen.getByRole('button', { name: 'Add Inspection' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Add Purchase Contract' })).not.toBeInTheDocument();
  });
});

describe('the agent removed a checklist: notice and "Add it back"', () => {
  const removal = (over: Record<string, unknown> = {}) =>
    versionEntry('checklist_removed', { removed_checklist_id: REMOVED_V1_HEADER, ...over });

  it('names the agent and the checklist; Add it back calls RESTORE with the id from history, never add', async () => {
    mockRestoreChecklist.mockResolvedValue({ ok: true, checklistId: 'hdr-restored', ticksRestored: 3 });
    renderReview({ versionHistory: [removal()] });
    const line = screen.getByTestId('agent-removal');
    expect(line).toHaveTextContent('Agent Fixture removed Seller Disclosures from this version.');
    fireEvent.click(within(line).getByRole('button', { name: 'Add it back: Seller Disclosures' }));
    await waitFor(() => expect(mockRefresh).toHaveBeenCalled());
    expect(mockRestoreChecklist).toHaveBeenCalledWith('sub-v2', REMOVED_V1_HEADER);
    expect(mockAddChecklist).not.toHaveBeenCalled();
  });

  it.each([
    ['absent', {}],
    ['not a string', { removed_checklist_id: 42 }],
    ['not an id', { removed_checklist_id: 'x; drop' }],
  ])('R-5: removed_checklist_id %s -> the line, no button, no error', (_l, over) => {
    const entry = { ...versionEntry('checklist_removed'), ...over } as StatusHistoryEntry;
    renderReview({ versionHistory: [entry] });
    expect(screen.getByTestId('agent-removal')).toHaveTextContent('Agent Fixture removed Seller Disclosures from this version.');
    expect(screen.queryByRole('button', { name: /Add it back/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('once added back: "Added back by <broker>", no button', () => {
    const restored: ChecklistSectionView = {
      id: 'hdr-restored',
      templateId: TPL_DISCLOSURES,
      name: 'Seller Disclosures',
      addedAtReviewBy: BROKER,
      addedAtReviewAt: at,
      removedAtReviewBy: null,
      removedAtReviewAt: null,
      restoredFromChecklistId: REMOVED_V1_HEADER,
      items: [
        item('i-x', 'Transfer disclosure', {
          reviewerChecked: true,
          reviewerCheckedBy: BROKER,
          reviewerCheckedAt: '2026-09-28T10:05:00Z',
          restoredFromItemId: 'i-v1-x',
        }),
      ],
    };
    renderReview({ sections: [CONTRACT, restored], versionHistory: [removal()] });
    expect(screen.getByTestId('agent-removal')).toHaveTextContent('Added back by Broker Fixture.');
    expect(screen.queryByRole('button', { name: /Add it back/ })).not.toBeInTheDocument();
    // The restored tick says where it came from.
    expect(screen.getByTestId('reviewer-meta')).toHaveTextContent('restored from version 1');
  });

  it('a checklist added at review that is not on the new version: "Add it again"', () => {
    renderReview({ versionHistory: [removal({ added_at_review: true })] });
    expect(screen.getByTestId('agent-removal')).toHaveTextContent('Seller Disclosures, which was added at review, is not on this version.');
    expect(screen.getByRole('button', { name: 'Add it again: Seller Disclosures' })).toBeInTheDocument();
  });

  it('a replaced checklist is not listed (it is on this version)', () => {
    renderReview({ versionHistory: [removal({ replaced: true })] });
    expect(screen.queryByTestId('agent-removals')).not.toBeInTheDocument();
  });

  it.each([
    ['needs_changes', null],
    ['under_review', 'newer'],
  ] as const)('closed version (%s, %s): the line stays, no button', (status, supersededBy) => {
    renderReview({ status, supersededBy, versionHistory: [removal()] });
    expect(screen.getByTestId('agent-removal')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Add it back/ })).not.toBeInTheDocument();
  });

  it('a refusal shows plain copy', async () => {
    mockRestoreChecklist.mockResolvedValue(reviewFailure('not_removed'));
    renderReview({ versionHistory: [removal()] });
    fireEvent.click(screen.getByRole('button', { name: 'Add it back: Seller Disclosures' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(REVIEW_MESSAGES.not_removed);
    expect(mockRefresh).not.toHaveBeenCalled();
  });

  it('the agent view shows no notice', () => {
    renderReview({ viewer: 'agent', versionHistory: [removal()] });
    expect(screen.queryByTestId('agent-removals')).not.toBeInTheDocument();
  });

  it('agentRemovals reads only checklist_removed from the version diff', () => {
    const list = agentRemovals([
      removal(),
      brokerRemovedEntry(1, 1),
      versionEntry('checklist_added'),
      { status: 'submitted', changed_at: at },
      null,
      'junk',
    ]);
    expect(list).toEqual([
      { key: TPL_DISCLOSURES, name: 'Seller Disclosures', changedBy: AGENT, addedAtReview: false, removedChecklistId: REMOVED_V1_HEADER },
    ]);
  });
});
