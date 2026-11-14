/**
 * BACKLOG-4243 PR-0 — the cloud deal shape contract (supabase/contracts/cloud-deal-shape-v1.json).
 *
 * WHAT THIS CAN PROVE: what the contract file says, and that its lists of codes, columns and write
 * functions match what the migration text defines. CI has no database; behaviour is proved by
 * supabase/tests/backlog-4236.
 */

import { readFileSync } from 'fs';
import { join } from 'path';

const REPO = join(__dirname, '../../..');
const CONTRACT_PATH = join(REPO, 'supabase/contracts/cloud-deal-shape-v1.json');
const M2_PATH = join(REPO, 'supabase/migrations/20261112190000_backlog_4236_cloud_autosave_schema.sql');

const read = (path: string): string => readFileSync(path, 'utf8').replace(/\r\n?/g, '\n');
const C = JSON.parse(read(CONTRACT_PATH));
const M2_RAW = read(M2_PATH);
/** line comments removed, whitespace collapsed */
const M2 = M2_RAW.split('\n')
  .map((line) => line.replace(/--.*$/, ''))
  .join(' ')
  .replace(/\s+/g, ' ');

const sorted = (xs: Iterable<string>): string[] => Array.from(new Set(xs)).sort();
const all = (re: RegExp, text: string): string[] => Array.from(text.matchAll(re), (m) => m[1]);
function body(name: string): string {
  const m = new RegExp(`CREATE OR REPLACE FUNCTION public\\.${name}\\([^)]*\\)[^$]*?AS \\$f\\$(.*?)\\$f\\$;`).exec(M2);
  if (!m) throw new Error(`function ${name} not found`);
  return m[1];
}
function table(name: string): string {
  const m = new RegExp(`CREATE TABLE IF NOT EXISTS public\\.${name} \\((.*?)\\);`).exec(M2);
  if (!m) throw new Error(`table ${name} not found`);
  return m[1];
}

const IDENTITY_RULE =
  "A deal's identity and every lookup key is cloud_deals.id (exposed as deal_id); a child's identity is its id. " +
  'source_install_id and local_*_id are origin metadata: they may label or group rows (for example saved_from), ' +
  'but no reader resolves a deal or person by them, and no reader drops or errors on a row because they are NULL.';
const TOLERANCE_RULE =
  'Clients MUST treat an unknown envelope error as a non-retryable failure of that call (record the code, skip the deal ' +
  'until its next change or the next reconcile); an unknown row status as not saved for that row; an unknown state ' +
  'reason as paused; and MUST ignore unknown keys in any result.';

