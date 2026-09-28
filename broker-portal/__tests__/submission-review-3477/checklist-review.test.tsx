/**
 * ChecklistReview — BACKLOG-3477, mock 3481 v4.
 *
 * Sections are what lib/submissions/checklists.ts assembles from the copy
 * tables (see page.test.tsx for the row provenance). Server action results
 * are the shapes lib/actions/submissionChecklists.ts returns, which mirror the
 * RPC returns in §7/§8 of 20260925073000_backlog_3477_submission_checklist_review.sql.
 * Messages/attachments carry the page's Message/Attachment columns.
 */

import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import '@testing-library/jest-dom';

const mockRefresh = jest.fn();
jest.mock('next/navigation', () => ({ useRouter: () => ({ refresh: mockRefresh }) }));

const mockSetReviewerCheck = jest.fn();
const mockAddChecklist = jest.fn();
jest.mock('@/lib/actions/submissionChecklists', () => ({
  setReviewerCheck: (...a: unknown[]) => mockSetReviewerCheck(...a),
  addChecklistAtReview: (...a: unknown[]) => mockAddChecklist(...a),
}));

// The attachment viewer pulls heic2any (a Worker) at import; the chip only
// has to hand it the right attachment.
jest.mock('@/components/submission/AttachmentViewerModal', () => ({
  AttachmentViewerModal: ({ attachment, open }: { attachment: { filename: string } | null; open: boolean }) =>
    open && attachment ? <div data-testid="attachment-viewer">{attachment.filename}</div> : null,
}));

import { ChecklistReview, ADD_DISABLED_REASON, type ChecklistReviewProps } from '@/components/submission/ChecklistReview';
import type { ChecklistSectionView, ChecklistItemView } from '@/lib/submissions/checklistModel';
import { REVIEW_MESSAGES } from '@/lib/submissions/reviewMessages';

const VIEWER = 'viewer-id';
const COLLEAGUE = 'colleague-id';

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
  links: [],
  ...over,
});

const SECTIONS: ChecklistSectionView[] = [
  {
    id: 'hdr-contract',
    templateId: 'tpl-contract',
    name: 'Contract',
    addedAtReviewBy: null,
    addedAtReviewAt: null,
    items: [
      item('i-buyer', 'Buyer representation agreement', { isChecked: true }),
      item('i-contract', 'Executed purchase contract', {
        isChecked: true,
        reviewerChecked: true,
        reviewerCheckedBy: COLLEAGUE,
        reviewerCheckedAt: '2026-09-20T15:10:00.000000+00:00',
        links: [
          {
            id: 'l-att',
            kind: 'attachment',
            label: 'Purchase_Contract_signed.pdf',
            members: [{ kind: 'attachment', submissionAttachmentId: 'att-1', submissionMessageId: null }],
          },
        ],
      }),
      item('i-appraisal', 'Appraisal', { isRequired: false }),
      item('i-title', 'Title commitment', {
        links: [
          {
            id: 'l-mail',
            kind: 'email',
            label: 'Title commitment attached',
            members: [{ kind: 'email', submissionAttachmentId: null, submissionMessageId: 'msg-1' }],
          },
          {
            id: 'l-gone',
            kind: 'email',
            label: 'Email not shown on this plan',
            members: [{ kind: 'email', submissionAttachmentId: null, submissionMessageId: 'msg-gated' }],
          },
        ],
      }),
      item('i-amend', 'Amendments and addenda', { isRequired: false, isChecked: true, note: 'Two addenda' }),
    ],
  },
  {
    id: 'hdr-asbestos',
    templateId: 'tpl-asbestos',
    name: 'Asbestos',
    addedAtReviewBy: null,
    addedAtReviewAt: null,
    items: [item('i-asb1', 'Asbestos disclosure', { isChecked: true }), item('i-asb2', 'AHERA inspection report')],
  },
  {
    id: 'hdr-lead',
    templateId: 'tpl-lead',
    name: 'Lead-Based Paint',
    addedAtReviewBy: COLLEAGUE,
    addedAtReviewAt: '2026-09-20T15:12:00.000000+00:00',
    items: [item('i-lead1', 'Lead-Based Paint Disclosure'), item('i-lead2', 'EPA pamphlet acknowledgment')],
  },
];

