/**
 * BACKLOG-3748: each photo shows inside its own text bubble in the conversation
 * viewer, instead of "[Media Attachment]".
 *
 * FIXTURE PROVENANCE (every id, name and number invented): shapes from the
 * production join submission_attachments ⋈ submission_messages ON message_id,
 * grouped by mime/channel/type, 2026-10-05 (pm_comments on BACKLOG-3748):
 * mime image/jpeg, image/png, video/quicktime; channel imessage; message_type
 * both 'text' (with a body) and 'attachment_only' (no body); has_attachments
 * true and attachment_count 0 on every row. Attachment row columns as the
 * review page selects them (app/dashboard/submissions/[id]/page.tsx getAttachments,
 * same columns as __tests__/submission-review-3682/page.test.tsx).
 */

import { act, fireEvent, render, screen, within } from '@testing-library/react';

const mockCreateSignedUrl = jest.fn(async (path: string) => ({
  data: { signedUrl: `https://storage.fixture.example.test/${path}` },
  error: null,
}));
jest.mock('@/lib/supabase/client', () => ({
  createClient: () => ({
    storage: { from: () => ({ createSignedUrl: (path: string) => mockCreateSignedUrl(path) }) },
  }),
}));
jest.mock('heic2any', () => jest.fn());
jest.mock('@/components/submission/AttachmentViewerModal', () => ({
  AttachmentViewerModal: ({ attachment, open }: { attachment: { filename: string } | null; open: boolean }) =>
    open && attachment ? <div data-testid="viewer">{attachment.filename}</div> : null,
}));

import { ConversationModal, groupMessagesIntoThreads, type Message } from '@/components/submission/MessageList';
import { groupAttachmentsByMessage } from '@/lib/submissions/attachmentKinds';

const SUB = 'sub-3748';
const M_TEXT = 'msg-text-with-photo'; // 'text' with a body and a photo
const M_PHOTO = 'msg-photo-only'; // 'attachment_only', photo, no body
const M_VIDEO = 'msg-video'; // 'attachment_only', video
const M_OLD = 'msg-old-photo'; // 'attachment_only' from before message_id existed: no linked file
const M_DOC = 'msg-doc'; // 'text' carrying a PDF

const msg = (id: string, sent_at: string, message_type: string, body_text: string | null): Message => ({
  id,
  channel: 'imessage',
  direction: 'inbound',
  subject: null,
  body_text,
  sent_at,
  has_attachments: true,
  attachment_count: 0,
  thread_id: 'thread-1',
  message_type,
  participants: { from: '+14155550101', to: 'me' },
});

const messages: Message[] = [
  msg(M_TEXT, '2026-10-03T16:00:00.000Z', 'text', 'Here is the front of the house'),
  msg(M_PHOTO, '2026-10-03T16:01:00.000Z', 'attachment_only', ''),
  msg(M_VIDEO, '2026-10-03T16:02:00.000Z', 'attachment_only', null),
  msg(M_OLD, '2026-10-03T16:03:00.000Z', 'attachment_only', null),
  msg(M_DOC, '2026-10-03T16:04:00.000Z', 'text', 'Disclosure attached'),
];

const att = (id: string, filename: string, mime_type: string, message_id: string | null) => ({
  id,
  submission_id: SUB,
  filename,
  mime_type,
  file_size_bytes: 204800,
  storage_path: `org-1/${SUB}/${id}/${filename}`,
  document_type: null,
  local_attachment_id: `local-${id}`,
  message_id,
});

// Deliberately NOT in thread order: matching by position would put
// Porch.png on the text message and Front.jpg on the photo-only one.
const attachments = [
  att('a-porch', 'Porch.png', 'image/png', M_PHOTO),
  att('a-front', 'Front.jpg', 'image/jpeg', M_TEXT),
  att('a-walk', 'Walkthrough.mov', 'video/quicktime', M_VIDEO),
  att('a-doc', 'Disclosure.pdf', 'application/pdf', M_DOC),
  att('a-unlinked', 'Old.jpg', 'image/jpeg', null),
];

const ALL = { text: true, email: true };

/** IntersectionObserver stand-in: nothing is on screen until reveal() is called. */
let observed: { cb: IntersectionObserverCallback; nodes: Element[] }[] = [];
class FakeIO {
  private entry: { cb: IntersectionObserverCallback; nodes: Element[] };
  constructor(cb: IntersectionObserverCallback) {
    this.entry = { cb, nodes: [] };
    observed.push(this.entry);
  }
  observe(node: Element) {
    this.entry.nodes.push(node);
  }
  disconnect() {
    this.entry.nodes = [];
  }
  unobserve() {}
  takeRecords() {
    return [];
  }
}
function reveal(node: Element) {
  for (const o of observed) {
    if (o.nodes.includes(node)) {
      o.cb([{ isIntersecting: true, target: node } as unknown as IntersectionObserverEntry], {} as IntersectionObserver);
    }
  }
}

