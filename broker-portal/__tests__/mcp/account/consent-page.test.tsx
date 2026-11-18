/**
 * BACKLOG-4238 — the consent page: the MCP gate, checks before the database,
 * exactly one view call per render, the strict view envelope, the text shown
 * and in what order, and the account it names.
 */

import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';

const mockRpc = jest.fn();
const mockGetUser = jest.fn();
let mockCookieHeader: string | null = null;

jest.mock('next/headers', () => ({
  headers: async () => ({ get: (name: string) => (name.toLowerCase() === 'cookie' ? mockCookieHeader : null) }),
}));
jest.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({ rpc: (...a: unknown[]) => mockRpc(...a), auth: { getUser: () => mockGetUser() } }),
}));
jest.mock('@/lib/mcp/account/actions', () => ({ approveAiApp: jest.fn(), denyAiApp: jest.fn() }));
class Redirect extends Error {
  constructor(public readonly to: string) {
    super('NEXT_REDIRECT');
  }
}
class NotFound extends Error {}
jest.mock('@/components/sentry/ReplayOff', () => ({
  // BACKLOG-4259: marks where the page mounts the replay stop (tested in replay-routes-4259.test.tsx)
  ReplayOff: () => require('react').createElement('span', { 'data-testid': 'replay-off' }),
}));
jest.mock('next/navigation', () => ({
  redirect: (to: string) => {
    throw new Redirect(to);
  },
  notFound: () => {
    throw new NotFound();
  },
}));

import * as PageModule from '@/app/dashboard/account/ai-apps/connect/[requestId]/page';
import { CONSENT, M_C } from '@/lib/mcp/account/messages';
import { bindingDigest } from '@/lib/mcp/oauth/crypto';
import { BIND_COOKIE, BINDING, EMAIL, NONCE, REQUEST_ID, clearMcpEnv, refused, setMcpEnv, viewOk } from './fixtures';
import { captureConsole } from '../oauth/fixtures';

const Page = PageModule.default;

let restoreEnv: () => void;
beforeEach(() => {
  restoreEnv = setMcpEnv();
  mockRpc.mockReset();
  mockGetUser.mockReset();
  mockGetUser.mockResolvedValue({ data: { user: { id: 'u', email: EMAIL } } });
  mockCookieHeader = BIND_COOKIE;
  jest.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  restoreEnv();
  jest.restoreAllMocks();
});

async function renderPage(requestId: string = REQUEST_ID) {
  const el = await Page({ params: Promise.resolve({ requestId }) });
  return render(el);
}

const viewCalls = () => mockRpc.mock.calls.filter(([fn]) => fn === 'mcp_authorize_view');
const buttons = () => screen.queryAllByRole('button');

describe('MCP off', () => {
  it('is notFound before any header read or database call', async () => {
    clearMcpEnv();
    await expect(Page({ params: Promise.resolve({ requestId: REQUEST_ID }) })).rejects.toBeInstanceOf(NotFound);
    expect(mockRpc).not.toHaveBeenCalled();
    expect(mockGetUser).not.toHaveBeenCalled();
  });
});