const MESSAGES = [
  {
    id: 'msg-1',
    channel: 'email',
    direction: 'inbound',
    subject: 'Title commitment attached',
    body_text: 'Please find the commitment attached.',
    sent_at: '2026-09-18T10:00:00.000Z',
    has_attachments: false,
    attachment_count: 0,
    thread_id: null,
    message_type: null,
    participants: { from: 'title@fixture.example.test', from_name: 'Title Fixture Co' },
  },
  {
    id: 'msg-2',
    channel: 'email',
    direction: 'outbound',
    subject: 'Re: Title commitment attached',
    body_text: 'Thanks.',
    sent_at: '2026-09-18T11:00:00.000Z',
    has_attachments: false,
    attachment_count: 0,
    thread_id: null,
    message_type: null,
    participants: { from: 'agent@fixture.example.test', to: ['title@fixture.example.test'] },
  },
];

const ATTACHMENTS = [
  { id: 'att-1', filename: 'Purchase_Contract_signed.pdf', mime_type: 'application/pdf', file_size_bytes: 1200000, storage_path: 'org/sub/a.pdf' },
];

function renderReview(over: Partial<ChecklistReviewProps> = {}) {
  return render(
    <ChecklistReview
      submissionId="sub-1"
      status="under_review"
      sections={SECTIONS}
      names={{ [VIEWER]: 'Viewer Fixture', [COLLEAGUE]: 'Colleague Fixture' }}
      canTick
      templates={[
        { id: 'tpl-contract', name: 'Contract' },
        { id: 'tpl-lead', name: 'Lead-Based Paint' },
        { id: 'tpl-flood', name: 'Flood Zone Disclosure' },
      ]}
      messages={MESSAGES}
      attachments={ATTACHMENTS}
      {...over}
    />
  );
}

const sectionToggle = (name: string) => screen.getByRole('button', { name: new RegExp(`^${name}`) });
const pills = () => screen.queryAllByRole('button', { name: /^(Mark reviewed|Reviewed)$/ });

beforeEach(() => {
  jest.clearAllMocks();
});

describe('required counts (the agent’s ticks)', () => {
  it('shows x of y required per section and overall', () => {
    renderReview();
    expect(sectionToggle('Contract')).toHaveTextContent('2 of 3 required');
    expect(sectionToggle('Asbestos')).toHaveTextContent('1 of 2 required');
    expect(sectionToggle('Lead-Based Paint')).toHaveTextContent('0 of 2 required');
    const header = screen.getByRole('heading', { name: 'Checklists' }).parentElement!;
    expect(header).toHaveTextContent('3 of 7 required');
  });
});

describe('an unchecked required item (founder QA: pill only, no yellow row)', () => {
  it('keeps the Not yet checked pill but the row has no amber/yellow background', () => {
    renderReview();
    fireEvent.click(sectionToggle('Asbestos'));
    const row = screen.getByText('AHERA inspection report').closest('[data-testid="checklist-item"]') as HTMLElement;
    expect(row).not.toBeNull();
    expect(within(row).getByText('Not yet checked')).toBeInTheDocument();
    expect(row.className).not.toMatch(/\bbg-(amber|yellow)-/);
    expect(row.className).not.toMatch(/\bborder-(amber|yellow)-/);
  });
});

