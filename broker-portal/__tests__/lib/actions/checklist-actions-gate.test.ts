/**
 * Checklist server actions — BACKLOG-3474, BACKLOG-3618.
 *
 * The gate is NOT mocked: every action runs the real
 * blockWriteDuringImpersonation and requireChecklistAccess (membership
 * through the BACKLOG-3364 PostgREST emulator, feature through the real
 * fail-closed check). Only the Supabase client, the impersonation cookie reader
 * and next/cache are stand-ins.
 *
 * The client is a RECORDER: every from() and rpc() call is logged with its full
 * chain, so "the save made no table writes" is measured on a recorder that is
 * shown, in the same test, to have seen the save's rpc call.
 *
 * The save's token fixture is TRANSCRIBED: production's `to_json(updated_at)`
 * for a real checklist_templates row, read 2026-09-24 (pm_comments 6501344d) —
 * the serialiser PostgREST uses for a timestamptz column.
 *
 * @jest-environment node
 */

const mockCreateClient = jest.fn();
const mockGetImpersonationSession = jest.fn();
const mockRevalidatePath = jest.fn();

jest.mock('@/lib/supabase/server', () => ({
  createClient: (...args: unknown[]) => mockCreateClient(...args),
}));
jest.mock('@/lib/impersonation', () => ({
  getImpersonationSession: () => mockGetImpersonationSession(),
}));
jest.mock('next/cache', () => ({
  revalidatePath: (...args: unknown[]) => mockRevalidatePath(...args),
}));

import {
  archiveChecklistTemplate,
  restoreChecklistTemplate,
  saveChecklistTemplate,
  type SaveChecklistTemplateInput,
} from '@/lib/actions/checklists';
import { CHECKLIST_FEATURE_KEY } from '@/lib/checklist-access';
import { SAVE_MESSAGES } from '@/lib/checklists/saveErrors';
import { ORG_WITHOUT_PLAN_FEATURES, withFeature } from '../../fixtures/orgFeatures';
import {
  FIXTURE_BROKERAGE_ORG_ID,
  FIXTURE_OTHER_USER_ID,
  FIXTURE_PERSONAL_ORG_ID,
  FIXTURE_USER_ID,
  brokerageMembership,
  createPostgrestEmulator,
  personalMembership,
} from '../../helpers/postgrestEmulator';

const FEATURE_ON = withFeature(ORG_WITHOUT_PLAN_FEATURES, CHECKLIST_FEATURE_KEY, true);
const FEATURE_OFF = withFeature(ORG_WITHOUT_PLAN_FEATURES, CHECKLIST_FEATURE_KEY, false);

/** Transcribed PostgREST text for a real checklist_templates.updated_at (see header). */
const TOKEN = '2026-09-24T18:57:37.552806+00:00';
/** pii-allow-uuid: invented fixture id */
const TEMPLATE_ID = '00000000-0000-4000-8000-0000003474a1';
/** pii-allow-uuid: invented fixture id */
const OTHER_ORG_ID = '00000000-0000-4000-8000-0000003474ff';

type Call = { method: string; args: unknown[] };
interface TableCall {
  table: string;
  calls: Call[];
}

interface Setup {
  role?: string;
  /** A solo user: the only membership is their personal organization. */
  personal?: boolean;
  features?: unknown;
  /** BACKLOG-3618: what the agent's ownership pre-read (maybeSingle) returns. */
  read?: { data?: unknown; error?: unknown };
  impersonating?: boolean;
  save?: { data?: unknown; error?: unknown };
  write?: { data?: unknown; error?: unknown };
}