describe('checks before the database', () => {
  it.each(['A'.repeat(21), 'A'.repeat(23), `${'A'.repeat(21)}=`])('a malformed request id %s → in-page message, no rpc', async (id) => {
    await renderPage(id);
    expect(screen.getByRole('alert')).toHaveTextContent(M_C.badId);
    expect(mockRpc).not.toHaveBeenCalled();
    expect(buttons()).toEqual([]);
  });

  it('a support-session cookie → support-session message, no rpc', async () => {
    mockCookieHeader = `impersonation_session=x; ${BIND_COOKIE}`;
    await renderPage();
    expect(screen.getByRole('alert')).toHaveTextContent(M_C.supportSession);
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it('signed out → /login', async () => {
    mockGetUser.mockResolvedValue({ data: { user: null } });
    await expect(Page({ params: Promise.resolve({ requestId: REQUEST_ID }) })).rejects.toMatchObject({ to: '/login' });
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it('pepper missing → not-available message, no rpc', async () => {
    delete process.env.MCP_TOKEN_PEPPER;
    await renderPage();
    expect(screen.getByRole('alert')).toHaveTextContent(M_C.misconfigured);
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it.each([
    ['no binding cookie', 'a=1'],
    ['two binding cookies', `${BIND_COOKIE}; ${BIND_COOKIE}`],
    ['two different binding cookies', `${BIND_COOKIE}; __Host-kpr_mcp_bind=kpr_bd_${'Z'.repeat(43)}`],
    ['a malformed binding cookie', '__Host-kpr_mcp_bind=kpr_bd_x'],
  ])('%s → different-browser message, no rpc', async (_label, header) => {
    mockCookieHeader = header;
    await renderPage();
    expect(screen.getByRole('alert')).toHaveTextContent(M_C.noBinding);
    expect(mockRpc).not.toHaveBeenCalled();
  });
});

describe('the view call', () => {
  it('one render makes exactly one view call, with the request id and the SHA-256 of the binding value', async () => {
    mockRpc.mockResolvedValue({ data: viewOk(), error: null });
    await renderPage();
    expect(viewCalls()).toEqual([
      ['mcp_authorize_view', { p_request_id: REQUEST_ID, p_browser_binding_sha256: bindingDigest(BINDING) }],
    ]);
    expect(mockRpc).toHaveBeenCalledTimes(1);
  });

  it('the module exports no generateMetadata', () => {
    expect(Object.keys(PageModule)).not.toContain('generateMetadata');
  });
});

describe('the consent text', () => {
  beforeEach(() => mockRpc.mockResolvedValue({ data: viewOk(), error: null }));

  it('shows every line and two enabled-after-mount buttons', async () => {
    const { container } = await renderPage();
    const text = container.textContent ?? '';
    for (const line of [
      CONSENT.lead('Claude (Anthropic)'),
      `${CONSENT.nameLabel}“Claude”${CONSENT.nameHost('claude.ai')}`,
      CONSENT.onlyIf('Claude (Anthropic)'),
      CONSENT.scope,
      CONSENT.agreement('Claude (Anthropic)'),
      CONSENT.disconnect,
      CONSENT.whatDisconnects,
    ]) {
      expect(text).toContain(line);
    }
    expect(screen.getByRole('button', { name: CONSENT.allow })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: CONSENT.deny })).toBeInTheDocument();
  });

  it('states what the app reads, where it goes and what disconnects it, as approved (BACKLOG-4245)', async () => {
    const { container } = await renderPage();
    const text = container.textContent ?? '';
    expect(text).toContain(
      'It can read the deals you saved to Keepr Cloud: details, prices, commission, checklists (including private ones) and todos. ' +
        'It can also read the people on each deal, with their names, companies, email addresses, phone numbers and notes. ' +
        'It cannot read your emails, texts, files or contact list. ' +
        'It cannot change, send or delete anything.',
    );
    expect(text).toContain(
      "What it reads, including other people's contact details, is sent to Claude (Anthropic). " +
        'What Claude (Anthropic) does with it is covered by your agreement with Claude (Anthropic).',
    );
    expect(text).toContain(
      'Turning Keepr Cloud off deletes your online copy and disconnects every AI app. ' +
        'Signing out does not disconnect them, including "Sign out all devices".',
    );
    expect(text).toContain("other people's contact details");
    expect(text).toContain('including private ones');
    expect(text).not.toContain('texts and emails waiting');
    expect(text).not.toContain('{provider}');
  });

  it('names the signed-in account directly above the buttons', async () => {
    const { container } = await renderPage();
    const line = screen.getByText(CONSENT.signedInAs(EMAIL));
    expect(line).toBeInTheDocument();
    const allow = screen.getByRole('button', { name: CONSENT.allow });
    expect(line.compareDocumentPosition(allow) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    const paragraphs = Array.from(container.querySelectorAll('p')).map((p) => p.textContent);
    expect(paragraphs[paragraphs.length - 1]).toBe(CONSENT.signedInAs(EMAIL));
  });

  it('shows the email of the account getUser returned, as text', async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: 'u', email: '<b>other-4238</b>@example.test' } } });
    const { container } = await renderPage();
    expect(screen.getByText(CONSENT.signedInAs('<b>other-4238</b>@example.test'))).toBeInTheDocument();
    expect(container.querySelector('b')).toBeNull();
    expect(container.textContent).not.toContain(EMAIL);
  });

  it('a user with no email → fixed message, no buttons', async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: 'u', email: undefined } } });
    await renderPage();
    expect(screen.getByRole('alert')).toHaveTextContent(M_C.failed);
    expect(buttons()).toEqual([]);
  });

  it('the app name is literal text inside <bdi>, after the provider, with the return host after it on the same line', async () => {
    const name = '‮ppa <script>x</script>';
    mockRpc.mockResolvedValue({ data: viewOk({ client_name: name }), error: null });
    const { container } = await renderPage();
    const bdi = container.querySelector('bdi');
    expect(bdi).not.toBeNull();
    expect(bdi!.textContent).toBe(name);
    expect(container.querySelector('script')).toBeNull();
    const text = container.textContent ?? '';
    const lead = text.indexOf(CONSENT.lead('Claude (Anthropic)'));
    const host = text.indexOf(CONSENT.nameHost('claude.ai'));
    const at = text.indexOf(name);
    expect(lead).toBeGreaterThanOrEqual(0);
    expect(at).toBeGreaterThan(lead);
    expect(host).toBeGreaterThan(at);
    const line = screen.getByTestId('consent-name-host');
    expect(line).toContainElement(bdi as HTMLElement);
    expect(line.textContent).toBe(`${CONSENT.nameLabel}“${name}”${CONSENT.nameHost('claude.ai')}`);
  });

  it('replaces_existing true → the replacement sentence, before the buttons', async () => {
    mockRpc.mockResolvedValue({ data: viewOk({ replaces_existing: true }), error: null });
    const { container } = await renderPage();
    const note = screen.getByRole('note');
    expect(note).toHaveTextContent(CONSENT.replaces('Claude (Anthropic)'));
    const allow = screen.getByRole('button', { name: CONSENT.allow });
    expect(note.compareDocumentPosition(allow) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(container.textContent).toContain('You already connected Claude (Anthropic). Allowing this replaces that connection.');
  });

  it('mounts the replay stop once', async () => {
    await renderPage();
    expect(screen.getAllByTestId('replay-off')).toHaveLength(1);
  });

  it('replaces_existing false → no replacement sentence', async () => {
    const { container } = await renderPage();
    expect(screen.queryByRole('note')).toBeNull();
    expect(container.textContent).not.toContain(CONSENT.replaces('Claude (Anthropic)'));
  });

  it('openai is labelled ChatGPT (OpenAI)', async () => {
    mockRpc.mockResolvedValue({ data: viewOk({ provider: 'openai', redirect_host: 'chatgpt.com' }), error: null });
    const { container } = await renderPage();
    expect(container.textContent).toContain(CONSENT.lead('ChatGPT (OpenAI)'));
  });
});

