/**
 * @jest-environment node
 */

/**
 * BACKLOG-4245 migration tripwire (20261114140000_backlog_4245_beta_updates_feature).
 *
 * M1 the pre-check's md5 equals md5 of get_org_features' body in the
 *    migration it was traced against (20261015152446, text between
 *    "AS $function$" and the closing "$function$;", which pg_proc.prosrc holds)
 * M2 the row: key beta_updates, boolean, default 'false', min_tier NULL,
 *    is_built false, ON CONFLICT DO NOTHING; plan rows all enabled false
 * M3 data only: no function, no table, no grant
 * M4 the desktop key, the harness and the rollback name the same key and md5
 * M5 no later migration redefines get_org_features
 */

import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";

const MIG_DIR = path.resolve(__dirname, "../../../supabase/migrations");
const FILE = path.join(MIG_DIR, "20261114140000_backlog_4245_beta_updates_feature.sql");
const TRACED = path.join(MIG_DIR, "20261015152446_backlog_3851_license_model.sql");
const TESTS = path.resolve(__dirname, "../../../supabase/tests/backlog-4245");

const sql = fs.readFileSync(FILE, "utf8");
const code = sql.replace(/^\s*--.*$/gm, "");

function tracedBodyMd5(): string {
  const src = fs.readFileSync(TRACED, "utf8");
  const i = src.indexOf("CREATE OR REPLACE FUNCTION public.get_org_features(p_org_id uuid)");
  expect(i).toBeGreaterThan(-1);
  const j = src.indexOf("AS $function$", i) + "AS $function$".length;
  const k = src.indexOf("$function$;", j);
  return crypto.createHash("md5").update(src.slice(j, k), "utf8").digest("hex");
}

describe("beta_updates migration", () => {
  it("M1 the pre-check pins the traced get_org_features body", () => {
    const pinned = /IS DISTINCT FROM '([0-9a-f]{32})'/.exec(code)?.[1];
    expect(pinned).toBe(tracedBodyMd5());
    expect(code).toMatch(/RAISE EXCEPTION/);
  });

  it("M2 the definition row and the plan rows", () => {
    expect(code).toMatch(
      /VALUES \(\s*'beta_updates',\s*'Beta versions',\s*'[^']*(?:''[^']*)*',\s*'general',\s*'boolean',\s*'false',\s*NULL,\s*\d+,\s*false\s*\)\s*ON CONFLICT \(key\) DO NOTHING;/,
    );
    expect(code).toMatch(/SELECT p\.id, fd\.id, false, 'false'[\s\S]*WHERE fd\.key = 'beta_updates'\s*ON CONFLICT \(plan_id, feature_id\) DO NOTHING;/);
  });

  it("M3 data only", () => {
    expect(code).not.toMatch(/CREATE\s+(OR\s+REPLACE\s+)?FUNCTION/i);
    expect(code).not.toMatch(/CREATE\s+TABLE/i);
    expect(code).not.toMatch(/\bGRANT\b|\bREVOKE\b/i);
    expect(code).not.toMatch(/UPDATE\s+public\.organization_plans/i);
  });

  it("M4 the same key and md5 everywhere", () => {
    const types = fs.readFileSync(path.resolve(__dirname, "../../types/featureGate.ts"), "utf8");
    expect(types).toMatch(/\|\s*"beta_updates"/);
    const harness = fs.readFileSync(path.join(TESTS, "harness-4245.sql"), "utf8");
    expect(harness).toContain(`'${tracedBodyMd5()}'`);
    const rollback = fs.readFileSync(path.join(TESTS, "rollback-4245.sql"), "utf8");
    expect(rollback).toMatch(/feature_overrides - 'beta_updates'[\s\S]*DELETE FROM public\.plan_features[\s\S]*DELETE FROM public\.feature_definitions WHERE key = 'beta_updates'/);
  });

  it("M5 no later migration redefines get_org_features", () => {
    const later = fs
      .readdirSync(MIG_DIR)
      .filter((f) => f.endsWith(".sql") && f > path.basename(TRACED))
      .filter((f) => /FUNCTION\s+(public\.)?get_org_features\s*\(/i.test(fs.readFileSync(path.join(MIG_DIR, f), "utf8")));
    expect(later).toEqual([]);
  });
});
