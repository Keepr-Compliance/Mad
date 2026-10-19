/**
 * @jest-environment node
 *
 * BACKLOG-3974: the individual download-invite email
 *   1. names the invited address in step 2 (HTML escaped, plain text as-is);
 *   2. carries no trial wording anywhere (HTML, preheader, plain text);
 *   3. sends the invitee's name as the To display name, end to end from the
 *      route body to the Graph sendMail payload.
 * Addresses and names are invented.
 */

const mockPost = jest.fn();
const mockApi = jest.fn(() => ({ post: mockPost }));

jest.mock('@azure/identity', () => ({ ClientSecretCredential: jest.fn() }));
jest.mock('@microsoft/microsoft-graph-client', () => ({
  Client: { initWithMiddleware: jest.fn(() => ({ api: mockApi })) },
}));
jest.mock('@microsoft/microsoft-graph-client/authProviders/azureTokenCredentials', () => ({
  TokenCredentialAuthenticationProvider: jest.fn(),
}));

import { NextRequest } from 'next/server';
import { buildDownloadInviteEmail } from '../../../lib/email/templates/download-invite';
import { sendEmail } from '../../../lib/email/send-email';
import { resetGraphClient } from '../../../lib/email/graph-client';
import { POST } from '../../../app/api/email/send-download-invite/route';

const ORIGINAL_ENV = process.env;
const INVITEE = 'invitee@fixture.example.test';
const INVITEE_NAME = 'Pat Example';

function sentRecipients(): unknown {
  expect(mockPost).toHaveBeenCalledTimes(1);
  const calls = mockPost.mock.calls as unknown as Array<[{ message: { toRecipients: unknown } }]>;
  return calls[0][0].message.toRecipients;
}

beforeEach(() => {
  jest.clearAllMocks();
  resetGraphClient();
  process.env = {
    ...ORIGINAL_ENV,
    AZURE_TENANT_ID: 'test-tenant',
    AZURE_CLIENT_ID: 'test-client',
    AZURE_CLIENT_SECRET: 'test-secret',
    EMAIL_SENDER_ADDRESS: 'noreply@test.com',
    INTERNAL_API_SECRET: 'test-internal-secret',
  };
  mockPost.mockResolvedValue(undefined);
});

afterAll(() => {
  process.env = ORIGINAL_ENV;
});

describe('step 2 names the invited address', () => {
  it('HTML: "Sign in with <strong>address</strong>."', () => {
    const { html } = buildDownloadInviteEmail({ recipientEmail: INVITEE });
    expect(html).toContain(`Sign in with <strong>${INVITEE}</strong>.`);
    expect(html).not.toContain('this email address</strong>');
  });

  it('plain text: "2. Sign in with address."', () => {
    const { text } = buildDownloadInviteEmail({ recipientEmail: INVITEE });
    expect(text.split('\n')).toContain(`  2. Sign in with ${INVITEE}.`);
  });

  it('escapes markup in the address (quoted local parts may contain it)', () => {
    const hostile = '"<b>x</b>"@fixture.example.test';
    const { html } = buildDownloadInviteEmail({ recipientEmail: hostile });
    expect(html).not.toContain('<b>x</b>');
    expect(html).toContain('&quot;&lt;b&gt;x&lt;/b&gt;&quot;@fixture.example.test');
  });

  it('has two steps, and the last one ends the list', () => {
    const { text } = buildDownloadInviteEmail({ recipientEmail: INVITEE });
    const steps = text.split('\n').filter((l) => /^\s+\d\.\s/.test(l));
    expect(steps.map((l) => l.trim().slice(0, 2))).toEqual(['1.', '2.']);
  });
});

describe('no trial wording', () => {
  it('in the HTML (including the preheader) or the plain text', () => {
    const { html, text } = buildDownloadInviteEmail({ recipientEmail: INVITEE });
    expect(html).not.toMatch(/trial|14-day/i);
    expect(text).not.toMatch(/trial|14-day/i);
    expect(html).toContain('Download Keepr and sign in with this email address to get started.');
  });
});

describe('To display name', () => {
  it('sendEmail sends { address, name } when toName is set', async () => {
    await sendEmail({ to: INVITEE, toName: INVITEE_NAME, subject: 's', html: '<p>h</p>', text: 't' });
    expect(sentRecipients()).toEqual([{ emailAddress: { address: INVITEE, name: INVITEE_NAME } }]);
  });

  it('sendEmail sends { address } only when toName is blank', async () => {
    await sendEmail({ to: INVITEE, toName: '   ', subject: 's', html: '<p>h</p>', text: 't' });
    expect(sentRecipients()).toEqual([{ emailAddress: { address: INVITEE } }]);
  });

  it('collapses line breaks and control characters in the name', async () => {
    await sendEmail({ to: INVITEE, toName: 'Pat\r\nBcc: x\u0007 Example', subject: 's', html: '<p>h</p>', text: 't' });
    expect(sentRecipients()).toEqual([{ emailAddress: { address: INVITEE, name: 'Pat Bcc: x Example' } }]);
  });

  it('ignores toName for a list of recipients', async () => {
    await sendEmail({ to: [INVITEE, 'b@fixture.example.test'], toName: INVITEE_NAME, subject: 's', html: '<p>h</p>', text: 't' });
    expect(sentRecipients()).toEqual([
      { emailAddress: { address: INVITEE } },
      { emailAddress: { address: 'b@fixture.example.test' } },
    ]);
  });

  function routeRequest(body: Record<string, unknown>): NextRequest {
    return new NextRequest('http://localhost/api/email/send-download-invite', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-secret': 'test-internal-secret' },
      body: JSON.stringify(body),
    });
  }

  it('route: recipientName in the body reaches Graph as the To name', async () => {
    const res = await POST(routeRequest({ recipientEmail: INVITEE, recipientName: INVITEE_NAME }));
    expect(await res.json()).toEqual({ success: true });
    expect(sentRecipients()).toEqual([{ emailAddress: { address: INVITEE, name: INVITEE_NAME } }]);
  });

  it('route: an older caller with no recipientName still sends, address only', async () => {
    const res = await POST(routeRequest({ recipientEmail: INVITEE }));
    expect(await res.json()).toEqual({ success: true });
    expect(sentRecipients()).toEqual([{ emailAddress: { address: INVITEE } }]);
  });

  it('route: a non-string recipientName is dropped', async () => {
    await POST(routeRequest({ recipientEmail: INVITEE, recipientName: { first: 'x' } }));
    expect(sentRecipients()).toEqual([{ emailAddress: { address: INVITEE } }]);
  });
});