function renderModal(map = groupAttachmentsByMessage(attachments, messages, ALL)) {
  const thread = groupMessagesIntoThreads(messages)[0];
  return render(<ConversationModal thread={thread} onClose={() => {}} attachmentsByMessage={map} />);
}

/** The bubble that holds a message's timestamp row, found by its own text. */
function bubbleOf(id: string): HTMLElement {
  const i = messages.findIndex((m) => m.id === id);
  const bubbles = screen.getAllByText(/Oct 3/).map((n) => n.closest('.rounded-2xl') as HTMLElement);
  return bubbles[i];
}

const ORIGINAL_IO = (global as { IntersectionObserver?: unknown }).IntersectionObserver;
let quiet: jest.SpyInstance;
beforeEach(() => {
  jest.clearAllMocks();
  observed = [];
  (global as { IntersectionObserver?: unknown }).IntersectionObserver = FakeIO;
  quiet = jest.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  (global as { IntersectionObserver?: unknown }).IntersectionObserver = ORIGINAL_IO;
  quiet.mockRestore();
});

describe('groupAttachmentsByMessage (BACKLOG-3748)', () => {
  it('joins on message_id only, ignoring attachment_count, message_type and order', () => {
    const map = groupAttachmentsByMessage(attachments, messages, ALL);
    expect(Object.fromEntries(Object.entries(map).map(([k, v]) => [k, v.map((a) => a.filename)]))).toEqual({
      [M_PHOTO]: ['Porch.png'],
      [M_TEXT]: ['Front.jpg'],
      [M_VIDEO]: ['Walkthrough.mov'],
      [M_DOC]: ['Disclosure.pdf'],
    });
  });

  it('skips a file whose message was not passed in (a gated channel)', () => {
    const map = groupAttachmentsByMessage(attachments, messages.filter((m) => m.id !== M_TEXT), ALL);
    expect(map[M_TEXT]).toBeUndefined();
    expect(map[M_PHOTO]?.map((a) => a.filename)).toEqual(['Porch.png']);
  });

  it('each channel needs its own attachment flag', () => {
    const email = { ...msg('msg-email', '2026-10-03T17:00:00.000Z', 'email', 'x'), channel: 'email' };
    const both = [...attachments, att('a-email', 'Contract.pdf', 'application/pdf', 'msg-email')];
    const all = [...messages, email];
    expect(Object.keys(groupAttachmentsByMessage(both, all, { text: false, email: true }))).toEqual(['msg-email']);
    expect(Object.keys(groupAttachmentsByMessage(both, all, { text: true, email: false })).sort()).toEqual(
      [M_DOC, M_PHOTO, M_TEXT, M_VIDEO].sort()
    );
  });
});

