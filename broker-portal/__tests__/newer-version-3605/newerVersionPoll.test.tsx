/**
 * BACKLOG-3605: the review page notices a newer version while it is open.
 *
 * Renders the REAL SubmissionVersions -> NewerVersionNotice -> useNewerVersionPoll
 * -> walkNewer (lib/submissions/versions.ts) against the BACKLOG-3364 PostgREST
 * emulator, so `.eq('parent_submission_id', …)` and `.neq('status','uploading')`
 * are evaluated, not assumed. The browser client is the emulator behind a thin
 * wrapper that counts reads actually sent and can hold or fail one.
 *
 * FIXTURE PROVENANCE: row shape from __tests__/helpers/submissionRows.ts
 * (transcribed from production, values invented), chained as the desktop
 * producer writes a new version: a child row inserted `uploading` with
 * parent_submission_id = the previous version, then finalised to
 * `resubmitted`. One child per parent, created_at increasing (the emulator
 * records `.order()` but does not apply it). Every id is invented.
 */

import type React from 'react';
import { act, render } from '@testing-library/react';
import '@testing-library/jest-dom';
import { createPostgrestEmulator, FIXTURE_BROKERAGE_ORG_ID, type Row } from '../helpers/postgrestEmulator';
import { submissionRow } from '../helpers/submissionRows';

const mockEmulator = createPostgrestEmulator();
const mockNet = {
  sent: 0,
  gate: null as Promise<void> | null,
  fail: null as null | 'error' | 'throw',
};

/** Forward every chain call to the emulator; count and optionally hold/fail the read. */
function mockWrap(chain: ReturnType<typeof mockEmulator.from>): unknown {
  const proxy: unknown = new Proxy(chain, {
    get(target, prop) {
      if (prop === 'then') {
        return (ok: (v: unknown) => unknown, bad?: (e: unknown) => unknown) => {
          mockNet.sent += 1;
          return (mockNet.gate ?? Promise.resolve())
            .then(() => {
              if (mockNet.fail === 'throw') throw new Error('network down');
              if (mockNet.fail === 'error') {
                return { data: null, error: { code: 'PGRST000', message: 'failed', details: null, hint: null }, status: 503 };
              }
              return target.then((r) => r);
            })
            .then(ok, bad);
        };
      }
      const value = (target as Record<string | symbol, unknown>)[prop];
      if (typeof value !== 'function') return value;
      return (...args: unknown[]) => {
        const out = (value as (...a: unknown[]) => unknown).apply(target, args);
        return out === target ? proxy : out;
      };
    },
  });
  return proxy;
}

