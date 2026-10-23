/**
 * BACKLOG-3991 C24 / C27 / C28 / SR-4 / SR-5: lib/auth/idpNames.ts.
 *
 * fetch is a jest mock (the net guard forbids real network). The timeout mock
 * settles ONLY when the signal it received aborts, so a build that does not pass
 * the signal, or sets no timeout, never settles and the test times out red.
 *
 * @jest-environment node
 */

import { fetchGoogleNames, idpNameArgs, syncIdpNames, GOOGLE_USERINFO_URL } from '@/lib/auth/idpNames';
import { AZURE_METADATA, FIXTURE_TOKEN, GOOGLE_METADATA, GOOGLE_USERINFO, spyConsole } from './fixtures';

const realFetch = global.fetch;
let fetchMock: jest.Mock;
let consoleSpy: ReturnType<typeof spyConsole>;

beforeEach(() => {
  fetchMock = jest.fn();
  global.fetch = fetchMock as unknown as typeof fetch;
  consoleSpy = spyConsole();
});

afterEach(() => {
  global.fetch = realFetch;
  consoleSpy.restore();
  jest.useRealTimers();
});

function okJson(body: unknown): Response {
  return { ok: true, status: 200, json: async () => body } as unknown as Response;
}

/** Resolves only when the signal passed to fetch aborts (then rejects like fetch does). */
function hangUntilAborted(_url: string, init?: RequestInit): Promise<Response> {
  return new Promise((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
  });
}

function userClient(reply: { data: unknown; error: { code?: string } | null } = { data: { success: true, updated: true }, error: null }) {
  return { rpc: jest.fn(async () => reply) };
}

describe('C24 idpNameArgs', () => {
  it('azure: first/last come from custom_claims', () => {
    expect(idpNameArgs(AZURE_METADATA, 'azure')).toEqual({ p_first: 'Avery', p_last: 'Stone', p_display: 'Avery Stone' });
  });

  it('azure: given_name only at the TOP level is not read (Supabase never puts it there)', () => {
    const top = { ...AZURE_METADATA, custom_claims: { tid: 't' }, given_name: 'Top', family_name: 'Level' };
    expect(idpNameArgs(top, 'azure')).toEqual({ p_first: null, p_last: null, p_display: 'Avery Stone' });
  });

  it('no name anywhere -> all null', () => {
    expect(idpNameArgs({ email: 'x@fixture.example.test' }, 'azure')).toEqual({ p_first: null, p_last: null, p_display: null });
    expect(idpNameArgs(null, 'google')).toEqual({ p_first: null, p_last: null, p_display: null });
  });

  it("full_name '   ' passes through: the database is the guard, not this side", () => {
    expect(idpNameArgs({ full_name: '   ' }, 'azure').p_display).toBe('   ');
  });

  it('google: first/last from the userinfo names, display from full_name', () => {
    expect(idpNameArgs(GOOGLE_METADATA, 'google', { given_name: 'Blake', family_name: 'Rivera' })).toEqual({
      p_first: 'Blake',
      p_last: 'Rivera',
      p_display: 'Blake Rivera',
    });
  });
});

