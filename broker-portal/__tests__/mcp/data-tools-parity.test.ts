/**
 * @jest-environment node
 *
 * BACKLOG-4244 — parity of the data tools with their sources, read from the files:
 * - C15: the argument names rpc.ts sends equal the migration's parameter names.
 * - C24: the keys the readers project equal the shared deal shape
 *   (supabase/contracts/cloud-deal-shape-v1.json) and the portal shapes (lib/mcp/tools/shapes.ts).
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';

const mockRpc = jest.fn();
jest.mock('@supabase/supabase-js', () => ({ createClient: () => ({ rpc: (...a: unknown[]) => mockRpc(...a) }) }));

import { getDealChecklistsFor, getDealFor, listDealsFor } from '@/lib/mcp/oauth/rpc';
import { DEADLINE_PROPS, DETAILS_PROPS, EMAIL_PROPS, LIST_DEALS_SHAPE, PERSON_PROPS, PHONE_PROPS } from '@/lib/mcp/tools/shapes';

const REPO = path.resolve(__dirname, '../../..');
const MIGRATION = readFileSync(path.join(REPO, 'supabase/migrations/20261114110000_backlog_4244_mcp_data_tools.sql'), 'utf8');
const CONTRACT = JSON.parse(readFileSync(path.join(REPO, 'supabase/contracts/cloud-deal-shape-v1.json'), 'utf8'));

function parameterNames(sql: string, fn: string): string[] {
  const re = new RegExp(`CREATE OR REPLACE FUNCTION public\\.${fn}\\(([^)]*)\\)`, 'g');
  const matches = [...sql.matchAll(re)];
  if (matches.length !== 1) throw new Error(`${fn}: expected one definition, found ${matches.length}`);
  return matches[0][1]
    .split(',')
    .map((p) => p.trim().split(/\s+/)[0])
    .filter((n) => n.length > 0);
}

/** The body of a function in the migration text. */
function body(sql: string, fn: string): string {
  const i = sql.indexOf(`CREATE OR REPLACE FUNCTION public.${fn}(`);
  if (i < 0) throw new Error(fn);
  const b0 = sql.indexOf('AS $fn$', i);
  return sql.slice(b0, sql.indexOf('$fn$;', b0 + 7));
}

/** Keys of the jsonb_build_object that follows `anchor`: its top-level arguments at even positions. */
function pairKeys(text: string, anchor: string): string[] {
  const i = text.indexOf(anchor);
  if (i < 0) throw new Error(`anchor not found: ${anchor}`);
  let j = text.indexOf('jsonb_build_object(', i) + 'jsonb_build_object('.length;
  const args: string[] = [];
  let depth = 0;
  let cur = '';
  for (; j < text.length; j++) {
    const c = text[j];
    if (c === "'") {
      const end = text.indexOf("'", j + 1);
      cur += text.slice(j, end + 1);
      j = end;
      continue;
    }
    if (c === '(') depth++;
    if (c === ')') {
      if (depth === 0) break;
      depth--;
    }
    if (c === ',' && depth === 0) {
      args.push(cur.trim());
      cur = '';
      continue;
    }
    cur += c;
  }
  args.push(cur.trim());
  return args.filter((_a, n) => n % 2 === 0).map((k) => k.replace(/^'|'$/g, ''));
}

const GET = body(MIGRATION, '_mcp_r_get_deal');
const LIST = body(MIGRATION, '_mcp_r_list_deals');

describe('BACKLOG-4244 C15: rpc parity with the migration', () => {
  const CFG = { supabaseUrl: 'https://project-ref.supabase.co', supabaseAnonKey: 'anon' };
  const A = { secret: 's', atDigest: '\\x00', resource: 'r' };
  const CALLS: Array<[string, () => Promise<unknown>, number]> = [
    ['mcp_list_deals', () => listDealsFor(CFG, { ...A, status: null, addressContains: null, limit: null, cursor: null }), 7],
    ['mcp_get_deal', () => getDealFor(CFG, { ...A, dealId: 'd' }), 4],
    ['mcp_get_deal_checklists', () => getDealChecklistsFor(CFG, { ...A, dealId: 'd', onlyOpen: null, checklistId: null }), 6],
  ];
  it.each(CALLS)('%s: exactly the migration parameter names, nulls kept on the wire', async (fn, run, n) => {
    mockRpc.mockReset();
    mockRpc.mockResolvedValue({ data: { ok: false, error: 'busy' }, error: null });
    await run();
    const [name, args] = mockRpc.mock.calls[0];
    expect(name).toBe(fn);
    const names = parameterNames(MIGRATION, fn);
    expect(names).toHaveLength(n);
    expect(Object.keys(JSON.parse(JSON.stringify(args))).sort()).toEqual([...names].sort());
  });
});