function setup(opts: Setup = {}) {
  const emu = createPostgrestEmulator({
    rows: { organization_members: [opts.personal ? personalMembership() : brokerageMembership(opts.role ?? 'broker')] },
  });
  const tableCalls: TableCall[] = [];
  const fromLog: string[] = [];
  const rpcLog: { fn: string; args: Record<string, unknown> }[] = [];

  function recorder(table: string) {
    const entry: TableCall = { table, calls: [] };
    tableCalls.push(entry);
    const chain: Record<string, unknown> = {};
    for (const m of ['select', 'update', 'insert', 'upsert', 'delete', 'eq', 'is', 'not', 'in', 'order', 'maybeSingle']) {
      chain[m] = (...args: unknown[]) => {
        entry.calls.push({ method: m, args });
        return chain;
      };
    }
    chain.then = (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) =>
      Promise.resolve(
        entry.calls.some((c) => c.method === 'maybeSingle')
          ? { data: null, error: null, ...opts.read }
          : { data: [{ id: TEMPLATE_ID }], error: null, ...opts.write }
      ).then(res, rej);
    return chain;
  }

  const client = {
    auth: { getUser: async () => ({ data: { user: { id: FIXTURE_USER_ID } } }) },
    from: (t: string) => {
      fromLog.push(t);
      return t === 'organization_members' ? emu.from(t) : recorder(t);
    },
    rpc: async (fn: string, args: Record<string, unknown>) => {
      rpcLog.push({ fn, args });
      if (fn === 'can_edit_checklist_templates') {
        // Stands in for the database (harness C4, C5, C41): editor role (or the
        // personal organization's owner) AND feature on.
        const role = opts.role ?? 'broker';
        return {
          data: (opts.personal || ['broker', 'admin', 'it_admin'].includes(role)) && (opts.features ?? FEATURE_ON) !== FEATURE_OFF,
          error: null,
        };
      }
      if (fn === 'can_create_own_checklist_templates') {
        // BACKLOG-3618 (migration 20261001054306 §2): any member AND feature on.
        return { data: (opts.features ?? FEATURE_ON) !== FEATURE_OFF, error: null };
      }
      if (fn === 'save_checklist_template') {
        return { data: [{ id: TEMPLATE_ID, updated_at: '2026-09-24T19:21:08.951159+00:00' }], error: null, ...opts.save };
      }
      return { data: null, error: { code: 'PGRST202', message: 'unexpected rpc in test' } };
    },
  };
  mockCreateClient.mockResolvedValue(client);
  mockGetImpersonationSession.mockResolvedValue(
    opts.impersonating ? { session_id: 's', target_user_id: 't', admin_user_id: 'a' } : null
  );
  const saves = () => rpcLog.filter((r) => r.fn === 'save_checklist_template');
  const writes = () => tableCalls.filter((t) => t.calls.some((c) => ['update', 'insert', 'upsert', 'delete'].includes(c.method)));
  return { rpcLog, fromLog, tableCalls, saves, writes };
}

function input(over: Partial<SaveChecklistTemplateInput> = {}): SaveChecklistTemplateInput {
  return {
    templateId: TEMPLATE_ID,
    expectedUpdatedAt: TOKEN,
    payload: {
      name: 'Residential purchase',
      description: null,
      items: [
        { id: 'item-1', title: 'Executed purchase contract', description: null, is_required: true, expected_document_type: 'contract' },
        { title: 'Inspection report', description: null, is_required: false, expected_document_type: null },
      ],
    },
    ...over,
  };
}

let warnSpy: jest.SpyInstance;
let errorSpy: jest.SpyInstance;
beforeEach(() => {
  mockCreateClient.mockReset();
  mockGetImpersonationSession.mockReset();
  mockRevalidatePath.mockReset();
  warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
  errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  warnSpy.mockRestore();
  errorSpy.mockRestore();
});

