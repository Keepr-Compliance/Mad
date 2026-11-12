/**
 * BACKLOG-4238 — the AI apps page and list: the MCP gate, the support-session
 * refusal, the strict list envelope, the row text and its order, the account
 * named, Disconnect and Disconnect all.
 */

import { act, fireEvent, render, screen, within } from '@testing-library/react';
import '@testing-library/jest-dom';

const mockRpc = jest.fn();
const mockGetUser = jest.fn();
let mockCookieHeader: string | null = null;
const mockDisconnect = jest.fn();
const mockDisconnectAll = jest.fn();

jest.mock('next/headers', () => ({
  headers: async () => ({ get: (name: string) => (name.toLowerCase() === 'cookie' ? mockCookieHeader : null) }),
}));
jest.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({ rpc: (...a: unknown[]) => mockRpc(...a), auth: { getUser: () => mockGetUser() } }),
}));
jest.mock('@/lib/mcp/account/actions', () => ({
  disconnectAiApp: (...a: unknown[]) => mockDisconnect(...a),
  disconnectAllAiApps: (...a: unknown[]) => mockDisconnectAll(...a),
}));
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

import AiAppsPage from '@/app/dashboard/account/ai-apps/page';
import { AI_APPS, CONSENT, M_A } from '@/lib/mcp/account/messages';
import { CONNECTION_ID, CONNECTION_ID_2, EMAIL, clearMcpEnv, connectionRow, refused, setMcpEnv } from './fixtures';

let restoreEnv: () => void;
beforeEach(() => {
  restoreEnv = setMcpEnv();
  mockRpc.mockReset();
  mockGetUser.mockReset();
  mockDisconnect.mockReset();
  mockDisconnectAll.mockReset();
  mockGetUser.mockResolvedValue({ data: { user: { id: 'u', email: EMAIL } } });
  mockCookieHeader = 'a=1';
});
afterEach(() => {
  restoreEnv();
  jest.restoreAllMocks();
});

function listOk(rows: unknown[]) {
  return { data: { ok: true, connections: rows }, error: null };
}

async function renderPage() {
  return render(await AiAppsPage());
}

const rows = () => screen.queryAllByTestId('ai-app-row');

describe('MCP off', () => {
  it('is notFound before any header read or database call', async () => {
    clearMcpEnv();
    await expect(AiAppsPage()).rejects.toBeInstanceOf(NotFound);
    expect(mockRpc).not.toHaveBeenCalled();
    expect(mockGetUser).not.toHaveBeenCalled();
  });
});

