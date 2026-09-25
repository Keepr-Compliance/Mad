/**
 * BACKLOG-3551 — storage.objects policies for bucket 'submission-attachments'
 * (text tripwire).
 *
 * WHAT THIS CAN PROVE: what the migration file says.
 *
 * WHAT IT CANNOT: behaviour. CI has no database; the behaviour controls ran
 * against a real Postgres + storage schema venue and are recorded on
 * BACKLOG-3551. These assertions guard the lines a later edit is most likely
 * to change quietly.
 *
 * Matchers run on the file with `--` comment lines removed, so the header's
 * prose cannot satisfy or break an assertion about executable SQL.
 */

import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';

const REPO = join(__dirname, '../../..');
const MIGRATIONS_DIR = join(REPO, 'supabase/migrations');
const MIGRATION_NAME = '20260925222910_backlog_3551_submission_attachment_scope.sql';
const BUCKET = "'submission-attachments'";
const NEW_SELECT = 'Submission attachments follow their submission';
const OLD_POLICIES = [
  'Members can view submission attachments',
  'Members can update submission attachments',
  'Admins can delete submission attachments',
];
const INSERT_POLICY = 'Members can upload submission attachments';

const stripComments = (sql: string): string =>
  sql
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('--'))
    .join('\n');

/** Every statement (to its terminating `;`) that starts with `head`. Case-insensitive. */
function statements(sql: string, head: RegExp): string[] {
  const out: string[] = [];
  const re = new RegExp(head.source, 'gi');
  let m: RegExpExecArray | null;
  while ((m = re.exec(sql)) !== null) {
    const end = sql.indexOf(';', m.index);
    out.push(sql.slice(m.index, end === -1 ? undefined : end + 1));
  }
  return out;
}

describe(MIGRATION_NAME, () => {
  const migrationFiles = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql'));
  const raw = readFileSync(join(MIGRATIONS_DIR, MIGRATION_NAME), 'utf8');
  const code = stripComments(raw);
  const creates = statements(code, /CREATE\s+POLICY\b/);

  it('is the only BACKLOG-3551 migration, under a 14-digit stamp', () => {
    const mine = migrationFiles.filter((f) => /backlog_3551/i.test(f));
    expect(mine).toEqual([MIGRATION_NAME]);
    expect(MIGRATION_NAME).toMatch(/^\d{14}_[a-z0-9_]+\.sql$/);
  });

  it('runs in one transaction', () => {
    expect(code.match(/^BEGIN;$/gm)).toHaveLength(1);
    expect(code.match(/^COMMIT;$/gm)).toHaveLength(1);
    expect(code.trim().endsWith('COMMIT;')).toBe(true);
  });

  it('drops the old SELECT, UPDATE and DELETE policies (IF EXISTS), and not the INSERT policy', () => {
    const drops = statements(code, /DROP\s+POLICY\b/);
    for (const name of OLD_POLICIES) {
      expect(
        drops.some((s) => /IF\s+EXISTS/i.test(s) && s.includes(`"${name}"`) && /ON\s+storage\.objects/i.test(s)),
      ).toBe(true);
    }
    expect(code).not.toContain(INSERT_POLICY);
  });

  it('creates exactly one policy: the SELECT, scoped to the bucket', () => {
    expect(creates).toHaveLength(1);
    const [select] = creates;
    expect(select).toContain(`"${NEW_SELECT}"`);
    expect(select).toMatch(/ON\s+storage\.objects\s+FOR\s+SELECT\b/i);
    expect(select).toContain(`bucket_id = ${BUCKET}`);
    expect(select).toMatch(/FROM\s+public\.transaction_submissions\s+s\b/i);
    expect(select).toMatch(/s\.organization_id::text\s*=\s*split_part\(objects\.name,\s*'\/',\s*1\)/);
  });

  it('casts path segment 2 to uuid only inside the CASE shape guard', () => {
    const [select] = creates;
    const casts = select.match(/::uuid/g) ?? [];
    expect(casts).toHaveLength(1);
    const guard =
      /CASE\s+WHEN\s+split_part\(objects\.name,\s*'\/',\s*2\)\s+~\s+'\^\[0-9a-fA-F\]\{8\}-\[0-9a-fA-F\]\{4\}-\[0-9a-fA-F\]\{4\}-\[0-9a-fA-F\]\{4\}-\[0-9a-fA-F\]\{12\}\$'\s+THEN\s+split_part\(objects\.name,\s*'\/',\s*2\)::uuid\s+END/;
    expect(select).toMatch(guard);
  });

  it('creates no UPDATE, DELETE, INSERT or ALL policy, and alters none', () => {
    for (const s of creates) {
      expect(s).not.toMatch(/FOR\s+(UPDATE|DELETE|INSERT|ALL)\b/i);
    }
    expect(statements(code, /ALTER\s+POLICY\b/)).toHaveLength(0);
  });

  it('does not name it_admin, owner or owner_id', () => {
    expect(code).not.toMatch(/it_admin/i);
    expect(code).not.toMatch(/\bowner(_id)?\b/i);
  });
});