describe('saveChecklistTemplate — one database call', () => {
  it('makes exactly ONE save_checklist_template rpc and ZERO table writes [M13]', async () => {
    const { saves, writes, fromLog, rpcLog } = setup();
    const result = await saveChecklistTemplate(input());
    expect(result).toEqual({ ok: true, id: TEMPLATE_ID, updatedAt: '2026-09-24T19:21:08.951159+00:00' });
    // The recorder is live: it saw the save and the gate's own calls.
    expect(saves()).toHaveLength(1);
    expect(rpcLog.map((r) => r.fn)).toContain('can_edit_checklist_templates');
    expect(fromLog).toContain('organization_members');
    // ...and nothing else touched a table.
    expect(fromLog.filter((t) => t !== 'organization_members')).toEqual([]);
    expect(writes()).toEqual([]);
  });

  it('passes the organization the gate resolved, never one the browser sent [M14]', async () => {
    const { saves } = setup();
    const tampered = { ...input(), organizationId: OTHER_ORG_ID, p_org_id: OTHER_ORG_ID } as SaveChecklistTemplateInput;
    await saveChecklistTemplate(tampered);
    expect(saves()[0].args.p_org_id).toBe(FIXTURE_BROKERAGE_ORG_ID);
  });

  it('passes the updated_at token byte-for-byte, microseconds included [A1]', async () => {
    const { saves } = setup();
    await saveChecklistTemplate(input());
    expect(saves()[0].args.p_expected_updated_at).toBe(TOKEN);
  });

  it('sends the payload as-is: template id, name, description and items in order', async () => {
    const { saves } = setup();
    const i = input();
    await saveChecklistTemplate(i);
    expect(saves()[0].args).toEqual({
      p_org_id: FIXTURE_BROKERAGE_ORG_ID,
      p_template_id: TEMPLATE_ID,
      p_expected_updated_at: TOKEN,
      p_name: 'Residential purchase',
      p_description: null,
      p_items: i.payload.items,
    });
  });

  it('create: NULL template id and NULL token', async () => {
    const { saves } = setup();
    await saveChecklistTemplate(input({ templateId: null, expectedUpdatedAt: 'ignored' }));
    expect(saves()[0].args).toMatchObject({ p_template_id: null, p_expected_updated_at: null });
  });

  it('returns the new token verbatim, so the next save can use it [A3]', async () => {
    const { saves } = setup({ save: { data: [{ id: TEMPLATE_ID, updated_at: '2026-09-24T20:00:00.000001+00:00' }] } });
    const first = await saveChecklistTemplate(input());
    expect(first).toMatchObject({ ok: true, updatedAt: '2026-09-24T20:00:00.000001+00:00' });
    if (!first.ok) throw new Error('unreachable');
    await saveChecklistTemplate(input({ expectedUpdatedAt: first.updatedAt }));
    expect(saves()[1].args.p_expected_updated_at).toBe('2026-09-24T20:00:00.000001+00:00');
  });

  it('revalidates the list after a save', async () => {
    setup();
    await saveChecklistTemplate(input());
    expect(mockRevalidatePath).toHaveBeenCalledWith('/dashboard/checklists');
  });
});

describe('saveChecklistTemplate — what a failure says', () => {
  it.each([
    ['not_authorized', { code: '42501', message: 'not_authorized' }],
    ['stale', { code: 'P0001', message: 'stale_or_not_found' }],
    ['unavailable', { code: 'PGRST202', message: 'Could not find the function public.save_checklist_template(...) in the schema cache' }],
    ['invalid', { code: '23514', message: 'new row for relation "checklist_template_items" violates check constraint' }],
    ['invalid', { code: '22023', message: 'invalid_items' }],
    ['invalid', { code: 'P0001', message: 'item_mismatch' }],
    ['failed', { code: '08006', message: 'connection failure' }],
  ])('%s for %j', async (reason, error) => {
    setup({ save: { data: null, error } });
    const result = await saveChecklistTemplate(input());
    expect(result).toEqual({ ok: false, reason, message: SAVE_MESSAGES[reason as keyof typeof SAVE_MESSAGES] });
  });

  // A9: a refused user must not read "changed since you opened it".
  it('not_authorized and stale carry different messages [A9]', () => {
    expect(SAVE_MESSAGES.not_authorized).not.toBe(SAVE_MESSAGES.stale);
    expect(SAVE_MESSAGES.unavailable).not.toBe(SAVE_MESSAGES.stale);
  });

  it('a success with no row is a failure, not "Saved"', async () => {
    setup({ save: { data: [], error: null } });
    expect(await saveChecklistTemplate(input())).toMatchObject({ ok: false, reason: 'failed' });
  });
});

describe('saveChecklistTemplate — refusals make no save call', () => {
  it.each([
    ['during impersonation', { impersonating: true, role: 'admin' }],
    ['for an agent with the feature off', { role: 'agent', features: FEATURE_OFF }],
    ['with the feature off', { features: FEATURE_OFF }],
  ] as const)('%s', async (_label, opts) => {
    const { saves, writes } = setup(opts);
    expect(await saveChecklistTemplate(input())).toMatchObject({ ok: false, reason: 'not_authorized' });
    expect(saves()).toEqual([]);
    expect(writes()).toEqual([]);
  });

  it.each([
    ['an empty item list', input({ payload: { name: 'x', description: null, items: [] } })],
    ['a blank name', input({ payload: { ...input().payload, name: '  ' } })],
    ['an existing template with no token', input({ expectedUpdatedAt: null })],
    ['a non-object', null as unknown as SaveChecklistTemplateInput],
  ])('re-validates on the server: %s', async (_label, bad) => {
    const { saves } = setup();
    expect(await saveChecklistTemplate(bad)).toMatchObject({ ok: false, reason: 'invalid' });
    expect(saves()).toEqual([]);
  });
});