describe('reviewer pill (Q7)', () => {
  it('shows only on required and agent-checked rows, never in a checklist added at review', () => {
    renderReview();
    fireEvent.click(screen.getByRole('button', { name: 'Expand all' }));
    const rows = screen.getAllByTestId('checklist-item');
    const withPill = rows
      .filter((r) => within(r).queryByRole('button', { name: /^(Mark reviewed|Reviewed)$/ }))
      .map((r) => r.querySelector('span')!.textContent);
    expect(withPill).toEqual([
      'Buyer representation agreement',
      'Executed purchase contract',
      'Title commitment',
      'Amendments and addenda',
      'Asbestos disclosure',
      'AHERA inspection report',
    ]);
  });

  it('a reviewed row reads Reviewed · who · when', () => {
    renderReview();
    expect(screen.getByRole('button', { name: 'Reviewed' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByTestId('reviewer-meta')).toHaveTextContent('Colleague Fixture · Sep 20, 2026');
  });

  it('ticking calls the action and shows the returned reviewer', async () => {
    mockSetReviewerCheck.mockResolvedValue({
      ok: true,
      changed: true,
      reviewerChecked: true,
      reviewerCheckedBy: VIEWER,
      reviewerCheckedAt: '2026-09-21T09:00:00.000000+00:00',
    });
    renderReview();
    const row = screen.getByText('Buyer representation agreement').closest('[data-testid="checklist-item"]') as HTMLElement;
    fireEvent.click(within(row).getByRole('button', { name: 'Mark reviewed' }));
    await waitFor(() => expect(within(row).getByRole('button', { name: 'Reviewed' })).toBeInTheDocument());
    expect(mockSetReviewerCheck).toHaveBeenCalledWith('sub-1', 'i-buyer', true);
    expect(within(row).getByTestId('reviewer-meta')).toHaveTextContent('Viewer Fixture · Sep 21, 2026');
    expect(mockRefresh).toHaveBeenCalled();
  });

  it('unticking is allowed', async () => {
    mockSetReviewerCheck.mockResolvedValue({
      ok: true,
      changed: true,
      reviewerChecked: false,
      reviewerCheckedBy: null,
      reviewerCheckedAt: null,
    });
    renderReview();
    fireEvent.click(screen.getByRole('button', { name: 'Reviewed' }));
    await waitFor(() => expect(mockSetReviewerCheck).toHaveBeenCalledWith('sub-1', 'i-contract', false));
    await waitFor(() => expect(screen.queryByTestId('reviewer-meta')).not.toBeInTheDocument());
  });

  it('a refused tick shows plain copy, never a code', async () => {
    mockSetReviewerCheck.mockResolvedValue({
      ok: false,
      reason: 'not_open_for_review',
      message: REVIEW_MESSAGES.not_open_for_review,
    });
    renderReview();
    fireEvent.click(pills()[0]);
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(REVIEW_MESSAGES.not_open_for_review);
    expect(alert.textContent).not.toMatch(/42501|not_open_for_review/);
  });

  it('pills are read-only once the review is complete', () => {
    renderReview({ status: 'approved' });
    expect(screen.queryByRole('button', { name: 'Mark reviewed' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Reviewed' })).toBeDisabled();
  });
});

describe('Add checklist', () => {
  it('is enabled while under review', () => {
    renderReview();
    expect(screen.getByRole('button', { name: 'Add checklist' })).toBeEnabled();
    expect(screen.queryByText(ADD_DISABLED_REASON)).not.toBeInTheDocument();
  });

  it('is disabled with a plain reason once changes are requested', () => {
    renderReview({ status: 'needs_changes' });
    expect(screen.getByRole('button', { name: 'Add checklist' })).toBeDisabled();
    expect(screen.getByText(ADD_DISABLED_REASON)).toBeInTheDocument();
    // The ruled copy, as a literal (pm_comments 4b1b1ce8 #1): the constant alone
    // would pass whatever it says.
    expect(
      screen.getByText('Changes were requested, so this version is closed. You can add a checklist to the next submission.')
    ).toBeInTheDocument();
  });

  it('is absent for a viewer who cannot review; Expand/Collapse all stay', () => {
    renderReview({ canTick: false });
    expect(screen.queryByRole('button', { name: 'Add checklist' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Expand all' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Collapse all' })).toBeInTheDocument();
  });

  it('the picker disables checklists already on the submission and adds a new one', async () => {
    mockAddChecklist.mockResolvedValue({ ok: true, status: 'added', checklistId: 'hdr-new' });
    renderReview();
    fireEvent.click(screen.getByRole('button', { name: 'Add checklist' }));
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).queryByRole('button', { name: 'Add Contract' })).not.toBeInTheDocument();
    expect(within(dialog).queryByRole('button', { name: 'Add Lead-Based Paint' })).not.toBeInTheDocument();
    expect(within(dialog).getAllByText('Added')).toHaveLength(2);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add Flood Zone Disclosure' }));
    await waitFor(() => expect(mockAddChecklist).toHaveBeenCalledWith('sub-1', 'tpl-flood'));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(mockRefresh).toHaveBeenCalled();
  });

  it('a checklist that arrives after an add is shown open, others keep their state', () => {
    const { rerender } = renderReview();
    const fresh: ChecklistSectionView = {
      id: 'hdr-flood',
      templateId: 'tpl-flood',
      name: 'Flood Zone Disclosure',
      addedAtReviewBy: VIEWER,
      addedAtReviewAt: '2026-09-21T09:00:00.000000+00:00',
      items: [item('i-flood1', 'Flood zone determination')],
    };
    rerender(
      <ChecklistReview
        submissionId="sub-1"
        status="under_review"
        sections={[...SECTIONS, fresh]}
        names={{ [VIEWER]: 'Viewer Fixture', [COLLEAGUE]: 'Colleague Fixture' }}
        canTick
        templates={[]}
        messages={MESSAGES}
        attachments={ATTACHMENTS}
      />
    );
    expect(sectionToggle('Flood Zone Disclosure')).toHaveAttribute('aria-expanded', 'true');
    expect(sectionToggle('Asbestos')).toHaveAttribute('aria-expanded', 'false');
    const banners = screen.getAllByText(/at review, for the agent’s next version\./).map((el) => el.textContent);
    expect(banners).toContain('Added by Viewer Fixture at review, for the agent’s next version.');
  });

  it('a checklist added at review names who added it and when it applies', () => {
    renderReview();
    expect(screen.getByText(/at review, for the agent’s next version\./)).toHaveTextContent(
      'Added by Colleague Fixture at review, for the agent’s next version.'
    );
  });
});

describe('added-at-review banner: the Request Changes sentence (coordinator ruling, fix round)', () => {
  const SENTENCE = 'Use Request Changes below to send this submission back.';
  const banner = () => screen.getByText(/at review, for the agent’s next version\./);

  it.each(['submitted', 'resubmitted', 'under_review'])(
    'a broker/admin (may decide) on %s sees the sentence',
    (status) => {
      renderReview({ status, canDecide: true });
      expect(banner()).toHaveTextContent(
        `Added by Colleague Fixture at review, for the agent’s next version. ${SENTENCE}`
      );
    }
  );

  it('an it_admin (may tick, may not decide) never sees it', () => {
    renderReview({ status: 'under_review', canDecide: false });
    expect(banner()).toHaveTextContent('Added by Colleague Fixture at review, for the agent’s next version.');
    expect(banner()).not.toHaveTextContent('Request Changes');
  });

  it.each(['needs_changes', 'approved', 'rejected'])(
    'on %s (Request Changes is not offered) nobody sees it',
    (status) => {
      renderReview({ status, canDecide: true });
      expect(banner()).not.toHaveTextContent('Request Changes');
    }
  );
});

describe('Expand all / Collapse all', () => {
  const expand = () => screen.getByRole('button', { name: 'Expand all' });
  const collapse = () => screen.getByRole('button', { name: 'Collapse all' });
  const openStates = () => SECTIONS.map((s) => sectionToggle(s.name).getAttribute('aria-expanded'));

  it('opens and closes every section, disabling the one that would change nothing', () => {
    renderReview();
    // Default: the first checklist and the one added at review are open.
    expect(openStates()).toEqual(['true', 'false', 'true']);
    expect(expand()).toBeEnabled();
    expect(collapse()).toBeEnabled();

    fireEvent.click(collapse());
    expect(openStates()).toEqual(['false', 'false', 'false']);
    expect(collapse()).toBeDisabled();
    expect(expand()).toBeEnabled();

    fireEvent.click(expand());
    expect(openStates()).toEqual(['true', 'true', 'true']);
    expect(expand()).toBeDisabled();
    expect(collapse()).toBeEnabled();

    // Each section's own toggle still works.
    fireEvent.click(sectionToggle('Asbestos'));
    expect(openStates()).toEqual(['true', 'false', 'true']);
    expect(expand()).toBeEnabled();
  });
});

describe('View on chips', () => {
  it('an attachment chip opens the attachment viewer with that attachment', () => {
    renderReview();
    fireEvent.click(screen.getByRole('button', { name: 'View Purchase_Contract_signed.pdf' }));
    expect(screen.getByTestId('attachment-viewer')).toHaveTextContent('Purchase_Contract_signed.pdf');
  });

  it('an email chip opens the conversation viewer on the whole thread', () => {
    renderReview();
    fireEvent.click(screen.getByRole('button', { name: 'View Title commitment attached' }));
    expect(screen.getByText('2 messages')).toBeInTheDocument();
    expect(screen.getByText('Please find the commitment attached.')).toBeInTheDocument();
  });

  it('a chip whose message is not shown on this plan has no View', () => {
    renderReview();
    const chip = screen.getByRole('button', { name: 'Email not shown on this plan (not available to view)' });
    expect(chip).toBeDisabled();
    expect(chip).toHaveTextContent('Not available');
  });
});

/**
 * BACKLOG-3593: the broker page's rendered output is pinned byte for byte.
 * The snapshots were written from the component BEFORE the agent viewer was
 * added (827a4f005), so any change to the default (reviewer) output reds here.
 */
describe('broker output pin (BACKLOG-3593)', () => {
  const statuses = ['under_review', 'needs_changes', 'approved'];
  const matrix: [string, boolean, boolean, boolean][] = [];
  for (const status of statuses)
    for (const canTick of [true, false])
      for (const canDecide of [true, false])
        for (const withNames of [true, false]) matrix.push([status, canTick, canDecide, withNames]);

  it.each(matrix)('status %s, canTick %s, canDecide %s, names %s', (status, canTick, canDecide, withNames) => {
    const { container } = renderReview({
      status,
      canTick,
      canDecide,
      names: withNames ? { [VIEWER]: 'Viewer Fixture', [COLLEAGUE]: 'Colleague Fixture' } : null,
    });
    fireEvent.click(screen.getByRole('button', { name: 'Expand all' }));
    expect(container.innerHTML).toMatchSnapshot();
  });

  it('not loaded', () => {
    const { container } = renderReview({ loaded: false });
    expect(container.innerHTML).toMatchSnapshot();
  });

  it('no checklists', () => {
    const { container } = renderReview({ sections: [] });
    expect(container.innerHTML).toMatchSnapshot();
  });
});

/**
 * BACKLOG-3593: the agent's My Transactions page. Same sections, read only,
 * whatever canTick / canDecide the page passes.
 */
describe('agent viewer (BACKLOG-3593)', () => {
  const renderAgent = (over: Partial<ChecklistReviewProps> = {}) =>
    renderReview({ viewer: 'agent', canTick: true, canDecide: true, ...over });

  it('shows the sections, required counts, notes and Expand/Collapse all', () => {
    renderAgent();
    expect(sectionToggle('Contract')).toHaveTextContent('2 of 3 required');
    expect(sectionToggle('Lead-Based Paint')).toHaveTextContent('0 of 2 required');
    const header = screen.getByRole('heading', { name: 'Checklists' }).parentElement!;
    expect(header).toHaveTextContent('3 of 7 required');
    fireEvent.click(screen.getByRole('button', { name: 'Expand all' }));
    expect(screen.getAllByTestId('checklist-item')).toHaveLength(9);
    expect(screen.getByText('Two addenda')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Collapse all' }));
    expect(screen.queryAllByTestId('checklist-item')).toHaveLength(0);
  });

  it.each(['submitted', 'under_review', 'needs_changes', 'approved'])(
    'status %s: the only controls are section toggles, Expand/Collapse all and View chips',
    (status) => {
      renderAgent({ status });
      fireEvent.click(screen.getByRole('button', { name: 'Expand all' }));
      const names = screen.getAllByRole('button').map((b) => b.getAttribute('aria-label') ?? b.textContent?.trim());
      expect(names.sort()).toEqual(
        [
          'Asbestos1 of 2 required',
          'Collapse all',
          'Contract2 of 3 required',
          'Email not shown on this plan (not available to view)',
          'Expand all',
          'Lead-Based PaintAdded0 of 2 required',
          'View Purchase_Contract_signed.pdf',
          'View Title commitment attached',
        ].sort()
      );
      expect(screen.queryByText('Mark reviewed')).toBeNull();
      expect(screen.queryByText(/Add checklist/)).toBeNull();
      expect(screen.queryByText(ADD_DISABLED_REASON)).toBeNull();
      expect(document.querySelector('[aria-pressed]')).toBeNull();
    }
  );

  it('the reviewer pill is display-only text, with who and when, on reviewed rows only', () => {
    renderAgent();
    fireEvent.click(screen.getByRole('button', { name: 'Expand all' }));
    const status = screen.getAllByTestId('reviewer-status');
    expect(status).toHaveLength(1);
    const row = status[0].closest('[data-testid="checklist-item"]') as HTMLElement;
    expect(within(row).getByText('Executed purchase contract')).toBeInTheDocument();
    expect(within(status[0]).getByText('Reviewed').tagName).toBe('SPAN');
    expect(within(status[0]).queryByRole('button')).toBeNull();
    expect(within(status[0]).getByTestId('reviewer-meta').textContent).toMatch(/^Colleague Fixture · /);
  });

  it('an added-at-review section says who added it, with no call to act', () => {
    renderAgent();
    const banner = screen.getByText(/at review\./).closest('p') as HTMLElement;
    expect(banner.textContent).toBe('Added by Colleague Fixture at review.');
    expect(screen.queryByTestId('added-banner-request-changes')).toBeNull();
    expect(document.body.textContent).not.toMatch(/Request Changes|next version/);
  });

  it('names unavailable: the banner names nobody and nobody is a former member', () => {
    renderAgent({ names: null });
    fireEvent.click(screen.getByRole('button', { name: 'Expand all' }));
    expect(screen.getByText('Added at review.')).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/former member|colleague-id|viewer-id/);
  });

  it('View on a chip opens the existing viewer', () => {
    renderAgent();
    fireEvent.click(screen.getByRole('button', { name: 'View Purchase_Contract_signed.pdf' }));
    expect(screen.getByTestId('attachment-viewer')).toHaveTextContent('Purchase_Contract_signed.pdf');
  });
});