describe('before the list call', () => {
  it('a support-session cookie → support-session message, no rpc', async () => {
    mockCookieHeader = 'impersonation_session=x';
    await renderPage();
    expect(screen.getByRole('alert')).toHaveTextContent(M_A.supportSession);
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it('signed out → /login, no rpc', async () => {
    mockGetUser.mockResolvedValue({ data: { user: null } });
    await expect(AiAppsPage()).rejects.toMatchObject({ to: '/login' });
    expect(mockRpc).not.toHaveBeenCalled();
  });
});

describe('the list', () => {
  it('calls mcp_list_my_connections with no arguments', async () => {
    mockRpc.mockResolvedValue(listOk([]));
    await renderPage();
    expect(mockRpc.mock.calls).toEqual([['mcp_list_my_connections']]);
  });

  it('empty → the empty message, no rows, no Disconnect all', async () => {
    mockRpc.mockResolvedValue(listOk([]));
    await renderPage();
    expect(screen.getByText(M_A.empty)).toBeInTheDocument();
    expect(rows()).toEqual([]);
    expect(screen.queryByRole('button', { name: AI_APPS.disconnectAll })).toBeNull();
  });

  it('names the signed-in account under the intro', async () => {
    mockRpc.mockResolvedValue(listOk([]));
    const { container } = await renderPage();
    const intro = screen.getByText(AI_APPS.intro);
    const line = screen.getByText(CONSENT.signedInAs(EMAIL));
    expect(intro.compareDocumentPosition(line) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(container.textContent).toContain(CONSENT.signedInAs(EMAIL));
  });

  it('renders exactly the returned rows with provider, host, name, dates', async () => {
    mockRpc.mockResolvedValue(
      listOk([
        connectionRow(),
        connectionRow({
          id: CONNECTION_ID_2,
          provider: 'openai',
          client_name: 'ChatGPT',
          redirect_host: 'chatgpt.com',
          consented_at: '2026-11-01T09:00:00+00:00',
          last_used_at: '2026-11-11T23:59:00+00:00',
        }),
      ])
    );
    await renderPage();
    expect(rows()).toHaveLength(2);
    const [a, b] = rows();
    expect(a).toHaveTextContent('Claude (Anthropic)');
    expect(a).toHaveTextContent(AI_APPS.sendsBackTo('claude.ai'));
    expect(a).toHaveTextContent(AI_APPS.connected('Nov 10, 2026'));
    expect(a).toHaveTextContent(AI_APPS.notUsed);
    expect(b).toHaveTextContent('ChatGPT (OpenAI)');
    expect(b).toHaveTextContent(AI_APPS.lastUsed('Nov 11, 2026'));
    expect(within(a).getByRole('button', { name: AI_APPS.disconnect })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: AI_APPS.disconnectAll })).toBeInTheDocument();
  });

  it('the app name is literal text inside <bdi>, after the provider and the return host', async () => {
    const name = '‮ppa <script>x</script>';
    mockRpc.mockResolvedValue(listOk([connectionRow({ client_name: name })]));
    await renderPage();
    const row = rows()[0];
    const bdi = row.querySelector('bdi');
    expect(bdi).not.toBeNull();
    expect(bdi!.textContent).toBe(name);
    expect(row.querySelector('script')).toBeNull();
    const text = row.textContent ?? '';
    expect(text.indexOf('Claude (Anthropic)')).toBe(0);
    expect(text.indexOf(AI_APPS.sendsBackTo('claude.ai'))).toBeGreaterThan(0);
    expect(text.indexOf(name)).toBeGreaterThan(text.indexOf(AI_APPS.sendsBackTo('claude.ai')));
  });

  it.each([
    ['an unknown provider', connectionRow({ provider: 'acme-ai' })],
    ['a non-uuid id', connectionRow({ id: 'conn-1' })],
    ['an extra key', { ...connectionRow(), status: 'active' }],
    ['a missing key', (() => { const r: Record<string, unknown> = connectionRow(); delete r.last_used_at; return r; })()],
    ['an unreadable date', connectionRow({ consented_at: 'yesterday' })],
    ['an empty app name', connectionRow({ client_name: '' })],
  ])('one row with %s → the whole list is the load-failure message', async (_label, bad) => {
    mockRpc.mockResolvedValue(listOk([connectionRow({ id: CONNECTION_ID_2 }), bad]));
    const { container } = await renderPage();
    expect(screen.getByRole('alert')).toHaveTextContent(M_A.loadFailed);
    expect(rows()).toEqual([]);
    expect(container.textContent).not.toContain('acme-ai');
  });

  it.each([
    ['a transport error', { data: null, error: { name: 'PostgrestError', message: 'raw database text' } }],
    ['an extra top-level key', { data: { ok: true, connections: [], more: 1 }, error: null }],
    ['connections not an array', { data: { ok: true, connections: {} }, error: null }],
    ['an unknown refusal', { data: refused('other'), error: null }],
  ])('%s → load-failure message', async (_label, res) => {
    mockRpc.mockResolvedValue(res);
    const { container } = await renderPage();
    expect(screen.getByRole('alert')).toHaveTextContent(M_A.loadFailed);
    expect(container.textContent).not.toContain('raw database text');
  });

  it('not_signed_in → /login', async () => {
    mockRpc.mockResolvedValue({ data: refused('not_signed_in'), error: null });
    await expect(AiAppsPage()).rejects.toMatchObject({ to: '/login' });
  });
});

describe('Disconnect', () => {
  beforeEach(() => mockRpc.mockResolvedValue(listOk([connectionRow()])));

  it('Disconnect sends exactly the row id', async () => {
    mockDisconnect.mockResolvedValue({ ok: true });
    await renderPage();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: AI_APPS.disconnect }));
    });
    expect(mockDisconnect.mock.calls).toEqual([[CONNECTION_ID]]);
  });

  it('a failed Disconnect shows the returned message', async () => {
    mockDisconnect.mockResolvedValue({ ok: false, message: M_A.disconnectFailed });
    await renderPage();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: AI_APPS.disconnect }));
    });
    expect(screen.getByRole('alert')).toHaveTextContent(M_A.disconnectFailed);
  });

  it('Disconnect all asks first; Cancel sends nothing', async () => {
    const confirm = jest.spyOn(window, 'confirm').mockReturnValue(false);
    await renderPage();
    fireEvent.click(screen.getByRole('button', { name: AI_APPS.disconnectAll }));
    expect(confirm).toHaveBeenCalledWith(AI_APPS.confirmAll);
    expect(mockDisconnectAll).not.toHaveBeenCalled();
  });

  it('Disconnect all after OK calls the action with no arguments', async () => {
    jest.spyOn(window, 'confirm').mockReturnValue(true);
    mockDisconnectAll.mockResolvedValue({ ok: true });
    await renderPage();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: AI_APPS.disconnectAll }));
    });
    expect(mockDisconnectAll.mock.calls).toEqual([[]]);
  });
});