describe('BACKLOG-4243 cloud deal shape contract v1', () => {
  it('is version 1 at its canonical path', () => {
    expect(C.name).toBe('keepr.cloud_deal_shape');
    expect(C.version).toBe(1);
  });

  it('identity: every lookup is by cloud_deals.id (deal_id) or a child id; install and local ids are origin metadata only', () => {
    expect(C.identity.rule).toBe(IDENTITY_RULE);
    expect(C.identity.deal_key).toBe('cloud_deals.id');
    expect(C.identity.deal_key_exposed_as).toBe('deal_id');
    expect(C.identity.child_key).toBe('id');
    expect(C.identity.origin_metadata_may).toEqual(['label', 'group']);
    expect(C.identity.origin_metadata_must_not).toEqual(['resolve_a_deal_or_person', 'drop_a_row_when_null', 'error_when_null']);
    // the origin metadata list is exactly the install id plus every local_*_id column the migration defines
    const localCols = all(/ (local_[a-z_]+_id) text /g, M2);
    expect(localCols.length).toBeGreaterThan(0);
    expect(sorted(C.identity.origin_metadata)).toEqual(sorted(['source_install_id', ...localCols]));
    // every cloud table that holds deal data is keyed by its own uuid id
    for (const t of ['cloud_deals', 'cloud_deal_parties', 'cloud_deal_checklists', 'cloud_deal_checklist_items', 'cloud_deal_messages', 'cloud_deal_files']) {
      expect(table(t)).toMatch(/^ ?id uuid PRIMARY KEY DEFAULT gen_random_uuid\(\),/);
    }
  });

  it('tolerance: unknown error, status, reason and keys each have one stated meaning', () => {
    expect(C.tolerance.rule).toBe(TOLERANCE_RULE);
    expect(C.tolerance.unknown_envelope_error).toBe('non_retryable_call_failure');
    expect(C.tolerance.unknown_row_status).toBe('not_saved');
    expect(C.tolerance.unknown_state_reason).toBe('paused');
    expect(C.tolerance.unknown_keys).toBe('ignore');
  });

  it('the known codes are exactly the ones the migration emits', () => {
    const errors = all(/'error', '([a-z_]+)'/g, M2);
    expect(errors).toContain('wrong_account');
    // codes emitted only by the service-role function are listed apart from the client codes
    const assign = all(/'error', '([a-z_]+)'/g, body('assign_member_addon'));
    const others = all(/'error', '([a-z_]+)'/g, M2.replace(body('assign_member_addon'), ''));
    const serviceOnly = assign.filter((e) => !others.includes(e));
    expect(serviceOnly.length).toBeGreaterThan(0);
    expect(sorted(C.tolerance.known.service_role_envelope_errors)).toEqual(sorted(serviceOnly));
    expect(sorted(C.tolerance.known.client_envelope_errors)).toEqual(sorted(others));
    expect(sorted([...C.tolerance.known.client_envelope_errors, ...C.tolerance.known.service_role_envelope_errors])).toEqual(sorted(errors));

    const rowStatus = body('_cloud_row_status');
    const statuses = [...all(/'status', '([a-z_]+)'/g, M2), ...all(/THEN '([a-z_]+)'/g, rowStatus), ...all(/ELSE '([a-z_]+)'/g, rowStatus)];
    expect(sorted(C.tolerance.known.row_statuses)).toEqual(sorted(statuses));

    expect(sorted(C.tolerance.known.row_reject_reasons)).toEqual(sorted(all(/'reason', '([a-z_]+)'/g, M2)));

    const state = body('get_my_cloud_autosave_state');
    const stateCase = state.slice(state.indexOf('v_reason := CASE'), state.indexOf('END;', state.indexOf('v_reason := CASE')));
    const lic = body('_cloud_autosave_license');
    const licCase = lic.slice(lic.indexOf('SELECT CASE'), lic.indexOf('INTO v_reason'));
    const reasons = [
      ...all(/'([a-z_]+)'/g, stateCase),
      ...all(/'([a-z_]+)'/g, licCase),
      ...all(/coalesce\(v_reason, '([a-z_]+)'\)/g, lic),
    ];
    expect(reasons.length).toBeGreaterThan(0);
    expect(sorted(C.tolerance.known.state_reasons)).toEqual(sorted(reasons));

    const blob = body('cloud_register_blob') + ' ' + body('cloud_confirm_blob');
    expect(sorted(C.tolerance.known.blob_states)).toEqual(sorted([...all(/THEN '([a-z_]+)'/g, blob), ...all(/ELSE '([a-z_]+)'/g, blob), ...all(/'state', '([a-z_]+)'/g, blob)]));
  });

  it('writes: the listed functions are exactly those that take p_expected_user_id first, and the mismatch code is emitted', () => {
    const fns = all(/CREATE OR REPLACE FUNCTION public\.(\w+)\(p_expected_user_id uuid, /g, M2);
    expect(fns).toHaveLength(13);
    expect(sorted(C.writes.functions)).toEqual(sorted(fns));
    expect(C.writes.expected_user_argument).toBe('p_expected_user_id');
    expect(C.writes.expected_user_argument_position).toBe(1);
    expect(C.writes.mismatch_error).toBe('wrong_account');
  });

  it('details v1: fifteen keys with fixed types', () => {
    expect(C.deal.details.v).toBe(1);
    expect(C.deal.details.every_key_always_present).toBe(true);
    expect(C.deal.details.keys).toEqual({
      v: 'number',
      listing_price: 'number',
      sale_price: 'number',
      earnest_money_amount: 'number',
      commission_offered_rate: 'number',
      commission_actual_rate: 'number',
      commission_gross_amount: 'number',
      mutual_acceptance_date: 'date',
      inspection_deadline: 'date',
      financing_deadline: 'date',
      closing_deadline: 'date',
      representation_start_date: 'date',
      stage: 'string',
      submission_status: 'string',
      export_status: 'string',
    });
    expect(C.deal.calendar_dates.fields).toEqual(['started_at', 'closed_at']);
    expect(table('cloud_deals')).toContain("details jsonb NOT NULL DEFAULT '{}'::jsonb");
  });

  it('person: email and phone element shapes, and details_withheld is a stored flag that blanks name, company, emails and phones', () => {
    expect(C.party.emails.element).toEqual({ email: 'string', is_primary: 'boolean', label: 'string|null' });
    expect(C.party.phones.element).toEqual({ e164: 'string', display: 'string|null', is_primary: 'boolean', label: 'string|null' });
    expect(C.party.emails.empty).toEqual([]);
    expect(C.party.phones.empty).toEqual([]);
    const w = C.party.details_withheld;
    expect(w.type).toBe('boolean');
    expect(w.always_present).toBe(true);
    expect(w.default).toBe(false);
    expect(w.in_content_hash).toBe(true);
    expect(w).not.toHaveProperty('derived_by_reader');
    expect(w).not.toHaveProperty('derived_from');
    expect(w.meaning).toBe('A person with details_withheld has name, company, emails and phones blank.');
    // a real column, stored by the party upsert, which blanks the four fields when the flag is set
    expect(w.stored_column).toBe('cloud_deal_parties.details_withheld');
    expect(table('cloud_deal_parties')).toContain('details_withheld boolean NOT NULL DEFAULT false,');
    expect(M2).toContain('ALTER TABLE public.cloud_deal_parties ADD COLUMN IF NOT EXISTS details_withheld boolean NOT NULL DEFAULT false;');
    const up = body('cloud_upsert_parties');
    expect(up).toContain("v_withheld := coalesce((r ->> 'details_withheld')::boolean, false);");
    for (const col of Object.keys(w.blank_when_true)) {
      expect(up).toMatch(new RegExp(`${col} = CASE WHEN v_withheld THEN NULL (ELSE|WHEN)`));
    }
    expect(up).toContain('details_withheld = v_withheld,');
    // reader keys: exactly these, each a party column; contact_source is stored only
    expect(C.party.reader_keys).toEqual(['display_name', 'company', 'role', 'role_category', 'specific_role', 'is_primary', 'emails', 'phones', 'notes', 'contact_deleted', 'details_withheld']);
    expect(C.party.stored_only_keys).toEqual(['contact_source']);
    expect(C.party.reader_keys).not.toContain('contact_source');
    expect(w.blank_when_true).toEqual({ display_name: null, company: null, emails: [], phones: [] });
    // the role row, including the note typed on the deal, is still sent
    expect(w.kept_when_true).toEqual(['role', 'role_category', 'specific_role', 'is_primary', 'notes', 'contact_deleted']);
    // every column named here exists on cloud_deal_parties
    const parties = table('cloud_deal_parties');
    for (const col of [...Object.keys(w.blank_when_true), ...w.kept_when_true, ...C.party.reader_keys, 'contact_source']) {
      expect(parties).toMatch(new RegExp(`(^|, )${col} `));
    }
    for (const k of Object.keys(w.blank_when_true)) expect(w.kept_when_true).not.toContain(k);
  });

  it('the 4236 harness party fixture uses exactly the contract email and phone keys', () => {
    const controls = read(join(REPO, 'supabase/tests/backlog-4236/controls.sql'));
    const m = /'(\{"company":"Co"[^']*\})'/.exec(controls);
    expect(m).not.toBeNull();
    const party = JSON.parse((m as RegExpExecArray)[1]);
    expect(party.emails.length).toBeGreaterThan(0);
    expect(party.phones.length).toBeGreaterThan(0);
    for (const e of party.emails) expect(Object.keys(e).sort()).toEqual(Object.keys(C.party.emails.element).sort());
    for (const p of party.phones) expect(Object.keys(p).sort()).toEqual(Object.keys(C.party.phones.element).sort());
  });
});
