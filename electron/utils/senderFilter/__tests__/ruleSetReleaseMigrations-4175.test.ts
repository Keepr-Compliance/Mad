/**
 * @jest-environment node
 *
 * BACKLOG-4175 PR4 (RS21): the bundled rule set carries the server version it
 * equals.
 *   (a) the highest `bundled = true` row any migration inserts into
 *       public.sender_rule_sets has BUNDLED_SENDER_RULES.version
 *   (b) only the PR2 seed may use ON CONFLICT DO NOTHING; a release migration
 *       must refuse a taken version (template in bundledRules.ts), not skip it
 * The checker is run on synthetic migrations first, so it can be seen to fail.
 */
import fs from "fs";
import path from "path";

import { BUNDLED_SENDER_RULES } from "../bundledRules";

const MIGRATIONS = path.resolve(__dirname, "../../../../supabase/migrations");
const SEED_FILE = "20261107235503_backlog_4175_sender_rule_sets.sql";

interface Migration {
  name: string;
  sql: string;
}

const INSERT_RE =
  /INSERT INTO public\.sender_rule_sets \(version, content, released, bundled\)\s*VALUES \((\d+),[\s\S]*?,\s*(true|false),\s*(true|false)\)(\s*ON CONFLICT \(version\) DO NOTHING)?/g;

function releaseProblems(migrations: Migration[], bundledVersion: number): string[] {
  const problems: string[] = [];
  let highest = 0;
  let seen = 0;
  for (const m of migrations) {
    const sql = m.sql.replace(/\r\n/g, "\n");
    for (const ins of sql.matchAll(INSERT_RE)) {
      seen += 1;
      const version = Number(ins[1]);
      if (ins[3] === "true") highest = Math.max(highest, version);
      if (ins[4] && m.name !== SEED_FILE) problems.push(`${m.name}: v${version} uses ON CONFLICT DO NOTHING`);
    }
  }
  if (seen === 0) problems.push("no sender_rule_sets insert found");
  if (highest !== bundledVersion) problems.push(`highest bundled insert is v${highest}, bundled set is v${bundledVersion}`);
  return problems;
}

const seedSql = fs.readFileSync(path.join(MIGRATIONS, SEED_FILE), "utf8");
const TEMPLATE_V2 = `DO $rel$
DECLARE v_new JSONB := '{"version": 2}'::jsonb; v_old JSONB;
BEGIN
  SELECT content INTO v_old FROM public.sender_rule_sets WHERE version = 2;
  IF v_old IS NULL THEN
    INSERT INTO public.sender_rule_sets (version, content, released, bundled) VALUES (2, v_new, true, true);
  ELSIF v_old <> v_new THEN
    RAISE EXCEPTION 'sender_rule_sets v2 already holds different content';
  END IF;
END $rel$;`;

describe("RS21 release migrations and the bundled version", () => {
  it("checker: a release insert that skips a taken version is refused", () => {
    const skip = `INSERT INTO public.sender_rule_sets (version, content, released, bundled)\nVALUES (2, '{}'::jsonb, true, true)\nON CONFLICT (version) DO NOTHING;`;
    expect(releaseProblems([{ name: SEED_FILE, sql: seedSql }, { name: "29990101000000_release.sql", sql: skip }], 2)).toEqual([
      "29990101000000_release.sql: v2 uses ON CONFLICT DO NOTHING",
    ]);
  });

  it("checker: the template is accepted, and a bundled set behind the newest bundled insert is refused", () => {
    const set = [{ name: SEED_FILE, sql: seedSql }, { name: "29990101000000_release.sql", sql: TEMPLATE_V2 }];
    expect(releaseProblems(set, 2)).toEqual([]);
    expect(releaseProblems(set, 1)).toEqual(["highest bundled insert is v2, bundled set is v1"]);
  });

  it("the repo's migrations agree with BUNDLED_SENDER_RULES.version", () => {
    const all = fs
      .readdirSync(MIGRATIONS)
      .filter((f) => f.endsWith(".sql"))
      .map((name) => ({ name, sql: fs.readFileSync(path.join(MIGRATIONS, name), "utf8") }));
    expect(all.length).toBeGreaterThan(100);
    expect(releaseProblems(all, BUNDLED_SENDER_RULES.version)).toEqual([]);
  });
});
