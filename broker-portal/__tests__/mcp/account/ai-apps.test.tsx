/**
 * BACKLOG-4238 — the AI apps page and list: the MCP gate, the support-session
 * refusal, the strict list envelope, the row text and its order, the account
 * named, Disconnect and Disconnect all.
 */

import { act, fireEvent, render, screen, within } from '@testing-library/react';
import '@testing-library/jest-dom';

const mockRpc = jest.fn();
/** BACKLOG-4263 P11: the page also asks mcp_list_my_connection_access and mcp_list_my_message_reads; tests here set the list. */
const mockList = jest.fn();
const mockAccess = jest.fn();
const mockReads = jest.fn();
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

import AiAppsPage from '@/app/dashboard/account/ai-apps/page';
import { AI_APPS, CONSENT, M_A } from '@/lib/mcp/account/messages';
import { CONNECTION_ID, CONNECTION_ID_2, EMAIL, clearMcpEnv, connectionRow, refused, setMcpEnv } from './fixtures';
import { captureConsole } from '../oauth/fixtures';

let restoreEnv: () => void;
beforeEach(() => {
  restoreEnv = setMcpEnv();
  mockRpc.mockReset();
  mockList.mockReset();
  mockAccess.mockReset();
  mockReads.mockReset();
  // before migration 20261123150000 the access function does not exist; the read log is empty
  mockAccess.mockResolvedValue({ data: null, error: { name: 'PostgrestError', code: 'PGRST202', message: 'not found' } });
  mockReads.mockResolvedValue({ data: { ok: true, reads: [], next_cursor: null }, error: null });
  mockRpc.mockImplementation((fn: string, args?: unknown) =>
    fn === 'mcp_list_my_connection_access' ? mockAccess(fn) : fn === 'mcp_list_my_message_reads' ? mockReads(fn, args) : mockList(fn, ...(args === undefined ? [] : [args])),
  );
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
    mockList.mockResolvedValue(listOk([]));
    await renderPage();
    expect(mockList.mock.calls).toEqual([['mcp_list_my_connections']]);
  });

  it('empty → the empty message, no rows, no Disconnect all', async () => {
    mockList.mockResolvedValue(listOk([]));
    await renderPage();
    expect(screen.getByText(M_A.empty)).toBeInTheDocument();
    expect(screen.getAllByTestId('replay-off')).toHaveLength(1);
    expect(rows()).toEqual([]);
    expect(screen.queryByRole('button', { name: AI_APPS.disconnectAll })).toBeNull();
  });

  it('one connection: the disconnect note shows, exact text, above the list, same classes as the signed-in line', async () => {
    mockList.mockResolvedValue(listOk([connectionRow()]));
    await renderPage();
    const note = screen.getByText(
      'Disconnecting in the AI app does not disconnect it here. To disconnect here, use Disconnect on this page.'
    );
    // the word after "use " is the page's own button label
    expect(note.textContent).toContain(`use ${AI_APPS.disconnect} on this page.`);
    expect(within(rows()[0]).getByRole('button', { name: AI_APPS.disconnect })).toBeInTheDocument();
    expect(note.tagName).toBe('P');
    expect(note.className).toBe(screen.getByText(CONSENT.signedInAs(EMAIL)).className);
    expect(note.compareDocumentPosition(rows()[0]) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByText(CONSENT.signedInAs(EMAIL)).compareDocumentPosition(note) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('no connections: the disconnect note does not show', async () => {
    mockList.mockResolvedValue(listOk([]));
    const { container } = await renderPage();
    expect(container.textContent).not.toContain('Disconnecting in the AI app');
    expect(screen.queryByText(AI_APPS.disconnectHere)).toBeNull();
  });

  it('names the signed-in account under the intro', async () => {
    mockList.mockResolvedValue(listOk([]));
    const { container } = await renderPage();
    const intro = screen.getByText(AI_APPS.intro);
    const line = screen.getByText(CONSENT.signedInAs(EMAIL));
    expect(intro.compareDocumentPosition(line) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(container.textContent).toContain(CONSENT.signedInAs(EMAIL));
  });

  it('renders exactly the returned rows with provider, host, name, dates', async () => {
    mockList.mockResolvedValue(
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
    expect(a).toHaveTextContent(AI_APPS.connected('Nov 10, 2026, 6:30 PM'));
    expect(b).toHaveTextContent('Approved Nov 1, 2026, 9:00 AM UTC');
    expect(a).toHaveTextContent(AI_APPS.notUsed);
    expect(b).toHaveTextContent('ChatGPT (OpenAI)');
    expect(b).toHaveTextContent(AI_APPS.lastUsed('Nov 11, 2026'));
    expect(within(a).getByRole('button', { name: AI_APPS.disconnect })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: AI_APPS.disconnectAll })).toBeInTheDocument();
  });

  // BACKLOG-4263 PR-6: migration 20261118140000 adds `scope` (the stored grant); the answer without it stays valid
  it('a connection granted mcp:todos says it can change todos; one granted mcp:read says read only', async () => {
    mockList.mockResolvedValue(
      listOk([connectionRow({ scope: 'mcp:todos' }), connectionRow({ id: CONNECTION_ID_2, provider: 'openai', client_name: 'ChatGPT', scope: 'mcp:read' })])
    );
    await renderPage();
    const [a, b] = rows();
    expect(within(a).getByTestId('ai-app-allowed')).toHaveTextContent('Allowed: read your deals and change your todos.');
    expect(within(b).getByTestId('ai-app-allowed')).toHaveTextContent('Allowed: read your deals.');
    expect(within(a).getByTestId('ai-app-allowed').className).toBe('text-gray-600');
  });

  it('an answer without scope (before 20261118140000, or after its rollback): the rows show, with no Allowed line', async () => {
    mockList.mockResolvedValue(listOk([connectionRow()]));
    await renderPage();
    expect(rows()).toHaveLength(1);
    expect(screen.queryByTestId('ai-app-allowed')).toBeNull();
  });

  it.each([['an unknown scope', 'mcp:admin'], ['a null scope', null], ['a scope that is not text', 1]])(
    'one row with %s -> that row shows without an Allowed line; the list and its Disconnect buttons stay',
    async (_l, scope) => {
      mockList.mockResolvedValue(listOk([connectionRow({ scope }), connectionRow({ id: CONNECTION_ID_2, scope: 'mcp:todos' })]));
      await renderPage();
      const [a, b] = rows();
      expect(within(a).queryByTestId('ai-app-allowed')).toBeNull();
      expect(within(a).getByRole('button', { name: AI_APPS.disconnect })).toBeInTheDocument();
      expect(within(b).getByTestId('ai-app-allowed')).toHaveTextContent('Allowed: read your deals and change your todos.');
      expect(screen.queryByRole('alert')).toBeNull();
    }
  );

  it('the app name is literal text inside <bdi>, after the provider and the return host', async () => {
    const name = '‮ppa <script>x</script>';
    mockList.mockResolvedValue(listOk([connectionRow({ client_name: name })]));
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
    mockList.mockResolvedValue(listOk([connectionRow({ id: CONNECTION_ID_2 }), bad]));
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
    mockList.mockResolvedValue(res);
    const { container } = await renderPage();
    expect(screen.getByRole('alert')).toHaveTextContent(M_A.loadFailed);
    expect(container.textContent).not.toContain('raw database text');
  });

  it('not_signed_in → /login', async () => {
    mockList.mockResolvedValue({ data: refused('not_signed_in'), error: null });
    await expect(AiAppsPage()).rejects.toMatchObject({ to: '/login' });
  });
});

describe('log lines', () => {
  it('a transport failure logs list_transport with the error code only', async () => {
    const logs = captureConsole();
    try {
      mockList.mockResolvedValue({ data: null, error: { name: 'PostgrestError', code: 'PGRST202', message: 'raw database text 4238' } });
      await renderPage();
      const lines = logs.lines();
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain('"route":"ai-apps"');
      expect(lines[0]).toContain('"outcome":"list_transport"');
      expect(lines[0]).toContain('"error":"PGRST202"');
      for (const needle of ['raw database text', EMAIL]) expect(lines[0]).not.toContain(needle);
    } finally {
      logs.restore();
    }
  });

  it('a not_signed_in refusal logs list_not_signed_in', async () => {
    const logs = captureConsole();
    try {
      mockList.mockResolvedValue({ data: refused('not_signed_in'), error: null });
      await expect(AiAppsPage()).rejects.toMatchObject({ to: '/login' });
      expect(logs.lines()).toHaveLength(1);
      expect(logs.lines()[0]).toContain('"outcome":"list_not_signed_in"');
    } finally {
      logs.restore();
    }
  });
});

describe('Disconnect', () => {
  beforeEach(() => mockList.mockResolvedValue(listOk([connectionRow()])));

  it('Disconnect sends exactly the row id', async () => {
    mockDisconnect.mockResolvedValue({ ok: true });
    await renderPage();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: AI_APPS.disconnect }));
    });
    expect(mockDisconnect.mock.calls).toEqual([[CONNECTION_ID]]);
  });

  it('with two rows, the second Disconnect sends the second row id', async () => {
    mockList.mockResolvedValue(listOk([connectionRow(), connectionRow({ id: CONNECTION_ID_2, client_name: 'Second' })]));
    mockDisconnect.mockResolvedValue({ ok: true });
    await renderPage();
    const second = rows()[1];
    await act(async () => {
      fireEvent.click(within(second).getByRole('button', { name: AI_APPS.disconnect }));
    });
    expect(mockDisconnect.mock.calls).toEqual([[CONNECTION_ID_2]]);
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

// ---------------------------------------------------------------------------------------------- BACKLOG-4263 P11
// The access and read-log answers are transcribed from the T-N harness sample (fixtures/ai-approval-notice-2-4263.json).
describe('BACKLOG-4263 P11: message permission per connection, and the read log', () => {
  const { AI_READS } = require('@/lib/mcp/account/messages') as typeof import('@/lib/mcp/account/messages');
  const FX = require('../fixtures/ai-approval-notice-2-4263.json') as {
    access: { connections: { id: string; messages: boolean }[] };
    reads: { reads: Record<string, unknown>[]; next_cursor: string | null };
  };
  const READ_IDS = ['00000000-0000-4000-8000-000000426311', '00000000-0000-4000-8000-000000426312', '00000000-0000-4000-8000-000000426313']; // pii-allow-uuid: invented fixture ids
  const DEAL = '00000000-0000-4000-8000-000000426321'; // pii-allow-uuid: invented fixture id
  const fill = (v: unknown): unknown =>
    JSON.parse(
      JSON.stringify(v)
        .replace(/@CONN_V2@/g, CONNECTION_ID)
        .replace(/@CONN_V1@/g, CONNECTION_ID_2)
        .replace(/@DEAL@/g, DEAL)
        .replace(/@READ(\d)@/g, (_m, n) => READ_IDS[Number(n) - 1]),
    );
  const accessOk = () => ({ data: fill({ ok: true, connections: FX.access.connections }), error: null });
  const readsOk = (over: Record<string, unknown> = {}) => ({ data: fill({ ok: true, ...FX.reads, ...over }), error: null });
  const twoRows = () => listOk([connectionRow({ scope: 'mcp:read' }), connectionRow({ id: CONNECTION_ID_2, client_name: 'Second', scope: 'mcp:read' })]);
  const allowed = () => screen.queryAllByTestId('ai-app-allowed').map((e) => e.textContent);
  const hints = () => screen.queryAllByTestId('ai-app-hint').map((e) => e.textContent);
  const readRows = () => screen.queryAllByTestId('ai-read-row').map((e) => e.textContent);

  it('a version-2 connection says it may read emails and texts; a version-1 one says it may not and how to allow it', async () => {
    mockList.mockResolvedValue(twoRows());
    mockAccess.mockResolvedValue(accessOk());
    await renderPage();
    expect(allowed()).toEqual(['Allowed: read your deals and the emails and texts attached to them.', AI_APPS.allowedRead]);
    expect(hints()).toEqual(['This app cannot read emails or texts. To allow it, connect it again from the app.']);
  });

  it('a version-2 connection granted todos names both', async () => {
    mockList.mockResolvedValue(listOk([connectionRow({ scope: 'mcp:todos' })]));
    mockAccess.mockResolvedValue({ data: { ok: true, connections: [{ id: CONNECTION_ID, messages: true }] }, error: null });
    await renderPage();
    expect(allowed()).toEqual(['Allowed: read your deals and the emails and texts attached to them, and change your todos.']);
    expect(hints()).toEqual([]);
  });

  it.each([
    ['the function is missing (before 20261123150000)', { data: null, error: { name: 'PostgrestError', code: 'PGRST202', message: 'x' } }],
    ['a transport error', { data: null, error: { name: 'PostgrestError', code: 'XX000', message: 'raw database text' } }],
    ['an extra key on a row', { data: { ok: true, connections: [{ id: CONNECTION_ID, messages: true, x: 1 }] }, error: null }],
    ['messages not a boolean', { data: { ok: true, connections: [{ id: CONNECTION_ID, messages: 'true' }] }, error: null }],
    ['impersonating', { data: refused('impersonating'), error: null }],
  ])('%s → the labels as before, no hint, the rows stay', async (_label, res) => {
    mockList.mockResolvedValue(twoRows());
    mockAccess.mockResolvedValue(res);
    const { container } = await renderPage();
    expect(rows()).toHaveLength(2);
    expect(allowed()).toEqual([AI_APPS.allowedRead, AI_APPS.allowedRead]);
    expect(hints()).toEqual([]);
    expect(container.textContent).not.toContain('raw database text');
  });

  it('the read log: one line per read, the section title and the retention sentence', async () => {
    mockList.mockResolvedValue(twoRows());
    mockAccess.mockResolvedValue(accessOk());
    mockReads.mockResolvedValue(readsOk());
    await renderPage();
    expect(screen.getByRole('heading', { name: 'Emails and texts read by AI apps' })).toBeInTheDocument();
    expect(readRows()).toEqual([
      'ChatGPT (OpenAI) saw the preview of an email from Seller Agent <seller@example.test>: Inspection · Fixture dA Street · Nov 24, 2026, 3:57 AM',
      'ChatGPT (OpenAI) saw the preview of an email from Seller Agent <seller@example.test>: Offer accepted · Fixture dA Street · Nov 24, 2026, 3:57 AM',
      'ChatGPT (OpenAI) saw the preview of a text from Seller Agent <seller@example.test> · Fixture dA Street · Nov 24, 2026, 3:57 AM',
    ]);
    expect(screen.getByTestId('ai-reads')).toHaveTextContent(
      'This list is kept for one year, also after you disconnect an app or turn Keepr Cloud off. ' +
        'Once an email or text is no longer online, its entry no longer shows the sender or subject.',
    );
    expect(screen.queryByRole('link', { name: AI_READS.more })).toBeNull();
  });

  it('a removed message and a deleted deal show no sender or subject; an opened part says which part', async () => {
    mockList.mockResolvedValue(twoRows());
    const [r1, r2, r3] = FX.reads.reads;
    mockReads.mockResolvedValue(
      readsOk({
        reads: [
          { ...r1, message_state: 'removed', from: null, subject: null },
          { ...r2, deal_state: 'gone', address: null, message_state: 'removed', from: null, subject: null },
          { ...r3, tool: 'get_message', part: 2 },
        ],
      }),
    );
    await renderPage();
    expect(readRows()).toEqual([
      'ChatGPT (OpenAI) read an email sent Jan 2, 2026 that was later removed from this deal · Fixture dA Street · Nov 24, 2026, 3:57 AM',
      'ChatGPT (OpenAI) read an email sent Jan 1, 2026 from a deal that was deleted · Nov 24, 2026, 3:57 AM',
      'ChatGPT (OpenAI) opened a text from Seller Agent <seller@example.test> (part 2) · Fixture dA Street · Nov 24, 2026, 3:57 AM',
    ]);
  });

  it('no app connected: the empty message and the read log still show', async () => {
    mockList.mockResolvedValue(listOk([]));
    mockReads.mockResolvedValue(readsOk());
    await renderPage();
    expect(screen.getByText(M_A.empty)).toBeInTheDocument();
    expect(readRows()).toHaveLength(3);
    expect(mockAccess).not.toHaveBeenCalled();
  });

  it('an empty log says so', async () => {
    mockList.mockResolvedValue(listOk([]));
    await renderPage();
    expect(screen.getByText('No AI app has read your emails or texts.')).toBeInTheDocument();
  });

  it('a next page: "Show more" links to the cursor; the cursor in the address is sent as p_cursor', async () => {
    const cursor = '2026-11-24T03:57:08.605092Z|' + READ_IDS[2];
    mockList.mockResolvedValue(listOk([]));
    mockReads.mockResolvedValue(readsOk({ next_cursor: cursor }));
    render(await AiAppsPage({ searchParams: Promise.resolve({ reads: cursor }) }));
    expect(screen.getByRole('link', { name: AI_READS.more })).toHaveAttribute('href', `?reads=${encodeURIComponent(cursor)}`);
    expect(mockReads.mock.calls[0][1]).toEqual({ p_cursor: cursor, p_limit: 50 });
  });

  it('a cursor that is not the database format is not sent', async () => {
    mockList.mockResolvedValue(listOk([]));
    render(await AiAppsPage({ searchParams: Promise.resolve({ reads: "x'; drop" }) }));
    expect(mockReads.mock.calls[0][1]).toEqual({ p_cursor: null, p_limit: 50 });
  });

  it.each([
    ['a transport error', { data: null, error: { name: 'PostgrestError', code: 'XX000', message: 'raw database text' } }],
    ['an extra key on a read', null],
    ['a subject that is not text', null],
    ['impersonating', { data: refused('impersonating'), error: null }],
  ])('%s → the log shows its load-failure line; the rest of the page stays', async (label, res) => {
    mockList.mockResolvedValue(twoRows());
    const [r1] = FX.reads.reads;
    const bad =
      label === 'an extra key on a read'
        ? readsOk({ reads: [{ ...r1, extra: 1 }] })
        : label === 'a subject that is not text'
          ? readsOk({ reads: [{ ...r1, subject: 5 }] })
          : res;
    mockReads.mockResolvedValue(bad);
    const { container } = await renderPage();
    expect(rows()).toHaveLength(2);
    expect(within(screen.getByTestId('ai-reads')).getByRole('alert')).toHaveTextContent(AI_READS.loadFailed);
    expect(readRows()).toEqual([]);
    expect(container.textContent).not.toContain('raw database text');
  });
});