describe('view refusals and malformed answers', () => {
  it.each([
    ['request_invalid', M_C.requestInvalid],
    ['impersonating', M_C.supportSession],
    ['disabled', M_C.disabled],
  ])('%s → fixed message, no buttons, no database text', async (code, message) => {
    mockRpc.mockResolvedValue({ data: refused(code), error: null });
    const { container } = await renderPage();
    expect(screen.getByRole('alert')).toHaveTextContent(message);
    expect(container.textContent).not.toContain(code);
    expect(buttons()).toEqual([]);
  });

  it('not_signed_in → /login', async () => {
    mockRpc.mockResolvedValue({ data: refused('not_signed_in'), error: null });
    await expect(Page({ params: Promise.resolve({ requestId: REQUEST_ID }) })).rejects.toMatchObject({ to: '/login' });
  });

  it('notice_version 2 → update message, no buttons', async () => {
    mockRpc.mockResolvedValue({ data: viewOk({ notice_version: 2 }), error: null });
    await renderPage();
    expect(screen.getAllByTestId('replay-off')).toHaveLength(1);
    expect(screen.getByRole('alert')).toHaveTextContent(M_C.noticeVersion);
    expect(buttons()).toEqual([]);
  });

  it.each([
    ['an unknown provider', viewOk({ provider: 'acme-ai' })],
    ['an extra key', { ...viewOk(), extra: 'x' }],
    ['a missing key', (() => { const v: Record<string, unknown> = viewOk(); delete v.scope; return v; })()],
    ['another request id', viewOk({ request_id: 'B'.repeat(22) })],
    ['a wider scope', viewOk({ scope: 'mcp:read mcp:write' })],
    ['a short nonce', viewOk({ nonce: 'N'.repeat(42) })],
    ['replaces_existing missing', (() => { const v: Record<string, unknown> = viewOk(); delete v.replaces_existing; return v; })()],
    ['replaces_existing as a string', viewOk({ replaces_existing: 'true' })],
    ['an empty app name', viewOk({ client_name: '' })],
    ['an app name of 101 characters', viewOk({ client_name: 'x'.repeat(101) })],
    ['ok as a string', viewOk({ ok: 'true' })],
    ['an unknown refusal code', refused('other')],
    ['null', null],
  ])('%s → fixed message, no buttons, nothing raw shown', async (_label, data) => {
    mockRpc.mockResolvedValue({ data, error: null });
    const { container } = await renderPage();
    expect(screen.getByRole('alert')).toHaveTextContent(M_C.failed);
    expect(buttons()).toEqual([]);
    expect(container.textContent).not.toContain('acme-ai');
  });

  it('a transport error → fixed message', async () => {
    mockRpc.mockResolvedValue({ data: null, error: { name: 'PostgrestError', message: 'raw database text' } });
    const { container } = await renderPage();
    expect(screen.getByRole('alert')).toHaveTextContent(M_C.failed);
    expect(container.textContent).not.toContain('raw database text');
  });
});