describe('C27 Google: userinfo read', () => {
  it('200 -> the rpc gets given/family; the request carries the token and a signal', async () => {
    fetchMock.mockResolvedValue(okJson(GOOGLE_USERINFO));
    const client = userClient();
    await syncIdpNames(client, { app_metadata: { provider: 'google' }, user_metadata: GOOGLE_METADATA }, FIXTURE_TOKEN);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(GOOGLE_USERINFO_URL);
    expect((init as RequestInit).headers).toEqual({ Authorization: `Bearer ${FIXTURE_TOKEN}` });
    expect((init as RequestInit).signal).toBeInstanceOf(AbortSignal);
    expect(client.rpc).toHaveBeenCalledTimes(1);
    expect(client.rpc).toHaveBeenCalledWith('sync_profile_names_from_idp', {
      p_first: 'Blake',
      p_last: 'Rivera',
      p_display: 'Blake Rivera',
    });
  });

  it.each([
    ['500', () => fetchMock.mockResolvedValue({ ok: false, status: 500, json: async () => ({}) })],
    ['a throw', () => fetchMock.mockRejectedValue(new Error('fixture network down'))],
    ['bad JSON', () => fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => { throw new SyntaxError('bad'); } })],
    ['a non-object body', () => fetchMock.mockResolvedValue(okJson(['x']))],
  ])('%s -> first/last null, display still sent, nothing thrown', async (_label, arrange) => {
    arrange();
    const client = userClient();
    await expect(
      syncIdpNames(client, { app_metadata: { provider: 'google' }, user_metadata: GOOGLE_METADATA }, FIXTURE_TOKEN)
    ).resolves.toBeUndefined();
    expect(client.rpc).toHaveBeenCalledWith('sync_profile_names_from_idp', { p_first: null, p_last: null, p_display: 'Blake Rivera' });
    expect(consoleSpy.calls().some((c) => c.includes('google userinfo unavailable'))).toBe(true);
  });

  it('a fetch that never answers is aborted at 3000 ms; sign-in continues with display only', async () => {
    jest.useFakeTimers();
    fetchMock.mockImplementation(hangUntilAborted);
    const client = userClient();
    const done = syncIdpNames(client, { app_metadata: { provider: 'google' }, user_metadata: GOOGLE_METADATA }, FIXTURE_TOKEN);
    await jest.advanceTimersByTimeAsync(2999);
    expect(client.rpc).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(1);
    await done;
    expect(client.rpc).toHaveBeenCalledWith('sync_profile_names_from_idp', { p_first: null, p_last: null, p_display: 'Blake Rivera' });
    expect(consoleSpy.calls()).toContain('google userinfo unavailable: timeout');
  });

  it('fetchGoogleNames resolves null on timeout (direct)', async () => {
    jest.useFakeTimers();
    fetchMock.mockImplementation(hangUntilAborted);
    const p = fetchGoogleNames(FIXTURE_TOKEN, { timeoutMs: 50 });
    await jest.advanceTimersByTimeAsync(50);
    await expect(p).resolves.toBeNull();
  });

  it('no console call ever contains the provider token', async () => {
    fetchMock.mockRejectedValueOnce(new Error(`failed with ${FIXTURE_TOKEN}`));
    await syncIdpNames(userClient(), { app_metadata: { provider: 'google' }, user_metadata: GOOGLE_METADATA }, FIXTURE_TOKEN);
    fetchMock.mockResolvedValueOnce({ ok: false, status: 401, json: async () => ({ token: FIXTURE_TOKEN }) });
    await syncIdpNames(
      userClient({ data: null, error: { code: 'PGRST202' } }),
      { app_metadata: { provider: 'google' }, user_metadata: GOOGLE_METADATA },
      FIXTURE_TOKEN
    );
    expect(consoleSpy.calls().length).toBeGreaterThan(0);
    expect(consoleSpy.calls().filter((c) => c.includes(FIXTURE_TOKEN))).toEqual([]);
  });

  it('google with no provider token: no fetch, display only', async () => {
    const client = userClient();
    await syncIdpNames(client, { app_metadata: { provider: 'google' }, user_metadata: GOOGLE_METADATA }, null);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(client.rpc).toHaveBeenCalledWith('sync_profile_names_from_idp', { p_first: null, p_last: null, p_display: 'Blake Rivera' });
  });
});

describe('C28 Microsoft: no network', () => {
  it('azure path makes zero fetch calls and sends the custom_claims names', async () => {
    const client = userClient();
    await syncIdpNames(client, { app_metadata: { provider: 'azure' }, user_metadata: AZURE_METADATA }, FIXTURE_TOKEN);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(client.rpc).toHaveBeenCalledWith('sync_profile_names_from_idp', { p_first: 'Avery', p_last: 'Stone', p_display: 'Avery Stone' });
  });
});

describe('SR-4: a refusal in the reply is visible', () => {
  it.each([
    ['success:false not_authenticated (a service client: auth.uid() is NULL)', { data: { success: false, error: 'not_authenticated' }, error: null }, 'sync_profile_names_from_idp refused: not_authenticated'],
    ['success:false no_user_row', { data: { success: false, error: 'no_user_row' }, error: null }, 'sync_profile_names_from_idp refused: no_user_row'],
    ['a returned error (function missing)', { data: null, error: { code: 'PGRST202' } }, 'sync_profile_names_from_idp failed: PGRST202'],
  ])('%s -> logged by code', async (_l, reply, line) => {
    await syncIdpNames(userClient(reply), { app_metadata: { provider: 'azure' }, user_metadata: AZURE_METADATA }, null);
    expect(consoleSpy.calls()).toContain(line);
  });

  it('a success reply logs nothing', async () => {
    await syncIdpNames(userClient(), { app_metadata: { provider: 'azure' }, user_metadata: AZURE_METADATA }, null);
    expect(consoleSpy.calls()).toEqual([]);
  });

  it('a throwing client never escapes', async () => {
    const client = { rpc: jest.fn(async () => { throw new Error('boom'); }) };
    await expect(
      syncIdpNames(client, { app_metadata: { provider: 'azure' }, user_metadata: AZURE_METADATA }, null)
    ).resolves.toBeUndefined();
    expect(consoleSpy.calls()).toContain('sync_profile_names_from_idp failed: exception');
  });

  it('no names at all -> no rpc call', async () => {
    const client = userClient();
    await syncIdpNames(client, { app_metadata: { provider: 'email' }, user_metadata: {} }, null);
    expect(client.rpc).not.toHaveBeenCalled();
  });
});
