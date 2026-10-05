/**
 * BACKLOG-3748 (follow-up): the paperclip badge must not show on a
 * link-preview text. Apple sets `has_attachments=true` on those rows while
 * `attachment_count` stays 0 — the bug the founder saw in the broker portal's
 * text review (the founder's own submission had exactly this: 3 link texts
 * with has_attachments=true, attachment_count=0, no row in
 * submission_attachments).
 *
 * FIXTURE PROVENANCE: row shapes follow __tests__/submission-review-3748/inline-photos.test.tsx
 * (production join submission_attachments JOIN submission_messages ON message_id),
 * same has_attachments=true/attachment_count=0 combination on every imessage
 * row including real-photo rows. Ids/names/dates are invented.
 */

import { render, screen, within } from '@testing-library/react';

jest.mock('@/lib/supabase/client', () => ({
  createClient: () => ({
    storage: { from: () => ({ createSignedUrl: async () => ({ data: { signedUrl: 'https://fixture.test/x' }, error: null }) }) },
  }),
}));
jest.mock('heic2any', () => jest.fn());
jest.mock('@/components/submission/AttachmentViewerModal', () => ({
  AttachmentViewerModal: () => null,
}));

import { ConversationModal, groupMessagesIntoThreads, type Message } from '@/components/submission/MessageList';
import { groupAttachmentsByMessage } from '@/lib/submissions/attachmentKinds';

const SUB = 'sub-3748z';

function message(overrides: Partial<Message> & { id: string }): Message {
  return {
    channel: 'imessage',
    direction: 'inbound',
    subject: null,
    body_text: null,
    sent_at: '2026-10-04T10:00:00.000Z',
    has_attachments: false,
    attachment_count: 0,
    thread_id: 'thread-z',
    message_type: 'text',
    participants: { from: '+14155550102', to: 'me' },
    ...overrides,
  };
}

function attachmentRow(id: string, filename: string, message_id: string) {
  return {
    id,
    submission_id: SUB,
    filename,
    mime_type: 'image/jpeg',
    file_size_bytes: 100000,
    storage_path: `org-1/${SUB}/${id}/${filename}`,
    document_type: null,
    local_attachment_id: `local-${id}`,
    message_id,
  };
}

function bubbleOf(bodyText: string): HTMLElement {
  return screen.getByText(bodyText).closest('.rounded-2xl') as HTMLElement;
}

let quiet: jest.SpyInstance;
beforeEach(() => {
  quiet = jest.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  quiet.mockRestore();
});

describe('BACKLOG-3748: paperclip hidden unless a real attachment exists', () => {
  it('a link-preview text (has_attachments true, count 0, no row) shows no paperclip', () => {
    const link = message({
      id: 'msg-link',
      body_text: 'Check this out: https://example.test/listing',
      has_attachments: true,
      attachment_count: 0,
    });
    const thread = groupMessagesIntoThreads([link])[0];
    render(<ConversationModal thread={thread} onClose={() => {}} />);

    const bubble = bubbleOf('Check this out: https://example.test/listing');
    // No Paperclip icon (svg) and no stray "0" badge in this bubble.
    expect(bubble.querySelectorAll('svg').length).toBe(0);
    expect(within(bubble).queryByText('0')).toBeNull();
  });

  it('a photo text with a matched attachment row shows the paperclip with the real count', () => {
    const photo = message({
      id: 'msg-real-photo',
      message_type: 'attachment_only',
      has_attachments: true,
      attachment_count: 0, // real row; attachment_count is 0 here too, per production shape
    });
    const row = attachmentRow('a-real-photo', 'House.jpg', photo.id);
    const map = groupAttachmentsByMessage([row], [photo], true);
    const thread = groupMessagesIntoThreads([photo], map)[0];
    render(<ConversationModal thread={thread} onClose={() => {}} attachmentsByMessage={map} />);

    const bubble = screen.getByRole('button', { name: 'House.jpg' }).closest('.rounded-2xl') as HTMLElement;
    expect(within(bubble).getByText('1')).toBeTruthy();
  });

  it('falls back to attachment_count when no attachmentsByMessage row exists for this message', () => {
    // Mirrors app/dashboard/my-transactions/[id]/page.tsx, which renders
    // <MessageList messages={...} /> with no attachmentsByMessage map at all.
    const real = message({
      id: 'msg-real-no-map',
      body_text: 'See attached disclosure',
      has_attachments: true,
      attachment_count: 2,
    });
    const thread = groupMessagesIntoThreads([real])[0];
    render(<ConversationModal thread={thread} onClose={() => {}} />);

    const bubble = bubbleOf('See attached disclosure');
    expect(within(bubble).getByText('2')).toBeTruthy();
  });

  it('the thread total excludes link-only texts and counts only real attachments', () => {
    const link1 = message({ id: 'msg-link-1', body_text: 'link one', has_attachments: true, attachment_count: 0, sent_at: '2026-10-04T10:00:00.000Z' });
    const link2 = message({ id: 'msg-link-2', body_text: 'link two', has_attachments: true, attachment_count: 0, sent_at: '2026-10-04T10:01:00.000Z' });
    const link3 = message({ id: 'msg-link-3', body_text: 'link three', has_attachments: true, attachment_count: 0, sent_at: '2026-10-04T10:02:00.000Z' });
    const photo = message({ id: 'msg-real-photo-2', message_type: 'attachment_only', has_attachments: true, attachment_count: 0, sent_at: '2026-10-04T10:03:00.000Z' });
    const row = attachmentRow('a-real-photo-2', 'House2.jpg', photo.id);
    const all = [link1, link2, link3, photo];
    const map = groupAttachmentsByMessage([row], all, true);

    expect(groupMessagesIntoThreads(all, map)[0].totalAttachments).toBe(1);
    // Without the map, every attachment_count in this fixture (including the
    // real photo row) is 0 -- the total must still not claim credit for the
    // 3 link texts, i.e. it stays at 0 rather than ever counting them in.
    expect(groupMessagesIntoThreads(all)[0].totalAttachments).toBe(0);
  });
});