describe('log lines', () => {
  it('a transport failure logs view_transport with the error code only', async () => {
    const logs = captureConsole();
    try {
      mockRpc.mockResolvedValue({ data: null, error: { name: 'PostgrestError', code: '57014', message: 'raw database text 4238' } });
      await renderPage();
      const lines = logs.lines();
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain('"route":"consent"');
      expect(lines[0]).toContain('"outcome":"view_transport"');
      expect(lines[0]).toContain('"error":"57014"');
      for (const needle of ['raw database text', REQUEST_ID, BINDING, EMAIL]) expect(lines[0]).not.toContain(needle);
    } finally {
      logs.restore();
    }
  });

  it('a refusal logs view_<code> and nothing else', async () => {
    const logs = captureConsole();
    try {
      mockRpc.mockResolvedValue({ data: refused('request_invalid'), error: null });
      await renderPage();
      const lines = logs.lines();
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain('"outcome":"view_request_invalid"');
      expect(lines[0]).not.toContain(REQUEST_ID);
    } finally {
      logs.restore();
    }
  });
});

describe('the nonce reaches the form unchanged', () => {
  it('the form receives the nonce of this render', async () => {
    mockRpc.mockResolvedValue({ data: viewOk(), error: null });
    const el = await Page({ params: Promise.resolve({ requestId: REQUEST_ID }) });
    expect(JSON.stringify(el)).toContain(NONCE);
  });
});