describe('archive / restore', () => {
  function updateCall(tableCalls: TableCall[]) {
    const t = tableCalls.find((c) => c.table === 'checklist_templates');
    if (!t) throw new Error('no checklist_templates call recorded');
    return t.calls;
  }

  it('archive sets archived_at on the active template, scoped to the gate org [M6]', async () => {
    const { tableCalls } = setup();
    expect(await archiveChecklistTemplate(TEMPLATE_ID)).toEqual({ ok: true });
    const calls = updateCall(tableCalls);
    const update = calls.find((c) => c.method === 'update')!;
    expect(typeof (update.args[0] as { archived_at: unknown }).archived_at).toBe('string');
    expect(calls).toContainEqual({ method: 'eq', args: ['id', TEMPLATE_ID] });
    expect(calls).toContainEqual({ method: 'eq', args: ['organization_id', FIXTURE_BROKERAGE_ORG_ID] });
    expect(calls).toContainEqual({ method: 'is', args: ['archived_at', null] });
    expect(mockRevalidatePath).toHaveBeenCalledWith('/dashboard/checklists');
  });

  it('restore clears archived_at on an archived template, scoped to the gate org', async () => {
    const { tableCalls } = setup();
    expect(await restoreChecklistTemplate(TEMPLATE_ID)).toEqual({ ok: true });
    const calls = updateCall(tableCalls);
    expect(calls.find((c) => c.method === 'update')!.args[0]).toEqual({ archived_at: null });
    expect(calls).toContainEqual({ method: 'eq', args: ['organization_id', FIXTURE_BROKERAGE_ORG_ID] });
    expect(calls).toContainEqual({ method: 'not', args: ['archived_at', 'is', null] });
  });

  it('reports a row that did not change (already archived, or not this org)', async () => {
    setup({ write: { data: [] } });
    expect(await archiveChecklistTemplate(TEMPLATE_ID)).toMatchObject({ ok: false });
    expect(mockRevalidatePath).not.toHaveBeenCalled();
  });

  it.each([
    ['archive', archiveChecklistTemplate],
    ['restore', restoreChecklistTemplate],
  ] as const)('%s refuses with the feature off, during impersonation and for an agent [M7]', async (_l, action) => {
    for (const opts of [{ features: FEATURE_OFF }, { impersonating: true, role: 'admin' }, { role: 'agent', features: FEATURE_OFF }]) {
      const { writes } = setup(opts);
      expect(await action(TEMPLATE_ID)).toMatchObject({ ok: false });
      expect(writes()).toEqual([]);
    }
  });
});

// ---------------------------------------------------------------------------
// BACKLOG-3618: own checklists — scope, the switch, and what a refusal says
// ---------------------------------------------------------------------------

const create = (over: Partial<SaveChecklistTemplateInput['payload']> = {}) =>
  input({ templateId: null, expectedUpdatedAt: null, payload: { ...input().payload, ...over } });

describe('BACKLOG-3618 — the scope of a new template is decided on the server', () => {
  it('S1 an agent creates their own (p_personal: true)', async () => {
    const { saves } = setup({ role: 'agent' });
    expect(await saveChecklistTemplate(create())).toMatchObject({ ok: true });
    expect(saves()[0].args.p_personal).toBe(true);
  });

  it.each(['broker', 'admin', 'it_admin'])('S2 a %s creates a brokerage template (no p_personal)', async (role) => {
    const { saves } = setup({ role });
    await saveChecklistTemplate(create());
    expect(saves()[0].args).not.toHaveProperty('p_personal');
  });

  it('S3 a solo user creates in their one list (no p_personal) [C8]', async () => {
    const { saves } = setup({ personal: true });
    expect(await saveChecklistTemplate(create())).toMatchObject({ ok: true });
    expect(saves()[0].args.p_org_id).toBe(FIXTURE_PERSONAL_ORG_ID);
    expect(saves()[0].args).not.toHaveProperty('p_personal');
  });

  it('S4 editing an existing template never sends p_personal (the row decides)', async () => {
    const { saves } = setup({ role: 'agent' });
    await saveChecklistTemplate(input());
    expect(saves()[0].args).not.toHaveProperty('p_personal');
  });

  it('S5 a browser cannot ask for a scope: extra fields are ignored', async () => {
    const { saves } = setup({ role: 'broker' });
    const tampered = { ...create(), personal: true, p_personal: true } as SaveChecklistTemplateInput;
    await saveChecklistTemplate(tampered);
    expect(saves()[0].args).not.toHaveProperty('p_personal');
  });
});

