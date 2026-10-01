/**
 * BACKLOG-3618 — CI tripwire for agents' own checklist templates.
 *
 * WHAT THIS CAN PROVE: what the migration file and its rollback say. CI has no
 * database. Behaviour is proved on a real Postgres by supabase/tests/backlog-3618
 * (controls e00-e16, the 3596/3607 controls re-run on top, and lib/mutants.py).
 * This file pins the lines a later edit is most likely to drop or loosen.
 */

import { createHash } from 'crypto';
import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';

const REPO = join(__dirname, '../../..');
const MIGRATIONS_DIR = join(REPO, 'supabase/migrations');
const FILE = '20261001120000_backlog_3618_agent_checklist_templates.sql';
const ROLLBACK = join(REPO, 'supabase/tests/backlog-3618/rollback-3618.sql');

const read = (path: string): string => readFileSync(path, 'utf8').replace(/\r\n?/g, '\n');
const mig = (file: string): string => read(join(MIGRATIONS_DIR, file));

/** Comments out, whitespace collapsed: statement checks only. */
function statements(raw: string): string {
  return raw
    .split('\n')
    .map((line) => line.replace(/--.*$/, ''))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** The raw text between `$$` and `$$` of the ONE definition of `name` in `text`. */
function rawBody(text: string, name: string): string {
  const start = `CREATE OR REPLACE FUNCTION public.${name}(`;
  const s = text.indexOf(start);
  expect(s).toBeGreaterThanOrEqual(0);
  expect(text.indexOf(start, s + 1)).toBe(-1);
  const open = text.indexOf('$$', s) + 2;
  return text.slice(open, text.indexOf('$$', open));
}

/** CREATE ... through `TO authenticated;` (header, body, grants) of `name`. */
function rawBlock(text: string, name: string): string {
  const s = text.indexOf(`CREATE OR REPLACE FUNCTION public.${name}(`);
  expect(s).toBeGreaterThanOrEqual(0);
  const end = 'TO authenticated;\n';
  return text.slice(s, text.indexOf(end, s) + end.length);
}

const md5 = (s: string): string => createHash('md5').update(s, 'utf8').digest('hex');

const ADD_HUNK =
  '\n     AND (t.owner_user_id IS NULL\n' +
  '          OR EXISTS (SELECT 1 FROM public.submission_checklists h0\n' +
  '                      WHERE h0.submission_id = p_submission_id AND h0.template_id = t.id))';
const SNAP_HUNK =
  '\n    -- BACKLOG-3618: the caller\'s own template, set not to be sent.\n' +
  '    IF EXISTS (SELECT 1 FROM public.checklist_templates t\n' +
  "                WHERE t.id = NULLIF(c ->> 'template_id', '')::uuid\n" +
  '                  AND t.owner_user_id = (SELECT auth.uid())\n' +
  '                  AND NOT t.include_in_submission) THEN\n' +
  '      CONTINUE;\n' +
  '    END IF;\n';

const M3596 = '20260928120000_backlog_3596_broker_checklist_ticks.sql';
const M3607 = '20260929120000_backlog_3607_checklist_add_remove.sql';
const M3474 = '20260924190429_backlog_3474_save_checklist_template.sql';

describe('BACKLOG-3618 — agent checklist templates migration', () => {
  it('is one file, sorts after the 3607 migration and opens no transaction', () => {
    expect(readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('_backlog_3618_agent_checklist_templates.sql'))).toEqual([FILE]);
    expect(FILE > M3607).toBe(true);
    expect(statements(mig(FILE))).not.toMatch(/(^|;)\s*(BEGIN|COMMIT)\s*;/i);
  });

  it('owner column cascades on user delete; the owner is never client-updatable', () => {
    const s = statements(mig(FILE));
    expect(s).toContain('ADD COLUMN IF NOT EXISTS owner_user_id uuid NULL REFERENCES auth.users(id) ON DELETE CASCADE;');
    expect(s).not.toMatch(/ON DELETE SET NULL/);
    expect(s).toContain('GRANT UPDATE (include_in_submission) ON public.checklist_templates TO authenticated;');
    expect(s).not.toMatch(/GRANT UPDATE \([^)]*owner_user_id/);
  });

  it('a brokerage template can never be excluded from a submission', () => {
    const s = statements(mig(FILE));
    expect(s).toContain('ADD COLUMN IF NOT EXISTS include_in_submission boolean NOT NULL DEFAULT true;');
    expect(s).toContain(
      'ADD CONSTRAINT checklist_templates_include_owner_check CHECK (owner_user_id IS NOT NULL OR include_in_submission);',
    );
    expect(s).toContain("IF v_owner IS NULL AND p_include_in_submission IS FALSE THEN RAISE EXCEPTION 'not_excludable' USING ERRCODE = '22023';");
  });

  it('templates and items are read only by members, and only brokerage or own rows (SR C6: item clause kept)', () => {
    const s = statements(mig(FILE));
    expect(s).toContain(
      'CREATE POLICY checklist_templates_select_member ON public.checklist_templates FOR SELECT TO authenticated USING (checklist_templates.organization_id IN (SELECT public.get_user_org_ids((SELECT auth.uid()))) AND (checklist_templates.owner_user_id IS NULL OR checklist_templates.owner_user_id = (SELECT auth.uid())));',
    );
    expect(s).toContain(
      'CREATE POLICY checklist_template_items_select_member ON public.checklist_template_items FOR SELECT TO authenticated USING (EXISTS ( SELECT 1 FROM public.checklist_templates t WHERE t.id = checklist_template_items.template_id AND t.organization_id IN (SELECT public.get_user_org_ids((SELECT auth.uid()))) AND (t.owner_user_id IS NULL OR t.owner_user_id = (SELECT auth.uid())) ));',
    );
  });

  it('every write policy goes through can_write_checklist_template, which keys on the owner', () => {
    const s = statements(mig(FILE));
    for (const p of [
      'checklist_templates_insert_writer',
      'checklist_templates_update_writer',
      'checklist_template_items_insert_writer',
      'checklist_template_items_update_writer',
      'checklist_template_items_delete_writer',
    ]) {
      const at = s.indexOf(`CREATE POLICY ${p} `);
      expect(at).toBeGreaterThan(-1);
      const stmt = s.slice(at, s.indexOf(';', at));
      expect(stmt).toContain('public.can_write_checklist_template(');
      expect(stmt).not.toContain('can_edit_checklist_templates');
    }
    expect(statements(rawBody(mig(FILE), 'can_write_checklist_template'))).toBe(
      'SELECT CASE WHEN p_owner IS NULL THEN public.can_edit_checklist_templates(p_org_id) ELSE p_owner = (SELECT auth.uid()) AND public.can_create_own_checklist_templates(p_org_id) END;',
    );
    expect(statements(rawBody(mig(FILE), 'can_create_own_checklist_templates'))).toContain(
      "AND COALESCE((public.check_feature_access(p_org_id, 'transaction_checklists') ->> 'allowed')::boolean, false);",
    );
  });

  it('the save RPC drops the six-argument form and takes p_personal / p_include_in_submission', () => {
    const s = statements(mig(FILE));
    expect(s).toContain('DROP FUNCTION IF EXISTS public.save_checklist_template(uuid, uuid, text, text, text, jsonb);');
    expect(s).toContain('p_items jsonb, p_personal boolean DEFAULT false, p_include_in_submission boolean DEFAULT NULL ) RETURNS TABLE (id uuid, updated_at text) LANGUAGE plpgsql SECURITY INVOKER SET search_path = public');
    const sig = 'public.save_checklist_template(uuid, uuid, text, text, text, jsonb, boolean, boolean)';
    expect(s).toContain(`REVOKE EXECUTE ON FUNCTION ${sig} FROM PUBLIC, anon;`);
    expect(s).toContain(`GRANT EXECUTE ON FUNCTION ${sig} TO authenticated;`);
    // An existing template: the row's owner decides, never the argument.
    expect(s).toContain('IF NOT public.can_write_checklist_template(p_org_id, v_owner) THEN');
    expect(s).toContain('include_in_submission = COALESCE(p_include_in_submission, t.include_in_submission)');
  });

  it('add-at-review is the 3607 body plus exactly the owner condition (SR C1)', () => {
    const now = rawBlock(mig(FILE), 'add_submission_checklist_at_review');
    const before = rawBlock(mig(M3607), 'add_submission_checklist_at_review');
    expect(now.split(ADD_HUNK)).toHaveLength(2);
    expect(now.replace(ADD_HUNK, '')).toBe(before);
    expect(md5(rawBody(mig(M3607), 'add_submission_checklist_at_review'))).toBe('42fbc9657bdf4226cad82748d57e3acc');
  });

  it('the snapshot is the 3596 body plus exactly the skip block', () => {
    const now = rawBlock(mig(FILE), 'snapshot_submission_checklists');
    const before = rawBlock(mig(M3596), 'snapshot_submission_checklists');
    expect(now.split(SNAP_HUNK)).toHaveLength(2);
    expect(now.replace(SNAP_HUNK, '')).toBe(before);
    expect(md5(rawBody(mig(M3596), 'snapshot_submission_checklists'))).toBe('029af8d2b14ebed58b760552c116d133');
  });

  it('post-apply body md5s (what production must show after the apply)', () => {
    const t = mig(FILE);
    expect({
      can_create_own_checklist_templates: md5(rawBody(t, 'can_create_own_checklist_templates')),
      can_write_checklist_template: md5(rawBody(t, 'can_write_checklist_template')),
      save_checklist_template: md5(rawBody(t, 'save_checklist_template')),
      add_submission_checklist_at_review: md5(rawBody(t, 'add_submission_checklist_at_review')),
      snapshot_submission_checklists: md5(rawBody(t, 'snapshot_submission_checklists')),
    }).toEqual({
      can_create_own_checklist_templates: 'dcd2f626c7419b3988ffedebd8faebbf',
      can_write_checklist_template: '44b358b5385e3ce5b9c1e668f9601336',
      save_checklist_template: '98df72955f3da7356a33359d1cc9ec99',
      add_submission_checklist_at_review: '84a87a9d9becc6ec8b2091c1c48f66bc',
      snapshot_submission_checklists: '35e682deaf1ed5254a87894cb4604470',
    });
  });

  it('the rollback deletes private templates before dropping the column, and restores the bodies verbatim (SR C4)', () => {
    const rb = read(ROLLBACK);
    const del = rb.indexOf('DELETE FROM public.checklist_templates WHERE owner_user_id IS NOT NULL;');
    expect(del).toBeGreaterThan(-1);
    expect(rb.indexOf('DROP COLUMN IF EXISTS owner_user_id')).toBeGreaterThan(del);
    expect(rawBlock(rb, 'snapshot_submission_checklists')).toBe(rawBlock(mig(M3596), 'snapshot_submission_checklists'));
    expect(rawBlock(rb, 'add_submission_checklist_at_review')).toBe(rawBlock(mig(M3607), 'add_submission_checklist_at_review'));
    expect(rawBlock(rb, 'save_checklist_template')).toBe(rawBlock(mig(M3474), 'save_checklist_template'));
    expect(md5(rawBody(rb, 'save_checklist_template'))).toBe('2f12452735acff624cb6287cae68bddb');
    const dropNew = rb.indexOf('DROP FUNCTION IF EXISTS public.save_checklist_template(uuid, uuid, text, text, text, jsonb, boolean, boolean);');
    expect(dropNew).toBeGreaterThan(-1);
    expect(rb.indexOf('CREATE OR REPLACE FUNCTION public.save_checklist_template(')).toBeGreaterThan(dropNew);
  });
});