jest.mock('@/lib/supabase/client', () => ({
  createClient: jest.fn(() => ({ from: (t: string) => mockWrap(mockEmulator.from(t)) })),
}));
jest.mock('next/link', () => ({
  __esModule: true,
  default: ({ children, href, ...rest }: { children: React.ReactNode; href: string }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

import { SubmissionVersions } from '@/components/submission/SubmissionVersions';
import { loadVersionChain, type VersionLink, type VersionRow } from '@/lib/submissions/versions';
import type { SupabaseClient } from '@supabase/supabase-js';

const AGENT = '00000000-0000-4000-8000-0000003605a1'; // pii-allow-uuid: invented fixture id
const V1 = '00000000-0000-4000-8000-000000360501'; // pii-allow-uuid: invented fixture id
const V2 = '00000000-0000-4000-8000-000000360502'; // pii-allow-uuid: invented fixture id
const V3 = '00000000-0000-4000-8000-000000360503'; // pii-allow-uuid: invented fixture id
const OTHER_DEAL = '00000000-0000-4000-8000-000000360590'; // pii-allow-uuid: invented fixture id

const TICK = 30_000;

function version(id: string, n: number | null, status: string, parent: string | null, createdAt: string): Row {
  return {
    ...submissionRow({ id, organizationId: FIXTURE_BROKERAGE_ORG_ID, submittedBy: AGENT, status, parentSubmissionId: parent, createdAt }),
    version: n,
  };
}

const v1 = (n: number | null = 1) => version(V1, n, 'needs_changes', null, '2026-09-01T00:00:00Z');
const v2 = (status = 'resubmitted', n: number | null = 2) => version(V2, n, status, V1, '2026-09-02T00:00:00Z');
const v3 = (n: number | null = 3) => version(V3, n, 'resubmitted', V2, '2026-09-03T00:00:00Z');

function rows(list: Row[]): void {
  mockEmulator.set({ rows: { transaction_submissions: list } });
}

let visibility: DocumentVisibilityState = 'visible';
Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => visibility });

async function setVisibility(v: DocumentVisibilityState): Promise<void> {
  visibility = v;
  await act(async () => {
    document.dispatchEvent(new Event('visibilitychange'));
    await Promise.resolve();
  });
}

async function advance(ms: number): Promise<void> {
  await act(async () => {
    await jest.advanceTimersByTimeAsync(ms);
  });
}

type Props = React.ComponentProps<typeof SubmissionVersions>;
const onV1: Props = { previous: [], newest: null, currentId: V1, poll: true };

function notices(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>('[data-testid="newer-version-notice"]'));
}
function href(el: HTMLElement): string | null {
  return el.querySelector('a')?.getAttribute('href') ?? null;
}

beforeEach(() => {
  jest.useFakeTimers();
  mockEmulator.reset();
  mockNet.sent = 0;
  mockNet.gate = null;
  mockNet.fail = null;
  visibility = 'visible';
});
afterEach(() => {
  jest.useRealTimers();
});

describe('probe', () => {
  it('P0: the visibility override is live (jsdom defaults to prerender)', () => {
    expect(document.visibilityState).toBe('visible');
    visibility = 'hidden';
    expect(document.visibilityState).toBe('hidden');
  });
});

describe('what the poll finds', () => {
  it('C1: another deal\x27s version is never offered; only a child of this version counts', async () => {
    rows([version(OTHER_DEAL, 1, 'resubmitted', null, '2026-09-01T00:00:00Z'), v1()]);
    const { container } = render(<SubmissionVersions {...onV1} />);
    await advance(3 * TICK);
    expect(mockNet.sent).toBe(3);
    expect(notices(container)).toHaveLength(0);
    // the query asks for the newest child first
    expect(mockEmulator.state.orders).toContainEqual({
      table: 'transaction_submissions',
      column: 'created_at',
      options: { ascending: false },
    });
  });

  it('C2: a version still uploading is not offered; once it lands, it is', async () => {
    rows([v1(), v2('uploading')]);
    const { container } = render(<SubmissionVersions {...onV1} />);
    await advance(TICK);
    expect(mockNet.sent).toBe(1);
    expect(notices(container)).toHaveLength(0);

    rows([v1(), v2('resubmitted')]);
    await advance(TICK);
    const [n] = notices(container);
    expect(n).toHaveTextContent('A newer version was submitted — View v2');
    expect(href(n)).toBe(`/dashboard/submissions/${V2}`);
  });

  it('C3: when two newer versions exist, the notice links to the newest', async () => {
    rows([v1()]);
    const { container } = render(<SubmissionVersions {...onV1} />);
    rows([v1(), v2(), v3()]);
    await advance(TICK);
    const all = notices(container);
    expect(all).toHaveLength(1);
    expect(all[0]).toHaveTextContent('A newer version was submitted — View v3');
    expect(href(all[0])).toBe(`/dashboard/submissions/${V3}`);
  });

  it('C3b: the polled notice reads exactly like the server-rendered one, null version numbers included', async () => {
    const chain = [v1(null), v2('resubmitted', null), v3(null)];
    rows(chain);
    const server = await loadVersionChain(mockEmulator as unknown as SupabaseClient, chain[0] as unknown as VersionRow);
    expect(server.newest).not.toBeNull();
    const serverDom = render(<SubmissionVersions previous={server.previous} newest={server.newest} currentId={V1} poll />);
    const serverText = notices(serverDom.container)[0].textContent;
    const serverHref = href(notices(serverDom.container)[0]);
    serverDom.unmount();

    rows([v1(null)]);
    const polled = render(<SubmissionVersions {...onV1} />);
    rows(chain);
    await advance(TICK);
    const [n] = notices(polled.container);
    expect(n.textContent).toBe(serverText);
    expect(href(n)).toBe(serverHref);
    expect(n).toHaveTextContent('View v3');
  });
});

describe('when it polls', () => {
  it('C4: after a hit it stops for good — no timer left, no reads, not even on a tab switch', async () => {
    rows([v1(), v2()]);
    const { container } = render(<SubmissionVersions {...onV1} />);
    await advance(TICK);
    expect(notices(container)).toHaveLength(1);
    const after = mockNet.sent;
    expect(jest.getTimerCount()).toBe(0);
    await advance(4 * TICK);
    await setVisibility('hidden');
    await setVisibility('visible');
    await advance(2 * TICK);
    expect(mockNet.sent).toBe(after);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('C5: hidden reads nothing; each return to visible reads once, then exactly one read per 30 s', async () => {
    rows([v1()]);
    render(<SubmissionVersions {...onV1} />);
    await advance(TICK);
    expect(mockNet.sent).toBe(1);

    await setVisibility('hidden');
    await advance(3 * TICK);
    expect(mockNet.sent).toBe(1);
    await setVisibility('visible');
    expect(mockNet.sent).toBe(2);

    await setVisibility('hidden');
    await advance(TICK);
    await setVisibility('visible');
    expect(mockNet.sent).toBe(3);

    for (let i = 1; i <= 3; i += 1) {
      await advance(TICK);
      expect(mockNet.sent).toBe(3 + i);
    }
    expect(jest.getTimerCount()).toBe(1);
  });

  it('C6: unmount after a tab switch leaves no timer and no listener', async () => {
    const baseline = render(<SubmissionVersions {...onV1} poll={false} />);
    const base = jest.getTimerCount();
    baseline.unmount();
    expect(base).toBe(0);

    rows([v1()]);
    const removeSpy = jest.spyOn(document, 'removeEventListener');
    const { unmount } = render(<SubmissionVersions {...onV1} />);
    await setVisibility('hidden');
    await setVisibility('visible');
    expect(jest.getTimerCount()).toBe(1);
    unmount();
    expect(jest.getTimerCount()).toBe(0);
    expect(removeSpy).toHaveBeenCalledWith('visibilitychange', expect.any(Function));
    const sent = mockNet.sent;
    await advance(3 * TICK);
    expect(mockNet.sent).toBe(sent);
    removeSpy.mockRestore();
  });

  it('C7: a parent re-render with the same props does not restart or add a timer', async () => {
    rows([v1()]);
    const { rerender } = render(<SubmissionVersions {...onV1} />);
    for (let t = 0; t < 4; t += 1) {
      await advance(20_000);
      rerender(<SubmissionVersions {...onV1} />);
    }
    // 80 s elapsed: reads at 30 s and 60 s
    expect(mockNet.sent).toBe(2);
    await advance(10_000);
    expect(mockNet.sent).toBe(3);
  });
});

describe('when it does not poll', () => {
  const seeded: VersionLink = { id: V3, number: 3, status: 'resubmitted', createdAt: '2026-09-03T00:00:00Z' };

  it('C8: the server already found a newer version -> shown at once, no reads', async () => {
    rows([v1(), v2(), v3()]);
    const { container } = render(<SubmissionVersions {...onV1} newest={seeded} />);
    const [n] = notices(container);
    expect(n).toHaveTextContent('A newer version was submitted — View v3');
    expect(href(n)).toBe(`/dashboard/submissions/${V3}`);
    await advance(3 * TICK);
    expect(mockNet.sent).toBe(0);
  });

  it('C9: polling off (support session) -> no reads', async () => {
    rows([v1(), v2()]);
    const { container } = render(<SubmissionVersions {...onV1} poll={false} />);
    await advance(3 * TICK);
    expect(mockNet.sent).toBe(0);
    expect(notices(container)).toHaveLength(0);
  });
});

describe('failures and races', () => {
  it('C10a: a read that answers with an error is no hit; the next tick reads again', async () => {
    rows([v1(), v2()]);
    mockNet.fail = 'error';
    const { container } = render(<SubmissionVersions {...onV1} />);
    await advance(TICK);
    expect(mockNet.sent).toBe(1);
    expect(notices(container)).toHaveLength(0);
    mockNet.fail = null;
    await advance(TICK);
    expect(notices(container)).toHaveLength(1);
  });

  it('C10b: a read that throws is no hit; the next tick reads again', async () => {
    rows([v1(), v2()]);
    mockNet.fail = 'throw';
    const { container } = render(<SubmissionVersions {...onV1} />);
    await advance(TICK);
    expect(mockNet.sent).toBe(1);
    expect(notices(container)).toHaveLength(0);
    mockNet.fail = null;
    await advance(TICK);
    expect(notices(container)).toHaveLength(1);
  });

  it('R1: no second read while one is still pending', async () => {
    rows([v1()]);
    let release: () => void = () => {};
    mockNet.gate = new Promise<void>((r) => (release = r));
    render(<SubmissionVersions {...onV1} />);
    await advance(TICK);
    expect(mockNet.sent).toBe(1);
    await advance(2 * TICK);
    await setVisibility('hidden');
    await setVisibility('visible');
    expect(mockNet.sent).toBe(1);
    mockNet.gate = null;
    await act(async () => {
      release();
      await Promise.resolve();
    });
    await advance(TICK);
    expect(mockNet.sent).toBe(2);
  });

  it('R2: an answer for the previous version, arriving after the page moved on, is ignored', async () => {
    rows([v1(), v2(), v3()]);
    let release: () => void = () => {};
    mockNet.gate = new Promise<void>((r) => (release = r));
    const { container, rerender } = render(<SubmissionVersions {...onV1} />);
    await advance(TICK);
    expect(mockNet.sent).toBe(1);
    // same component instance, now on v3 (no newer version)
    mockNet.gate = null;
    rerender(<SubmissionVersions {...onV1} currentId={V3} previous={[]} />);
    await act(async () => {
      release();
      await jest.advanceTimersByTimeAsync(0);
    });
    expect(notices(container)).toHaveLength(0);
  });

  it('R3: an answer arriving after unmount does nothing', async () => {
    rows([v1(), v2()]);
    const errors = jest.spyOn(console, 'error').mockImplementation(() => {});
    let release: () => void = () => {};
    mockNet.gate = new Promise<void>((r) => (release = r));
    const { unmount } = render(<SubmissionVersions {...onV1} />);
    await advance(TICK);
    unmount();
    await act(async () => {
      release();
      await jest.advanceTimersByTimeAsync(0);
    });
    expect(errors).not.toHaveBeenCalled();
    errors.mockRestore();
  });

  it('R4: server and poll both say so (a refresh after the poll found one) -> exactly one notice, the server\x27s', async () => {
    rows([v1(), v2()]);
    const { container, rerender } = render(<SubmissionVersions {...onV1} />);
    await advance(TICK);
    expect(notices(container)).toHaveLength(1);
    expect(href(notices(container)[0])).toBe(`/dashboard/submissions/${V2}`);

    const serverNewest: VersionLink = { id: V3, number: 3, status: 'resubmitted', createdAt: '2026-09-03T00:00:00Z' };
    rerender(<SubmissionVersions {...onV1} newest={serverNewest} />);
    const all = notices(container);
    expect(all).toHaveLength(1);
    expect(href(all[0])).toBe(`/dashboard/submissions/${V3}`);
    expect(all[0]).toHaveTextContent('View v3');
    const sent = mockNet.sent;
    await advance(3 * TICK);
    expect(mockNet.sent).toBe(sent);
  });
});
