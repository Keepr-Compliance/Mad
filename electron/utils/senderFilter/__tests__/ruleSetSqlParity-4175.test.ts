/**
 * @jest-environment node
 *
 * BACKLOG-4175 PR2: the server validator and the app validator agree.
 *
 *   (a) the committed corpus (supabase/tests/backlog-4175/corpus.json) is exactly what
 *       ruleSetCorpus-4175.ts generates (no drift). WRITE_CORPUS_4175=1 rewrites it.
 *   (b) parseSenderRuleSet answers each case as the corpus says (zod)
 *   (c) no case is accepted by the server and refused by the app (sql true, zod false)
 *   (d) the seed v1 in the migration (between SEED-BEGIN / SEED-END) equals
 *       BUNDLED_SENDER_RULES, version number included, and the app accepts it
 *   (e) the corpus is not empty and has cases on both sides
 *
 * The SQL half (every case through public._sender_rule_set_invalid) is control S11 of the
 * keepr-test harness, supabase/tests/backlog-4175/.
 */
import { readFileSync, writeFileSync } from "fs";
import path from "path";

import { BUNDLED_SENDER_RULES } from "../bundledRules";
import { parseSenderRuleSet } from "../ruleSetSchema";
import { buildCorpus, type CorpusCase } from "./ruleSetCorpus-4175";

const ROOT = path.resolve(__dirname, "../../../..");
const CORPUS = path.join(ROOT, "supabase/tests/backlog-4175/corpus.json");
const MIGRATION = path.join(ROOT, "supabase/migrations/20261108100000_backlog_4175_sender_rule_sets.sql");

const generated = buildCorpus();
if (process.env.WRITE_CORPUS_4175 === "1") {
  writeFileSync(CORPUS, JSON.stringify(generated) + "\n");
}
const committed: CorpusCase[] = JSON.parse(readFileSync(CORPUS, "utf8"));

describe("rule-set validator parity (app vs server)", () => {
  it("(a) the committed corpus equals the generator output", () => {
    expect(committed).toEqual(JSON.parse(JSON.stringify(generated)));
  });

  it("(b) the app validator answers every case as recorded", () => {
    const wrong = committed
      .filter((c) => (parseSenderRuleSet(c.content) !== null) !== c.zod)
      .map((c) => c.name);
    expect(wrong).toEqual([]);
  });

  it("(c) the server never accepts what the app refuses", () => {
    expect(committed.filter((c) => c.sql && !c.zod).map((c) => c.name)).toEqual([]);
  });

  it("(d) the migration seed is the bundled rule set, and the app accepts it", () => {
    const sql = readFileSync(MIGRATION, "utf8").replace(/\r\n/g, "\n");
    const m = sql.match(/-- SEED-BEGIN\n'([\s\S]*?)'\n-- SEED-END/);
    expect(m).not.toBeNull();
    const seed = JSON.parse(m![1]);
    expect(seed).toEqual(JSON.parse(JSON.stringify(BUNDLED_SENDER_RULES)));
    expect(seed.version).toBe(BUNDLED_SENDER_RULES.version);
    expect(sql).toContain(`VALUES (${BUNDLED_SENDER_RULES.version},\n-- SEED-BEGIN`);
    expect(parseSenderRuleSet(seed)).not.toBeNull();
  });

  it("(e) the corpus has cases on both sides", () => {
    expect(committed.length).toBeGreaterThan(200);
    expect(committed.filter((c) => c.zod).length).toBeGreaterThan(20);
    expect(committed.filter((c) => !c.zod).length).toBeGreaterThan(100);
    expect(committed.filter((c) => c.zod && !c.sql).length).toBeGreaterThanOrEqual(4);
    expect(new Set(committed.map((c) => c.name)).size).toBe(committed.length);
  });
});