describe('BACKLOG-3618 — Send with submissions: sent only when the editor changed it', () => {
  it.each([true, false])('T1 include_in_submission %s reaches the database as p_include_in_submission', async (value) => {
    const { saves } = setup({ role: 'agent' });
    await saveChecklistTemplate(input({ payload: { ...input().payload, include_in_submission: value } }));
    expect(saves()[0].args.p_include_in_submission).toBe(value);
  });

  it('T2 omitted in the payload, omitted in the call (the database keeps the stored value)', async () => {
    const { saves } = setup({ role: 'agent' });
    await saveChecklistTemplate(input());
    expect(saves()[0].args).not.toHaveProperty('p_include_in_submission');
  });

  it('T3 a non-boolean is refused before the database', async () => {
    const { saves } = setup({ role: 'agent' });
    const bad = input({ payload: { ...input().payload, include_in_submission: 'false' as unknown as boolean } });
    expect(await saveChecklistTemplate(bad)).toMatchObject({ ok: false, reason: 'invalid' });
    expect(saves()).toEqual([]);
  });
});

describe('BACKLOG-3618 — what a refused save says', () => {
  it('R1 an agent saving a brokerage template is told only the broker can change it', async () => {
    setup({ role: 'agent', save: { data: null, error: { code: '42501', message: 'not_authorized' } } });
    expect(await saveChecklistTemplate(input())).toEqual({
      ok: false,
      reason: 'brokerage_read_only',
      message: 'Only your broker or an admin can change brokerage checklists.',
    });
  });

  it('R2 a broker refused by the database keeps the general message', async () => {
    setup({ role: 'broker', save: { data: null, error: { code: '42501', message: 'not_authorized' } } });
    expect(await saveChecklistTemplate(input())).toMatchObject({ reason: 'not_authorized' });
  });

  it('R3 "not sent" on a brokerage template has its own message, not "invalid"', async () => {
    setup({ role: 'broker', save: { data: null, error: { code: '22023', message: 'not_excludable' } } });
    expect(await saveChecklistTemplate(input())).toEqual({
      ok: false,
      reason: 'not_excludable',
      message: 'Brokerage checklists are always sent with submissions.',
    });
  });
});

describe('BACKLOG-3618 — archive / restore by an agent', () => {
  it.each([
    ['archive', archiveChecklistTemplate],
    ['restore', restoreChecklistTemplate],
  ] as const)('A1 %s of a brokerage template is refused before any write', async (_l, action) => {
    const { writes, tableCalls } = setup({ role: 'agent', read: { data: { id: TEMPLATE_ID, owner_user_id: null } } });
    expect(await action(TEMPLATE_ID)).toEqual({
      ok: false,
      message: 'Only your broker or an admin can change brokerage checklists.',
    });
    expect(writes()).toEqual([]);
    // The read is live and scoped to the gate's org.
    expect(tableCalls[0].calls).toContainEqual({ method: 'eq', args: ['organization_id', FIXTURE_BROKERAGE_ORG_ID] });
  });

  it("A2 another user's template is not found, and nothing is written", async () => {
    const { writes } = setup({ role: 'agent', read: { data: { id: TEMPLATE_ID, owner_user_id: FIXTURE_OTHER_USER_ID } } });
    expect(await archiveChecklistTemplate(TEMPLATE_ID)).toEqual({ ok: false, message: 'That template could not be found.' });
    expect(writes()).toEqual([]);
  });

  it('A3 a template the read cannot see is not found, and nothing is written', async () => {
    const { writes } = setup({ role: 'agent', read: { data: null } });
    expect(await archiveChecklistTemplate(TEMPLATE_ID)).toEqual({ ok: false, message: 'That template could not be found.' });
    expect(writes()).toEqual([]);
  });

  it('A4 the agent archives their own', async () => {
    const { writes } = setup({ role: 'agent', read: { data: { id: TEMPLATE_ID, owner_user_id: FIXTURE_USER_ID } } });
    expect(await archiveChecklistTemplate(TEMPLATE_ID)).toEqual({ ok: true });
    expect(writes()).toHaveLength(1);
  });

  it('A5 an editor makes no ownership read (unchanged path)', async () => {
    const { tableCalls } = setup({ role: 'broker' });
    expect(await archiveChecklistTemplate(TEMPLATE_ID)).toEqual({ ok: true });
    expect(tableCalls.flatMap((t) => t.calls).some((c) => c.method === 'maybeSingle')).toBe(false);
  });
});