describe('BACKLOG-4263 PR-5: the wording follows the scope the database would grant', () => {
  it('a read grant (scope mcp:read) shows the read-only wording and nothing about changes', async () => {
    mockRpc.mockResolvedValue({ data: viewOk({ scope: 'mcp:read' }), error: null });
    const { container } = await renderPage();
    const text = container.textContent ?? '';
    expect(text).toContain(CONSENT.lead('Claude (Anthropic)'));
    expect(text).toContain(CONSENT.scope);
    expect(text).not.toContain(CONSENT.write.scope);
    expect(text).not.toContain(CONSENT.write.changes);
    expect(text).not.toMatch(/tick, add, edit and remove/);
  });

  it('a write grant (scope mcp:todos) shows the wording the founder accepted (Q4, change a), and not the read-only line', async () => {
    mockRpc.mockResolvedValue({ data: viewOk({ scope: 'mcp:todos' }), error: null });
    const { container } = await renderPage();
    const text = container.textContent ?? '';
    expect(text).toContain('Claude (Anthropic) wants to use your Keepr data.');
    expect(text).toContain(
      'It can read the deals you saved to Keepr Cloud: details, prices, commission, checklists (including private ones) and todos, ' +
        'and the people on each deal with their names, companies, email addresses, phone numbers and notes. ' +
        'It can tick, add, edit and remove your todos and set their notes and due dates. ' +
        'It cannot read, send or delete your emails or texts, cannot read your files or contact list, and cannot change anything else.',
    );
    expect(text).toContain('Every change shows which app made it. You can see every change in Keepr and restore removed todos for 30 days.');
    expect(text).not.toContain(CONSENT.scope);
    expect(text).not.toContain(CONSENT.lead('Claude (Anthropic)'));
    expect(screen.getByRole('button', { name: CONSENT.allow })).toBeInTheDocument();
  });

  it.each([['mcp:write'], ['mcp:read mcp:todos'], ['MCP:TODOS']])('any other scope %p is "could not complete", with no buttons', async (scope) => {
    mockRpc.mockResolvedValue({ data: viewOk({ scope }), error: null });
    await renderPage();
    expect(screen.getByRole('alert')).toHaveTextContent(M_C.failed);
    expect(buttons()).toHaveLength(0);
  });
});

