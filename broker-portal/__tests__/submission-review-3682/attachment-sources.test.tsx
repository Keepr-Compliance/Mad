/**
 * BACKLOG-3682: each attachment's date, sender and source message, and the
 * "not included by the agent" notice.
 *
 * FIXTURE PROVENANCE (every id, name and number invented):
 * - submission_messages.participants shapes: sms inbound {from,to,to_names},
 *   sms outbound {from,from_name,to,to_names} (production, pm_comments f745183e);
 *   email {from: <raw sender>, to: string[]} from mapEmailToSubmissionMessage
 *   (electron/services/submissionService.ts, PR #2797 @ cede03a5d).
 * - submission_attachments.message_id = the minted submission_messages.id
 *   (PR #2797 submissionService.ts:897-909), null on every older row.
 * - submission_metadata.excluded_files entries = ExcludedFileRecord
 *   {filename|null, kind, message_id|null, sent_at|null, source_label, reason}
 *   (PR #2797 submissionService.ts:349-357, 914-921); reasons from
 *   submissionPreflight.ts:38-42.
 */

import { render, screen, within } from '@testing-library/react';

jest.mock('@/lib/supabase/client', () => ({
  createClient: () => ({
    storage: { from: () => ({ createSignedUrl: async () => ({ data: { signedUrl: 'about:blank' }, error: null }) }) },
  }),
}));
jest.mock('heic2any', () => jest.fn());
jest.mock('@/components/submission/AttachmentViewerModal', () => ({ AttachmentViewerModal: () => null }));

import { AttachmentList } from '@/components/submission/AttachmentList';
import { ExcludedFilesNotice } from '@/components/submission/ExcludedFilesNotice';
import {
  buildAttachmentSources,
  readExcludedFiles,
  type SourceMessage,
} from '@/lib/submissions/attachmentSources';

const EMAIL_ID = 'msg-email-1';
const SMS_IN_ID = 'msg-sms-in';
const SMS_OUT_ID = 'msg-sms-out';

const messages: SourceMessage[] = [
  {
    id: EMAIL_ID,
    channel: 'email',
    direction: 'inbound',
    subject: 'Signed contract',
    sent_at: '2026-10-02T22:15:00.000Z',
    participants: { from: 'Avery Example <jane@fixture.example.test>', to: ['agent@fixture.example.test'] },
  },
  {
    id: SMS_IN_ID,
    channel: 'sms',
    direction: 'inbound',
    subject: null,
    sent_at: '2026-10-03T16:05:00.000Z',
    participants: { from: '+14155550101', to: 'me' },
  },
  {
    id: SMS_OUT_ID,
    channel: 'sms',
    direction: 'outbound',
    subject: null,
    sent_at: '2026-10-03T16:00:00.000Z',
    participants: { from: 'me', from_name: 'Robin Marsh', to: '+14155550101', to_names: { '+14155550101': 'Gina Example' } },
  },
];

const doc = (id: string, filename: string, message_id: string | null | undefined) => ({
  id,
  filename,
  mime_type: 'application/pdf',
  file_size_bytes: 2048,
  storage_path: null,
  document_type: null,
  ...(message_id === undefined ? {} : { message_id }),
});

describe('buildAttachmentSources', () => {
  it('joins message_id to the message: email sender name and subject, inbound text sender named from another message', () => {
    const sources = buildAttachmentSources(
      [doc('a1', 'Contract.pdf', EMAIL_ID), doc('a2', 'Photo.pdf', SMS_IN_ID), doc('a3', 'Out.pdf', SMS_OUT_ID)],
      messages
    );
    expect(sources).toEqual({
      a1: { sentAt: '2026-10-02T22:15:00.000Z', sender: 'Avery Example', source: 'Email "Signed contract"' },
      a2: { sentAt: '2026-10-03T16:05:00.000Z', sender: 'Gina Example', source: 'Text' },
      a3: { sentAt: '2026-10-03T16:00:00.000Z', sender: 'Robin Marsh', source: 'Text' },
    });
  });

  it('old rows (no message_id, null, or a message not passed in) get no source', () => {
    const sources = buildAttachmentSources(
      [doc('a1', 'Old.pdf', undefined), doc('a2', 'Null.pdf', null), doc('a3', 'Gated.pdf', 'not-in-list')],
      messages
    );
    expect(sources).toEqual({});
  });
});

describe('readExcludedFiles', () => {
  it.each([
    [null],
    [undefined],
    [{}],
    [{ excluded_files: null }],
    [{ excluded_files: 'x' }],
    [{ excluded_files: {} }],
    ['string'],
    [42],
  ])('returns [] for %p', (metadata) => {
    expect(readExcludedFiles(metadata)).toEqual([]);
  });

  it('keeps valid entries, drops junk, fills missing strings', () => {
    expect(
      readExcludedFiles({
        excluded_files: [
          { filename: 'Video.mov', kind: 'email', message_id: EMAIL_ID, sent_at: '2026-10-03T15:00:00.000Z', source_label: 'Photos', reason: 'file_too_large' },
          { filename: null, kind: 'text', message_id: null, sent_at: null, source_label: '', reason: 'text_attachment_not_on_this_computer' },
          { filename: 'Bad.pdf', kind: 'fax', reason: 'file_too_large' },
          null,
          'junk',
        ],
      })
    ).toEqual([
      { filename: 'Video.mov', kind: 'email', message_id: EMAIL_ID, sent_at: '2026-10-03T15:00:00.000Z', source_label: 'Photos', reason: 'file_too_large' },
      { filename: null, kind: 'text', message_id: null, sent_at: null, source_label: '', reason: 'text_attachment_not_on_this_computer' },
    ]);
  });
});