describe('BACKLOG-4244 C24: reader keys = shared deal shape = portal shapes', () => {
  const details = pairKeys(GET, "'details', jsonb_build_object(");
  const email = pairKeys(GET, "SELECT jsonb_agg(jsonb_build_object(\n                       'email'");
  const phone = pairKeys(GET, "SELECT jsonb_agg(jsonb_build_object(\n                       'e164'");
  const person = pairKeys(GET, "e AS (\n      SELECT p.rn, jsonb_build_object(");

  it('positive: the parser reads the key lists', () => {
    expect(details).toHaveLength(14);
    expect(email).toEqual(['email', 'is_primary', 'label']);
    expect(phone).toEqual(['e164', 'display', 'is_primary', 'label']);
    expect(person[0]).toBe('person_id');
  });

  it('deal.details: the contract keys (v is details_version), the reader keys and the portal shape are one set', () => {
    const contract = Object.keys(CONTRACT.deal.details.keys).filter((k) => k !== 'v');
    expect([...details].sort()).toEqual([...contract].sort());
    expect(Object.keys(DETAILS_PROPS).sort()).toEqual([...contract].sort());
    expect(GET).toContain("'details_version', CASE WHEN v_deal.details -> 'v' = '1'::jsonb THEN 1 END");
  });

  it('deal.details types follow the contract', () => {
    for (const [k, t] of Object.entries(CONTRACT.deal.details.keys as Record<string, string>)) {
      if (k === 'v') continue;
      const p = (DETAILS_PROPS as Record<string, { t: string; pattern?: RegExp }>)[k];
      if (t === 'number') expect(p.t).toBe('number');
      else if (t === 'date') expect(p.pattern?.source).toBe('^\\d{4}-\\d{2}-\\d{2}$');
      else expect(t).toBe('string');
      if (t === 'number') expect(GET).toContain(`'${k}', CASE WHEN jsonb_typeof(v_deal.details -> '${k}') = 'number'`);
      if (t === 'date') expect(GET).toContain(`'${k}', CASE WHEN jsonb_typeof(v_deal.details -> '${k}') = 'string' AND v_deal.details ->> '${k}' ~ '^\\d{4}-\\d{2}-\\d{2}$'`);
    }
  });

  it('emails and phones: the contract element keys, the reader keys and the portal shape are one set', () => {
    expect([...email].sort()).toEqual(Object.keys(CONTRACT.party.emails.element).sort());
    expect(Object.keys(EMAIL_PROPS).sort()).toEqual(Object.keys(CONTRACT.party.emails.element).sort());
    expect([...phone].sort()).toEqual(Object.keys(CONTRACT.party.phones.element).sort());
    expect(Object.keys(PHONE_PROPS).sort()).toEqual(Object.keys(CONTRACT.party.phones.element).sort());
  });

  it('people: the reader keys equal the portal shape; withheld blanks and keeps what the contract says', () => {
    expect([...person].sort()).toEqual(Object.keys(PERSON_PROPS).sort());
    const w = CONTRACT.party.details_withheld;
    expect(w.true_when).toBe("contact_source = 'google_contacts'");
    const asOutput: Record<string, string> = { display_name: 'name' };
    for (const col of Object.keys(w.blank_when_true)) expect(Object.keys(PERSON_PROPS)).toContain(asOutput[col] ?? col);
    for (const col of w.kept_when_true as string[]) expect(Object.keys(PERSON_PROPS)).toContain(col);
    expect(GET).toContain("'notes', public._mcp_clean(p.notes, 1000),");
  });

  it('the identity rule: deal_id is cloud_deals.id and no install id or local id is projected', () => {
    expect(CONTRACT.identity.deal_key_exposed_as).toBe('deal_id');
    for (const f of ['_mcp_r_list_deals', '_mcp_r_get_deal', '_mcp_r_deal_checklists']) {
      const b = body(MIGRATION, f);
      for (const k of CONTRACT.identity.origin_metadata as string[]) expect(b).not.toContain(`'${k}'`);
    }
  });

  it('list_deals deadlines: the contract date keys, read with the same date rule as get_deal, and no price', () => {
    const contractDates = Object.entries(CONTRACT.deal.details.keys as Record<string, string>).filter(([, t]) => t === 'date').map(([k]) => k);
    const deadlines = pairKeys(LIST, "'deadlines', jsonb_build_object(");
    expect([...deadlines].sort()).toEqual([...contractDates].sort());
    expect(Object.keys(DEADLINE_PROPS).sort()).toEqual([...contractDates].sort());
    const item = (LIST_DEALS_SHAPE as any).props.deals.items.props;
    expect(Object.keys(item.deadlines.props).sort()).toEqual([...contractDates].sort());
    for (const k of contractDates) {
      expect(LIST).toContain(`'${k}', CASE WHEN jsonb_typeof(pr.details -> '${k}') = 'string' AND pr.details ->> '${k}' ~ '^\\d{4}-\\d{2}-\\d{2}$' THEN pr.details -> '${k}' END`);
    }
    for (const k of Object.keys(DETAILS_PROPS).filter((x) => !contractDates.includes(x))) expect(LIST).not.toContain(`'${k}'`);
  });

  it('positive control: a planted extra key in a copy of the reader text is found', () => {
    const planted = GET.replace("'listing_price', CASE", "'zz_planted', 1, 'listing_price', CASE");
    expect(planted).not.toBe(GET);
    expect(pairKeys(planted, "'details', jsonb_build_object(")).toContain('zz_planted');
  });
});