describe('ConversationModal inline photos (BACKLOG-3748)', () => {
  it('shows each photo inside its own bubble, above the text', () => {
    renderModal();
    const text = bubbleOf(M_TEXT);
    const photo = within(text).getByRole('button', { name: 'Front.jpg' });
    expect(within(text).queryByRole('button', { name: 'Porch.png' })).toBeNull();
    const body = within(text).getByText('Here is the front of the house');
    // photo precedes the text in document order
    expect(photo.compareDocumentPosition(body) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    const only = bubbleOf(M_PHOTO);
    expect(within(only).getByRole('button', { name: 'Porch.png' })).toBeTruthy();
    expect(within(only).queryByRole('button', { name: 'Front.jpg' })).toBeNull();
  });

  it('no "[Media Attachment]" where a file shows; an older row with no linked file keeps it', () => {
    renderModal();
    expect(within(bubbleOf(M_PHOTO)).queryByText(/Media Attachment/)).toBeNull();
    expect(within(bubbleOf(M_VIDEO)).queryByText(/Media Attachment/)).toBeNull();
    // and no other placeholder line takes its place
    expect(within(bubbleOf(M_PHOTO)).queryByText(/\[No content\]|\[Media Attachment\]/)).toBeNull();
    expect(within(bubbleOf(M_VIDEO)).queryByText(/\[No content\]|\[Media Attachment\]/)).toBeNull();
    expect(within(bubbleOf(M_OLD)).getByText('[Media Attachment]')).toBeTruthy();
  });

  it('the paperclip shows the files actually shown (attachment_count is 0 on real rows)', () => {
    renderModal();
    expect(within(bubbleOf(M_PHOTO)).getByText('1')).toBeTruthy();
  });

  it('video is a play tile and a PDF a chip; neither is signed in the bubble', async () => {
    renderModal();
    expect(within(bubbleOf(M_VIDEO)).getByTestId('inline-video').getAttribute('aria-label')).toBe('Walkthrough.mov');
    const chip = within(bubbleOf(M_DOC)).getByTestId('inline-file');
    expect(chip.textContent).toBe('Disclosure.pdf');
    for (const o of observed) for (const n of [...o.nodes]) await act(async () => reveal(n));
    const signed = mockCreateSignedUrl.mock.calls.map(([p]) => p);
    expect(signed.some((p) => p.includes('Walkthrough') || p.includes('Disclosure'))).toBe(false);
  });

  it('signs a photo only when its tile scrolls into view', async () => {
    renderModal();
    expect(mockCreateSignedUrl).not.toHaveBeenCalled();
    const front = within(bubbleOf(M_TEXT)).getByRole('button', { name: 'Front.jpg' });
    await act(async () => reveal(front));
    expect(mockCreateSignedUrl.mock.calls.map(([p]) => p)).toEqual([`org-1/${SUB}/a-front/Front.jpg`]);
    const img = within(front).getByRole('img', { name: 'Front.jpg' });
    expect(img.getAttribute('src')).toBe(`https://storage.fixture.example.test/org-1/${SUB}/a-front/Front.jpg`);
  });

  it('a photo that fails to load says so', async () => {
    renderModal();
    const front = within(bubbleOf(M_TEXT)).getByRole('button', { name: 'Front.jpg' });
    await act(async () => reveal(front));
    fireEvent.error(within(front).getByRole('img'));
    expect(within(front).getByText("Photo couldn't be loaded")).toBeTruthy();
  });

  it('a photo whose URL cannot be signed says so', async () => {
    mockCreateSignedUrl.mockResolvedValueOnce({ data: null, error: new Error('denied') } as never);
    renderModal();
    const porch = within(bubbleOf(M_PHOTO)).getByRole('button', { name: 'Porch.png' });
    await act(async () => reveal(porch));
    expect(within(porch).getByText("Photo couldn't be loaded")).toBeTruthy();
  });

  it('a HEIC photo is converted to JPEG before it shows, as in the Attachments list', async () => {
    const heic2any = jest.requireMock('heic2any') as jest.Mock;
    const jpeg = new Blob(['jpeg']);
    heic2any.mockResolvedValueOnce(jpeg);
    const origFetch = global.fetch;
    const origCreate = URL.createObjectURL;
    const origRevoke = URL.revokeObjectURL;
    global.fetch = jest.fn(async () => ({ blob: async () => new Blob(['heic']) })) as never;
    URL.createObjectURL = jest.fn(() => 'blob:fixture-heic');
    URL.revokeObjectURL = jest.fn();
    try {
      const heicMsg = msg('msg-heic', '2026-10-03T16:05:00.000Z', 'attachment_only', null);
      const map = groupAttachmentsByMessage([att('a-heic', 'IMG_0001.HEIC', 'image/heic', 'msg-heic')], [heicMsg], ALL);
      const thread = groupMessagesIntoThreads([heicMsg])[0];
      const { unmount } = render(<ConversationModal thread={thread} onClose={() => {}} attachmentsByMessage={map} />);
      const tile = screen.getByRole('button', { name: 'IMG_0001.HEIC' });
      await act(async () => reveal(tile));
      expect(heic2any).toHaveBeenCalledWith(expect.objectContaining({ toType: 'image/jpeg' }));
      expect(within(tile).getByRole('img').getAttribute('src')).toBe('blob:fixture-heic');
      unmount();
      expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:fixture-heic');
    } finally {
      global.fetch = origFetch;
      URL.createObjectURL = origCreate;
      URL.revokeObjectURL = origRevoke;
    }
  });

  it('clicking a photo opens the attachment viewer on that file; the conversation stays open', () => {
    renderModal();
    fireEvent.click(within(bubbleOf(M_PHOTO)).getByRole('button', { name: 'Porch.png' }));
    expect(screen.getByTestId('viewer').textContent).toBe('Porch.png');
    expect(screen.getByText('Here is the front of the house')).toBeTruthy();
  });

  it('without attachmentsByMessage the viewer renders exactly as before', () => {
    const thread = groupMessagesIntoThreads(messages)[0];
    render(<ConversationModal thread={thread} onClose={() => {}} />);
    expect(screen.queryAllByTestId('inline-attachments')).toEqual([]);
    expect(screen.getAllByText('[Media Attachment]')).toHaveLength(3);
  });
});