describe('BACKLOG-4263 PR-10.5: the request age line', () => {
  // sha256 of container.innerHTML for viewOk() (the 9-key answer), recorded against the page at
  // 692793496, before the age line existed. The 9-key answer must keep rendering exactly that markup.
  const OLD_SHAPE_MARKUP_SHA256 = '67d15e23dd9af57456f47a54c65f1d3a4335f3ab6327833c74b6145807342663';
  const sha256 = (s: string) => (require('node:crypto') as typeof import('node:crypto')).createHash('sha256').update(s).digest('hex');
  const AGE_PREFIX = 'This request was started';

  it('the 9-key answer renders the markup the page rendered before the age line existed', async () => {
    mockRpc.mockResolvedValue({ data: viewOk(), error: null });
    const { container } = await renderPage();
    expect(sha256(container.innerHTML)).toBe(OLD_SHAPE_MARKUP_SHA256);
    expect(container.textContent).not.toContain(AGE_PREFIX);
  });

  it('the 9-key answer with a write grant shows no age line either', async () => {
    mockRpc.mockResolvedValue({ data: viewOk({ scope: 'mcp:todos' }), error: null });
    const { container } = await renderPage();
    expect(screen.getByRole('button', { name: CONSENT.allow })).toBeInTheDocument();
    expect(container.textContent).not.toContain(AGE_PREFIX);
  });

  it.each([
    [0, 'This request was started just now.'],
    [1, 'This request was started 1 second ago.'],
    [2, 'This request was started 2 seconds ago.'],
    [40, 'This request was started 40 seconds ago.'],
    [179, 'This request was started 179 seconds ago.'],
    [180, 'This request was started 180 seconds ago.'],
    [181, 'This request was started more than 3 minutes ago.'],
    [86400, 'This request was started more than 3 minutes ago.'],
  ])('age_seconds %p → %p', async (age, sentence) => {
    mockRpc.mockResolvedValue({ data: { ...viewOk(), age_seconds: age }, error: null });
    const { container } = await renderPage();
    const lines = Array.from(container.querySelectorAll('p')).filter((p) => (p.textContent ?? '').startsWith(AGE_PREFIX));
    expect(lines).toHaveLength(1);
    expect(lines[0].textContent).toBe(sentence);
    expect(CONSENT.startedAgo(age)).toBe(sentence);
  });

  it('the age line is a plain grey paragraph right after the "only continue" line, and the only change to the markup', async () => {
    mockRpc.mockResolvedValue({ data: { ...viewOk(), age_seconds: 40 }, error: null });
    const { container } = await renderPage();
    const line = screen.getByText('This request was started 40 seconds ago.');
    expect(line.tagName).toBe('P');
    expect(line.className).toBe('text-gray-600');
    expect(line.children).toHaveLength(0);
    expect(line.previousElementSibling?.textContent).toBe(CONSENT.onlyIf('Claude (Anthropic)'));
    const paragraphs = Array.from(container.querySelectorAll('p')).map((p) => p.textContent);
    expect(paragraphs[paragraphs.length - 1]).toBe(CONSENT.signedInAs(EMAIL));
    line.remove();
    expect(sha256(container.innerHTML)).toBe(OLD_SHAPE_MARKUP_SHA256);
  });

  it('the age comes from the database answer, never from the portal clock', async () => {
    jest.spyOn(Date, 'now').mockReturnValue(Date.parse('2030-01-01T00:00:00Z'));
    mockRpc.mockResolvedValue({ data: { ...viewOk(), age_seconds: 40 }, error: null });
    const { container } = await renderPage();
    expect(container.textContent).toContain('This request was started 40 seconds ago.');
  });

  it('the line is static server-rendered text: no timer is started', async () => {
    const setInterval = jest.spyOn(global, 'setInterval');
    mockRpc.mockResolvedValue({ data: { ...viewOk(), age_seconds: 40 }, error: null });
    await renderPage();
    expect(setInterval).not.toHaveBeenCalled();
  });

  it.each([
    ['a string', '40'],
    ['a fraction', 40.5],
    ['negative', -1],
    ['null', null],
    ['too large', 1e12],
    ['one over the limit', 86401],
    ['NaN', Number.NaN],
    ['a boolean', true],
  ])('age_seconds as %s → fixed message, no buttons, no age line', async (_label, age) => {
    mockRpc.mockResolvedValue({ data: { ...viewOk(), age_seconds: age }, error: null });
    const { container } = await renderPage();
    expect(screen.getByRole('alert')).toHaveTextContent(M_C.failed);
    expect(buttons()).toEqual([]);
    expect(container.textContent).not.toContain(AGE_PREFIX);
  });

  it.each([
    ['the 9 keys plus another key', { ...viewOk(), extra: 'x' }],
    ['the 9 keys, age_seconds and another key', { ...viewOk(), age_seconds: 40, extra: 'x' }],
    ['age_seconds with an old key missing', (() => { const v: Record<string, unknown> = { ...viewOk(), age_seconds: 40 }; delete v.scope; return v; })()],
    ['age_seconds in place of an old key', (() => { const v: Record<string, unknown> = { ...viewOk(), age_seconds: 40 }; delete v.replaces_existing; return v; })()],
    ['started_at instead of age_seconds', { ...viewOk(), started_at: '2026-11-18T12:00:00+00:00' }],
  ])('%s → fixed message, no buttons', async (_label, data) => {
    mockRpc.mockResolvedValue({ data, error: null });
    await renderPage();
    expect(screen.getByRole('alert')).toHaveTextContent(M_C.failed);
    expect(buttons()).toEqual([]);
  });
});
