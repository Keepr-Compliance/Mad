/**
 * BACKLOG-4238 — the AI apps card on My Account: the connected apps are listed
 * on the card (read on the server through listMyConnections), the empty and
 * load-failed texts, a support session lists nothing and reads nothing, and the
 * whole card links to the AI apps page. Rows go through the real envelope
 * check: the RPC is mocked, listMyConnections is not.
 */

import { render, screen, within } from '@testing-library/react';
import '@testing-library/jest-dom';

const mockRpc = jest.fn();
const mockGetUser = jest.fn();
const mockGetImpersonationSession = jest.fn();
let mockCookieHeader: string | null = null;
let mockClientImpersonating = false;

jest.mock('next/headers', () => ({
  headers: async () => ({ get: (name: string) => (name.toLowerCase() === 'cookie' ? mockCookieHeader : null) }),
}));
jest.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({ rpc: (...a: unknown[]) => mockRpc(...a), auth: { getUser: () => mockGetUser() } }),
}));
jest.mock('@/lib/impersonation', () => ({ getImpersonationSession: () => mockGetImpersonationSession() }));
jest.mock('@/lib/account/getAccountView', () => ({ getAccountView: async () => null }));
jest.mock('next/navigation', () => ({
  redirect: (to: string) => {
    throw new Error(`NEXT_REDIRECT ${to}`);
  },
}));
jest.mock('@/lib/actions/myPhone', () => ({ getMyPhone: async () => ({ ok: true, phone: null }), setMyPhone: jest.fn() }));
jest.mock('@/components/providers/ImpersonationProvider', () => ({
  useImpersonation: () => ({ isImpersonating: mockClientImpersonating }),
}));
jest.mock('@/lib/actions/getActiveDevices', () => ({ getActiveDevices: async () => ({ success: true, devices: [] }) }));
jest.mock('@/components/ActiveSessionsList', () => ({ ActiveSessionsList: () => null }));
jest.mock('@/lib/actions/signOutAllDevices', () => ({ signOutAllDevices: async () => ({ success: true }) }));

import AccountPage from '@/app/dashboard/account/page';
import { IMPERSONATION_COOKIE_NAME } from '@/lib/constants';
import { AI_APPS, M_A, PROVIDER_LABELS } from '@/lib/mcp/account/messages';
import { CONNECTION_ID, CONNECTION_ID_2, EMAIL, clearMcpEnv, connectionRow, setMcpEnv } from './fixtures';

const AI_APPS_HREF = '/dashboard/account/ai-apps';
const IMPERSONATION_COOKIE = `${IMPERSONATION_COOKIE_NAME}=x`;

let restoreEnv: () => void;
beforeEach(() => {
  restoreEnv = setMcpEnv();
  mockRpc.mockReset();
  mockGetUser.mockReset();
  mockGetImpersonationSession.mockReset();
  mockGetUser.mockResolvedValue({ data: { user: { id: 'u', email: EMAIL } } });
  mockGetImpersonationSession.mockResolvedValue(null);
  mockCookieHeader = 'a=1';
  mockClientImpersonating = false;
});
afterEach(() => {
  restoreEnv();
});

function listOk(rows: unknown[]) {
  return { data: { ok: true, connections: rows }, error: null };
}

async function renderPage() {
  return render(await AccountPage());
}

const card = () => screen.getByTestId('account-ai-apps-card');
const listRpcCalls = () => mockRpc.mock.calls.filter((c) => c[0] === 'mcp_list_my_connections');