describe('AttachmentList source line', () => {
  it('shows date, sender and source under a linked file', () => {
    const attachments = [doc('a1', 'Contract.pdf', EMAIL_ID)];
    render(<AttachmentList attachments={attachments} sources={buildAttachmentSources(attachments, messages)} />);
    // jest.config sets TZ=America/Los_Angeles: 22:15Z on 2 Oct is 3:15 PM.
    expect(screen.getByTestId('attachment-source').textContent).toBe(
      'Oct 2, 2026, 3:15 PM · From Avery Example · Email "Signed contract"'
    );
  });

  it('renders an old submission exactly as before: no source line, filename and size intact', () => {
    render(<AttachmentList attachments={[doc('a1', 'Contract.pdf', undefined)]} sources={{}} />);
    expect(screen.queryByTestId('attachment-source')).toBeNull();
    expect(screen.getByText('Contract.pdf')).toBeTruthy();
    expect(screen.getByText('2.0 KB')).toBeTruthy();
  });

  it('renders without the sources prop at all (the my-transactions page)', () => {
    render(<AttachmentList attachments={[doc('a1', 'Contract.pdf', EMAIL_ID)]} />);
    expect(screen.queryByTestId('attachment-source')).toBeNull();
  });

  it('a hostile filename, subject and sender stay text', () => {
    const hostile: SourceMessage = {
      id: 'h1',
      channel: 'email',
      direction: 'inbound',
      subject: '<img src=x onerror="window.__pwned=1">',
      sent_at: '2026-10-02T22:15:00.000Z',
      participants: { from: '<script>window.__pwned=2</script>' },
    };
    const attachments = [doc('a1', '<b id="inj">x</b>.pdf', 'h1')];
    const { container } = render(
      <AttachmentList attachments={attachments} sources={buildAttachmentSources(attachments, [hostile])} />
    );
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('script')).toBeNull();
    expect(container.querySelector('#inj')).toBeNull();
    expect(screen.getByTestId('attachment-source').textContent).toContain('<img src=x onerror="window.__pwned=1">');
    expect(screen.getByText('<b id="inj">x</b>.pdf')).toBeTruthy();
  });
});

describe('ExcludedFilesNotice', () => {
  const files = readExcludedFiles({
    excluded_files: [
      { filename: 'Video.mov', kind: 'email', message_id: EMAIL_ID, sent_at: '2026-10-03T15:00:00.000Z', source_label: 'Photos', reason: 'file_too_large' },
      { filename: null, kind: 'text', message_id: SMS_IN_ID, sent_at: null, source_label: 'Gina Example', reason: 'text_attachment_not_on_this_computer' },
    ],
  });

  it('lists name, source message and reason under the heading', () => {
    render(<ExcludedFilesNotice files={files} showTextLabels showEmailLabels />);
    const notice = screen.getByTestId('excluded-files-notice');
    expect(within(notice).getByText('These files were not included by the agent:')).toBeTruthy();
    const items = within(notice).getAllByTestId('excluded-file').map((li) => li.textContent);
    expect(items).toEqual([
      'Video.movEmail "Photos", Oct 3, 2026, 8:00 AMLarger than 50 MB',
      "A photo or fileText with Gina ExampleWasn't downloaded to the agent's computer",
    ]);
  });

  it('drops the label of a channel the broker cannot see', () => {
    render(<ExcludedFilesNotice files={files} showTextLabels={false} showEmailLabels />);
    const items = screen.getAllByTestId('excluded-file').map((li) => li.textContent);
    expect(items[1]).toBe("A photo or fileA textWasn't downloaded to the agent's computer");
    expect(screen.queryByText(/Gina Example/)).toBeNull();
  });

  it('with email view off, drops the email subject but keeps the text label', () => {
    render(<ExcludedFilesNotice files={files} showTextLabels showEmailLabels={false} />);
    const items = screen.getAllByTestId('excluded-file').map((li) => li.textContent);
    expect(items[0]).toBe('Video.movAn email, Oct 3, 2026, 8:00 AMLarger than 50 MB');
    expect(screen.queryByText(/Photos/)).toBeNull();
    expect(items[1]).toBe("A photo or fileText with Gina ExampleWasn't downloaded to the agent's computer");
  });

  it('renders nothing when the list is empty', () => {
    const { container } = render(<ExcludedFilesNotice files={[]} showTextLabels showEmailLabels />);
    expect(container.innerHTML).toBe('');
  });

  it('a hostile filename and label stay text', () => {
    const hostile = readExcludedFiles({
      excluded_files: [
        { filename: '<img src=x onerror=alert(1)>', kind: 'email', message_id: null, sent_at: null, source_label: '<script>x()</script>', reason: '<b>r</b>' },
      ],
    });
    const { container } = render(<ExcludedFilesNotice files={hostile} showTextLabels showEmailLabels />);
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('script')).toBeNull();
    expect(container.querySelector('b')).toBeNull();
    expect(screen.getByText('<img src=x onerror=alert(1)>')).toBeTruthy();
    expect(screen.getByText('Email "<script>x()</script>"')).toBeTruthy();
    expect(screen.getByText('Not sent')).toBeTruthy();
  });
});
