/**
 * BACKLOG-3126 — the migrations directory is a claim, and this suite is what makes it
 * checkable.
 *
 * A file in `supabase/migrations/` asserts two things: that it belongs in every
 * database, and that `supabase db reset` may run it. Nine files in this repo asserted
 * both and were true of neither — production had never run any of them. Four were
 * shipped (rows 1-4 on BACKLOG-3126), one deleted, and four moved to `supabase/parked/`
 * with a README naming the item that will bring them back.
 *
 * Parking only works if a parked file cannot quietly reappear alongside its twin, and
 * the shipped files only apply cleanly if each is the SOLE file at its version
 * stamp — `supabase migration up` keys history by the leading digits, so a second file
 * at the same stamp is invisible to it. That is exactly how
 * `20260718_backlog_2077_chargeback_suspension.sql` hid behind
 * `20260718_backlog_2113_app_lifecycle_events.sql` for seven weeks. It now ships as
 * `20260906000000_…`.
 *
 * THE SAME SHAPE RECURRED AT `20260905`, and is row 5-6 here. Two unrelated migrations
 * were hand-named `20260905_backlog_3096_setup_first_user_wins.sql` and
 * `20260905_backlog_3098_feature_definitions_is_built.sql`. `version` is the PRIMARY
 * KEY of `supabase_migrations.schema_migrations`, so only one of the two could ever
 * have been recorded — the other would have run and then been invisible to the ledger.
 * Neither could be listed below while they collided: the sole-file assertion would
 * have failed on both.
 *
 * Resolved by renaming, which is legal only because both were still PENDING against
 * production. Checked against the live ledger rather than reasoned about: no row at
 * `20260905`, `20260905120000` or `20260905120100`; `feature_definitions.is_built`
 * absent; `auto_provision_it_admin` present but still the pre-BACKLOG-3096 body. They
 * ship as `20260905120000_…` and `20260905120100_…`, one stamp each.
 * `20260324_support_edit_delete_internal_notes.sql` was conformed to `20260324120000_…`
 * in the same pass on the same evidence — its `support_edit_internal_note` /
 * `support_delete_internal_note` functions and its `support_ticket_messages.edited_at` /
 * `edited_by` columns are all absent from production. Do not confuse it with the
 * APPLIED and unrelated `20260324002354_fix_admin_search_users_deduplicate`.
 * `scripts/check-migration-names.mjs` now rejects any new duplicate stamp outright.
 *
 * SCOPE, deliberately: the sole-file-at-its-version rule is asserted for the six
 * reconciled files ONLY. 102 other files in this directory sit in 20 groups that share
 * a stamp, and production has ALREADY applied those versions — renaming them would make
 * them pending against production and cause re-runs. Widening this assertion to the
 * whole directory would be wrong, not merely red. Recount both numbers with:
 *   ls supabase/migrations | grep '.sql$' | cut -d_ -f1 | sort | uniq -c | awk '$1>1'
 */

import { existsSync, readdirSync, readFileSync } from 'fs';
import { join, resolve } from 'path';

const REPO = resolve(__dirname, '..', '..');
const MIGRATIONS = join(REPO, 'supabase', 'migrations');
const PARKED = join(REPO, 'supabase', 'parked');

/** The leading digit run is the version the Supabase CLI keys history by. */
function versionOf(filename: string): string {
  const m = /^(\d{14}|\d{8})_/.exec(filename);
  if (!m) throw new Error(`not a migration filename: ${filename}`);
  return m[1];
}

function sqlFilesIn(dir: string): string[] {
  return readdirSync(dir).filter((f) => f.endsWith('.sql'));
}

/** Every .sql under supabase/parked/<item>/, as "<item>/<file>". */
function parkedSqlFiles(): { item: string; file: string }[] {
  if (!existsSync(PARKED)) return [];
  return readdirSync(PARKED, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .flatMap((e) => sqlFilesIn(join(PARKED, e.name)).map((file) => ({ item: e.name, file })));
}

describe('supabase/migrations directory hygiene (BACKLOG-3126)', () => {
  const migrationFiles = sqlFilesIn(MIGRATIONS);

  describe('parked migrations stay out of migrations/', () => {
    it('finds the parked files this item moved', () => {
      // Guards the two assertions below against passing vacuously on an empty tree.
      expect(parkedSqlFiles().map((p) => p.file).sort()).toEqual([
        '20260307_audit_alert_webhook.sql',
        '20260320_add_directory_sync_provisioning.sql',
        '20260320_add_directory_sync_tracking.sql',
        '20260320_add_google_workspace_domain.sql',
        'backfill_personal_organizations.sql',
      ]);
    });

    it.each(parkedSqlFiles())('$file has no twin in migrations/', ({ file }) => {
      expect(migrationFiles).not.toContain(file);
    });

    it.each(
      existsSync(PARKED)
        ? readdirSync(PARKED, { withFileTypes: true })
            .filter((e) => e.isDirectory())
            .map((e) => e.name)
        : [],
    )('supabase/parked/%s carries a README naming its owning item', (item: string) => {
      const readme = join(PARKED, item, 'README.md');
      expect(existsSync(readme)).toBe(true);
      // "backlog-2241" -> the README must name BACKLOG-2241, so a reader of the file
      // can find the decision without going through git history.
      const legacyId = item.replace(/^backlog-/, 'BACKLOG-');
      expect(readFileSync(readme, 'utf8')).toContain(legacyId);
    });
  });

  describe('the six migrations reconciled for production each own their version stamp', () => {
    const RECONCILED = [
      '20260828143000_backlog_2914_sync_outcomes.sql',
      '20260324120000_support_edit_delete_internal_notes.sql',
      '20260906000000_backlog_2077_chargeback_suspension.sql',
      '20260318120000_pm_partial_indexes.sql',
      // Renamed off the shared `20260905` stamp; see the collision note in the header.
      '20260905120000_backlog_3096_setup_first_user_wins.sql',
      '20260905120100_backlog_3098_feature_definitions_is_built.sql',
    ];

    it.each(RECONCILED)('%s is present', (file) => {
      expect(migrationFiles).toContain(file);
    });

    it.each(RECONCILED)('%s is the only file at its version stamp', (file) => {
      const version = versionOf(file);
      const siblings = migrationFiles.filter((f) => versionOf(f) === version);
      // Assert the IDENTITY of the set, not its size: a count of 1 would still pass if
      // the file were swapped for a different one at the same stamp.
      expect(siblings).toEqual([file]);
    });
  });

  it('20251217_add_llm_allowance.sql is gone from the repo (founder: delete)', () => {
    expect(migrationFiles).not.toContain('20251217_add_llm_allowance.sql');
    expect(parkedSqlFiles().map((p) => p.file)).not.toContain('20251217_add_llm_allowance.sql');
  });
});
