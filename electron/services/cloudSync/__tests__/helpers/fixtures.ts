/**
 * Keepr Cloud test fixtures (BACKLOG-4243). The database is the real
 * electron/database/schema.sql (what every install gets), then the trigger
 * create step, exactly as runMigrations ends. Ids are all-zero-style fakes.
 */
import fs from "fs";
import path from "path";
import { ensureCloudSyncTriggers } from "../../triggers";
import { openTestDb, type TestDb } from "./sqlite";

export const SCHEMA_SQL = fs.readFileSync(
  path.join(__dirname, "..", "..", "..", "..", "database", "schema.sql"),
  "utf8",
);

export const USER_A = "user-a-4243";
export const USER_B = "user-b-4243";
export const PROJECT = "test-project.supabase.co";
export const OTHER_PROJECT = "other-project.supabase.co";

export function freshDb(opts: { triggers?: boolean } = {}): TestDb {
  const db = openTestDb();
  db.exec(SCHEMA_SQL);
  db.pragma("foreign_keys = ON");
  if (opts.triggers !== false) {
    const r = ensureCloudSyncTriggers(db);
    if (!r.ok || r.skipped.length > 0) throw new Error(`trigger setup failed: ${JSON.stringify(r)}`);
  }
  seedUser(db, USER_A, "a@example.test");
  seedUser(db, USER_B, "b@example.test");
  return db;
}

export function seedUser(db: TestDb, id: string, email: string): void {
  db.prepare("INSERT INTO users_local (id, email, oauth_provider, oauth_id) VALUES (?, ?, 'google', ?)").run(id, email, id);
}

let seq = 0;
export function dealId(n?: number): string {
  const v = n ?? ++seq + 100;
  return `00000000-0000-0000-0000-${String(v).padStart(12, "0")}`;
}

export function insertDeal(
  db: TestDb,
  id: string,
  userId: string = USER_A,
  extra: Record<string, unknown> = {},
): void {
  const cols: Record<string, unknown> = {
    id,
    user_id: userId,
    property_address: "12 Main St, Springfield",
    property_city: "Springfield",
    status: "active",
    detection_status: "confirmed",
    ...extra,
  };
  const keys = Object.keys(cols);
  db.prepare(`INSERT INTO transactions (${keys.join(", ")}) VALUES (${keys.map(() => "?").join(", ")})`).run(
    ...keys.map((k) => cols[k]),
  );
}

export function enableUser(db: TestDb, userId: string = USER_A, project: string = PROJECT): void {
  db.prepare(
    "INSERT INTO cloud_sync_settings (project_ref, user_id, enabled, local_confirmed_at, notice_version, accepted_at) VALUES (?, ?, 1, '2026-11-01T00:00:00.000Z', 1, '2026-11-01T00:00:00.000Z') ON CONFLICT (project_ref, user_id) DO UPDATE SET enabled = 1, local_confirmed_at = excluded.local_confirmed_at",
  ).run(project, userId);
}

export function dirty(db: TestDb): Array<{ transaction_id: string; generation: number; attempts: number; next_attempt_at: string | null; last_error_code: string | null }> {
  return db.prepare("SELECT transaction_id, generation, attempts, next_attempt_at, last_error_code FROM cloud_sync_dirty ORDER BY transaction_id").all() as never;
}

export function dirtyCount(db: TestDb): number {
  return (db.prepare("SELECT COUNT(*) AS n FROM cloud_sync_dirty").get() as { n: number }).n;
}

export function triggerNames(db: TestDb): string[] {
  return (db.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'trg_cloud_sync_%' ORDER BY name").all() as Array<{ name: string }>).map((r) => r.name);
}
