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
      CONSENT.returnTo('claude.ai'),
      `${CONSENT.nameLabel}Claude`,
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

  it('the app name is literal text inside <bdi>, after the provider and the return host', async () => {
    const name = '‮ppa <script>x</script>';
    mockRpc.mockResolvedValue({ data: viewOk({ client_name: name }), error: null });
    const { container } = await renderPage();
    const bdi = container.querySelector('bdi');
    expect(bdi).not.toBeNull();
    expect(bdi!.textContent).toBe(name);
    expect(container.querySelector('script')).toBeNull();
    const text = container.textContent ?? '';
    const lead = text.indexOf(CONSENT.lead('Claude (Anthropic)'));
    const host = text.indexOf(CONSENT.returnTo('claude.ai'));
    const at = text.indexOf(name);
    expect(lead).toBeGreaterThanOrEqual(0);
    expect(host).toBeGreaterThan(lead);
    expect(at).toBeGreaterThan(host);
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

describe('the nonce reaches the form unchanged', () => {
  it('the form receives the nonce of this render', async () => {
    mockRpc.mockResolvedValue({ data: viewOk(), error: null });
    const el = await Page({ params: Promise.resolve({ requestId: REQUEST_ID }) });
    expect(JSON.stringify(el)).toContain(NONCE);
  });
});
