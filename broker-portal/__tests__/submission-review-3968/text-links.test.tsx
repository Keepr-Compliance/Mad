/**
 * Checklist links to texts in the broker portal — BACKLOG-3968 PR-5.
 *
 * FIXTURE PROVENANCE (every id and name invented):
 *   - Link / member rows: the shape lib/submissions/checklists.ts assembles from
 *     submission_checklist_links / _link_members (kind 'text' added by
 *     supabase/migrations/20261031230000_backlog_3968_checklist_text_links.sql).
 *   - The text message row: the desktop uploader's text mapping
 *     (electron/services/submissionService.ts: channel = messages.channel || 'email',
 *     message_type = messages.message_type || 'text').
 *   - The remove history entry: remove_submission_checklist_at_review in the
 *     same migration, keys linked_documents, linked_emails, linked_texts.
 */
import { fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';

jest.mock('next/navigation', () => ({ useRouter: () => ({ refresh: jest.fn() }) }));
jest.mock('@/lib/actions/submissionChecklists', () => ({
  setReviewerCheck: jest.fn(),
  addChecklistAtReview: jest.fn(),
  removeChecklistAtReview: jest.fn(),
  restoreChecklistAtReview: jest.fn(),
}));
jest.mock('@/components/submission/AttachmentViewerModal', () => ({ AttachmentViewerModal: () => null }));
jest.mock('@/components/submission/MessageList', () => ({
  ...jest.requireActual('@/components/submission/MessageList'),
  ConversationModal: ({ thread }: { thread: { messages: { id: string }[] } }) => (
    <div data-testid="conversation">{thread.messages.map((m) => m.id).join(',')}</div>
  ),
}));

import { ChecklistReview, linkChipIcon, removeConfirmText, type ChecklistReviewProps } from '@/components/submission/ChecklistReview';
import { linkedEvidenceCounts, type ChecklistItemView, type ChecklistSectionView } from '@/lib/submissions/checklistModel';
import { describeTypedEntry, linkedPhrase, type StatusHistoryEntry } from '@/lib/submissions/history';
import type { Message } from '@/components/submission/MessageList';

const item = (id: string, links: ChecklistItemView['links']): ChecklistItemView => ({
  id,
  title: `Item ${id}`,
  description: null,
  isRequired: true,
  isChecked: false,
  note: null,
  reviewerChecked: false,
  reviewerCheckedBy: null,
  reviewerCheckedAt: null,
  clearedReviewerId: null,
  clearedAt: null,
  links,
} as ChecklistItemView);

const link = (id: string, kind: string, label: string, msgIds: string[], attIds: string[] = []) => ({
  id,
  kind,
  label,
  members: [
    ...attIds.map((a) => ({ kind, submissionAttachmentId: a, submissionMessageId: null })),
    ...msgIds.map((m) => ({ kind, submissionAttachmentId: null, submissionMessageId: m })),
  ],
});

const SECTION: ChecklistSectionView = {
  id: 'hdr-1',
  templateId: null,
  name: 'Purchase Contract',
  addedAtReviewBy: null,
  addedAtReviewAt: null,
  removedAtReviewBy: null,
  removedAtReviewAt: null,
  restoredFromChecklistId: null,
  items: [
    item('i-1', [link('l-email', 'email', 'Re: inspection', ['msg-email'])]),
    item('i-2', [link('l-text', 'text', 'Text · Sam Seller · Oct 3', ['msg-text-1', 'msg-text-2'])]),
    item('i-3', [link('l-doc', 'attachment', 'contract.pdf', [], ['att-1'])]),
  ],
} as ChecklistSectionView;

const textRow = (id: string, sent: string): Message => ({
  id,
  channel: 'sms',
  direction: 'inbound',
  subject: null,
  body_text: 'see you at 3',
  sent_at: sent,
  has_attachments: false,
  attachment_count: 0,
  thread_id: 'thread-text',
  message_type: 'text',
  participants: { from: 'handle-a', chat_members: ['handle-a'] },
});

function renderReview(over: Partial<ChecklistReviewProps> = {}) {
  const props: ChecklistReviewProps = {
    submissionId: 'sub-1',
    status: 'under_review',
    sections: [SECTION],
    names: {},
    canTick: true,
    canDecide: true,
    templates: [],
    messages: [textRow('msg-text-1', '2026-10-03T10:00:00Z'), textRow('msg-text-2', '2026-10-03T10:05:00Z')],
    attachments: [],
    version: 1,
    versionHistory: [],
    ...over,
  } as ChecklistReviewProps;
  return render(<ChecklistReview {...props} />);
}

describe('text link chip (BACKLOG-3968)', () => {
  it('icon per kind: a text is not drawn as an email or a file', () => {
    expect(linkChipIcon('text').Icon).not.toBe(linkChipIcon('email').Icon);
    expect(linkChipIcon('text').Icon).not.toBe(linkChipIcon('attachment').Icon);
    expect(linkChipIcon('text').iconClass).not.toBe(linkChipIcon('email').iconClass);
  });

  it('renders a text link with the text icon and opens its conversation', () => {
    renderReview();
    const chip = screen.getByRole('button', { name: 'View Text · Sam Seller · Oct 3' });
    // lucide draws each icon with its own class: lucide-message-square / lucide-mail / lucide-file-text.
    expect(chip.querySelector('svg.lucide-message-square')).not.toBeNull();
    expect(chip.querySelector('svg.lucide-mail')).toBeNull();
    expect(chip.querySelector('svg.lucide-file-text')).toBeNull();
    expect(chip.querySelector('svg.text-emerald-600')).not.toBeNull();
    const email = screen.getByRole('button', { name: 'Re: inspection (not available to view)' });
    expect(email.querySelector('svg.lucide-mail')).not.toBeNull();
    fireEvent.click(chip);
    expect(screen.getByTestId('conversation')).toHaveTextContent('msg-text-1');
  });
});

describe('linked counts include texts', () => {
  it('a text member counts as a text, not an email', () => {
    const localByMsg = new Map<string, string | null>([
      ['msg-email', 'E-1'],
      ['msg-text-1', 'T-1'],
      ['msg-text-2', 'T-2'],
    ]);
    const localByAtt = new Map<string, string | null>([['att-1', 'A-1']]);
    expect(linkedEvidenceCounts(SECTION, localByAtt, localByMsg)).toEqual({ documents: 1, emails: 1, texts: 2 });
  });

  it.each([
    [{ documents: 0, emails: 0, texts: 1 }, '1 text is linked to it. It stays on the deal; the checklist and its links are removed.'],
    [{ documents: 1, emails: 2, texts: 3 }, '1 document, 2 emails and 3 texts are linked to it. They stay on the deal; the checklist and its links are removed.'],
    [{ documents: 0, emails: 1, texts: 1 }, '1 email and 1 text are linked to it. They stay on the deal; the checklist and its links are removed.'],
    [{ documents: 0, emails: 0 }, 'No documents or emails are linked to it. The checklist is removed.'],
  ])('confirm copy for %j', (counts, text) => {
    expect(removeConfirmText(counts)).toBe(text);
  });

  it('linkedPhrase keeps the two-part wording and adds texts', () => {
    expect(linkedPhrase(3, 2)).toBe('3 documents and 2 emails');
    expect(linkedPhrase(0, 0, 2)).toBe('2 texts');
    expect(linkedPhrase(1, 0, 1)).toBe('1 document and 1 text');
  });

  it('the remove history line names linked texts', () => {
    const entry = {
      type: 'checklist_removed',
      changed_at: '2026-10-31T10:00:00Z',
      changed_by: 'broker-id',
      source: 'review',
      checklist_id: 'hdr-1',
      checklist_key: 'name:Purchase Contract',

      checklist_name: 'Purchase Contract',
      linked_documents: 0,
      linked_emails: 1,
      linked_texts: 2,
    } as StatusHistoryEntry;
    expect(describeTypedEntry(entry)).toBe('Checklist removed: Purchase Contract (1 email and 2 texts linked)');
  });
});