describe('connected apps on the card', () => {
  it('lists each app with its provider and last-used line, read once on the server', async () => {
    mockRpc.mockResolvedValue(
      listOk([
        connectionRow({ id: CONNECTION_ID, provider: 'anthropic', last_used_at: '2026-11-12T09:00:00+00:00' }),
        connectionRow({ id: CONNECTION_ID_2, provider: 'openai', client_name: 'ChatGPT', redirect_host: 'chatgpt.com' }),
      ])
    );
    await renderPage();
    expect(listRpcCalls()).toHaveLength(1);
    const items = within(card()).getAllByTestId('account-ai-app');
    expect(items.map((li) => li.textContent)).toEqual([
      `${PROVIDER_LABELS.anthropic} · ${AI_APPS.lastUsed('Nov 12, 2026')}`,
      `${PROVIDER_LABELS.openai} · ${AI_APPS.notUsed}`,
    ]);
    // Nothing the card does not need: no return host, no app name, no Disconnect.
    expect(card()).not.toHaveTextContent('chatgpt.com');
    expect(within(card()).queryByRole('button')).toBeNull();
  });

  it('names the first three and counts the rest', async () => {
    const ids = [1, 2, 3, 4, 5].map((n) => `00000000-0000-4000-8000-00000042380${n}`); // pii-allow-uuid: invented fixture ids
    mockRpc.mockResolvedValue(listOk(ids.map((id) => connectionRow({ id }))));
    await renderPage();
    expect(within(card()).getAllByTestId('account-ai-app')).toHaveLength(3);
    expect(card()).toHaveTextContent(AI_APPS.more(2));
  });

  it('none connected: the AI apps page empty text', async () => {
    mockRpc.mockResolvedValue(listOk([]));
    await renderPage();
    expect(card()).toHaveTextContent(M_A.empty);
    expect(within(card()).queryAllByTestId('account-ai-app')).toHaveLength(0);
  });

  it.each([
    ['a transport error', { data: null, error: { name: 'Err', code: 'X' } }],
    ['a refusal', { data: { ok: false, error: 'not_signed_in' }, error: null }],
    ['a malformed row', { data: { ok: true, connections: [{ id: CONNECTION_ID }] }, error: null }],
  ])('%s: the load-failed text, and the rest of the page still renders', async (_label, result) => {
    mockRpc.mockResolvedValue(result);
    await renderPage();
    expect(card()).toHaveTextContent(M_A.loadFailed);
    expect(screen.getByText('Session Management')).toBeInTheDocument();
  });

  it('a rejected RPC call: the load-failed text, no redirect', async () => {
    mockRpc.mockRejectedValue(new Error('boom'));
    await renderPage();
    expect(card()).toHaveTextContent(M_A.loadFailed);
  });
});

describe('the way to the AI apps page', () => {
  it('the whole card is one link to the AI apps page', async () => {
    mockRpc.mockResolvedValue(listOk([connectionRow()]));
    await renderPage();
    const link = screen.getByTestId('account-ai-apps-link');
    expect(link.tagName).toBe('A');
    expect(link).toHaveAttribute('href', AI_APPS_HREF);
    expect(link).toContainElement(card());
  });
});

describe('support session', () => {
  it('impersonation session: no list call, the support message, no rows, no link', async () => {
    mockGetImpersonationSession.mockResolvedValue({ target_user_id: 'someone' });
    mockRpc.mockResolvedValue(listOk([connectionRow()]));
    await renderPage();
    expect(listRpcCalls()).toHaveLength(0);
    expect(card()).toHaveTextContent(M_A.supportSession);
    expect(within(card()).queryAllByTestId('account-ai-app')).toHaveLength(0);
    expect(screen.queryByTestId('account-ai-apps-link')).toBeNull();
  });

  it('support-session cookie present (the AI apps page rule): no list call, no rows', async () => {
    mockCookieHeader = `a=1; ${IMPERSONATION_COOKIE}`;
    mockRpc.mockResolvedValue(listOk([connectionRow()]));
    await renderPage();
    expect(listRpcCalls()).toHaveLength(0);
    expect(card()).toHaveTextContent(M_A.supportSession);
  });
});

describe('support session seen only by the client', () => {
  it('the client signal alone hides the rows and the link', async () => {
    mockClientImpersonating = true;
    mockRpc.mockResolvedValue(listOk([connectionRow()]));
    await renderPage();
    expect(card()).toHaveTextContent(M_A.supportSession);
    expect(within(card()).queryAllByTestId('account-ai-app')).toHaveLength(0);
    expect(screen.queryByTestId('account-ai-apps-link')).toBeNull();
  });
});

describe('MCP off', () => {
  it('no card and no list call', async () => {
    clearMcpEnv();
    mockRpc.mockResolvedValue(listOk([connectionRow()]));
    await renderPage();
    expect(screen.queryByTestId('account-ai-apps-card')).toBeNull();
    expect(listRpcCalls()).toHaveLength(0);
  });
});
