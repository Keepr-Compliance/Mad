/**
 * BACKLOG-4175 PR2: the rule-set validator corpus.
 *
 * One list of rule sets, each with the answer expected from BOTH validators:
 *   zod  parseSenderRuleSet (ruleSetSchema.ts) accepts it
 *   sql  public._sender_rule_set_invalid(content) IS NULL (migration 20261107235503)
 *
 * Every case is the bundled rule set with ONE path changed. The two answers differ only where
 * the server is deliberately stricter (non-ASCII text, see the migration's validator comment):
 * zod true, sql false. The reverse (sql true, zod false) would let the server publish a set the
 * app refuses, and the parity test fails on it.
 *
 * Written to supabase/tests/backlog-4175/corpus.json (run the parity test with
 * WRITE_CORPUS_4175=1); the keepr-test harness (control S11) runs the same file through SQL.
 * Only reserved names (example.test and friends) appear here.
 */
import { BUNDLED_SENDER_RULES } from "../bundledRules";

export interface CorpusCase {
  name: string;
  content: unknown;
  zod: boolean;
  sql: boolean;
}

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

const base = (): { [k: string]: Json } => JSON.parse(JSON.stringify(BUNDLED_SENDER_RULES));

/** a copy of the bundled set with one path set (undefined value = key removed) */
function at(path: string[], value: Json | undefined): Json {
  const root = base();
  let o: { [k: string]: Json } = root;
  for (const k of path.slice(0, -1)) o = o[k] as { [k: string]: Json };
  const last = path[path.length - 1];
  if (value === undefined) delete o[last];
  else o[last] = value;
  return root;
}

const SIGNALS = [
  "seedAddress",
  "approvedHost",
  "localPart",
  "bulkHeaders",
  "gmailPromotions",
  "gmailSocial",
  "gmailUpdates",
];
const SURFACES = ["learnQuestions", "addressPass", "detector"];

/** a host of exactly n characters (HOST_RE has no per-label limit) */
const hostOfLength = (n: number): string => "a".repeat(n - ".test".length) + ".test";

export function buildCorpus(): CorpusCase[] {
  const out: CorpusCase[] = [];
  const add = (name: string, content: Json, zod: boolean, sql: boolean = zod) =>
    out.push({ name, content, zod, sql });

  add("bundled", base(), true);

  // ---- lists: cap N accepted, N+1 refused (a boundary sweep across every list) ----
  const lists: Array<[string[], number, (i: number) => Json]> = [
    [["suppress", "exactAddresses"], 500, (i) => `s${i}@mail.example.test`],
    [["suppress", "hosts"], 2000, (i) => `h${i}.example.test`],
    [["suppress", "localParts"], 50, (i) => ({ value: `lp${i}`, match: i % 2 ? "prefix" : "exact" })],
    [["suppress", "bulkHeaders", "anyKeyPresent"], 4, (i) =>
      ["list_unsubscribe", "list_unsubscribe_post", "precedence", "auto_submitted"][i % 4]],
    [["suppress", "bulkHeaders", "precedenceValues"], 10, (i) => `p${i}`],
    [["keep", "platformHosts"], 200, (i) => `k${i}.example.test`],
    [["keep", "platformAddresses"], 200, (i) => `k${i}@example.test`],
    [["freeMailDomains"], 500, (i) => `f${i}.example.test`],
  ];
  for (const [path, cap, item] of lists) {
    const p = path.join(".");
    add(`${p}: ${cap} items (cap)`, at(path, Array.from({ length: cap }, (_, i) => item(i))), true);
    add(`${p}: ${cap + 1} items`, at(path, Array.from({ length: cap + 1 }, (_, i) => item(i))), false);
    add(`${p}: not a list`, at(path, "x"), false);
    add(`${p}: null`, at(path, null), false);
    add(`${p}: missing`, at(path, undefined), false);
    add(`${p}: null element`, at(path, [item(0), null]), false);
    add(`${p}: number element`, at(path, [1]), false);
    add(`${p}: boolean element`, at(path, [true]), false);
    add(`${p}: object element`, at(path, [{}]), false);
  }

  // ---- strict objects: an extra key and a missing key at every level ----
  const objects: Array<[string[], string]> = [
    [[], "schema"],
    [["suppress"], "hosts"],
    [["suppress", "bulkHeaders"], "precedenceValues"],
    [["keep"], "platformHosts"],
    [["thresholds"], "reportMaxRows"],
    [["modes"], "gmailSocial"],
    ...SIGNALS.map((s): [string[], string] => [["modes", s], "detector"]),
  ];
  for (const [path, some] of objects) {
    const p = path.length ? path.join(".") : "root";
    add(`${p}: extra key`, at([...path, "extra"], 1), false);
    add(`${p}: missing ${some}`, at([...path, some], undefined), false);
    if (path.length) add(`${p}: not an object`, at(path, []), false);
  }
  const lp = (v: Json) => at(["suppress", "localParts"], [v]);
  add("localParts item: valid exact", lp({ value: "noreply", match: "exact" }), true);
  add("localParts item: valid prefix", lp({ value: "news-", match: "prefix" }), true);
  add("localParts item: extra key", lp({ value: "noreply", match: "exact", extra: 1 }), false);
  add("localParts item: missing match", lp({ value: "noreply" }), false);
  add("localParts item: match suffix", lp({ value: "noreply", match: "suffix" }), false);
  add("localParts item: match null", lp({ value: "noreply", match: null }), false);
  add("localParts item: value number", lp({ value: 123, match: "exact" }), false);
  add("localParts item: value null", lp({ value: null, match: "exact" }), false);

  // ---- strings: every regex, every length bound, case, non-ASCII ----
  const one = (path: string[], v: Json) => at(path, [v]);
  const H = ["suppress", "hosts"];
  const A = ["suppress", "exactAddresses"];
  const P = ["suppress", "bulkHeaders", "precedenceValues"];
  add("host: valid", one(H, "mail.example.test"), true);
  add("host: 253 chars", one(H, hostOfLength(253)), true);
  add("host: 254 chars", one(H, hostOfLength(254)), false);
  add("host: no dot", one(H, "localhost"), false);
  add("host: space", one(H, "a b.test"), false);
  add("host: uppercase", one(H, "Mail.example.test"), false);
  add("host: trailing dot", one(H, "example.test."), false);
  add("host: underscore", one(H, "a_b.test"), false);
  add("host: number 1.5", one(H, 1.5), false);
  add("host: non-ASCII", one(H, "exämple.test"), false);
  add("host: empty", one(H, ""), false);
  add("freeMailDomains: uppercase", one(["freeMailDomains"], "Example.test"), false);
  add("platformHosts: wildcard", one(["keep", "platformHosts"], "*.example.test"), false);

  add("address: valid", one(A, "a.b+c@mail.example.test"), true);
  add("address: 254 chars", one(A, "a".repeat(254 - "@example.test".length) + "@example.test"), true);
  add("address: 255 chars", one(A, "a".repeat(255 - "@example.test".length) + "@example.test"), false);
  add("address: no at", one(A, "example.test"), false);
  add("address: two ats", one(A, "a@b@example.test"), false);
  add("address: host without dot", one(A, "a@localhost"), false);
  add("address: uppercase local", one(A, "A@example.test"), false);
  add("address: uppercase host", one(A, "a@Example.test"), false);
  add("address: space", one(A, "a b@example.test"), false);
  add("address: tab", one(A, "a\tb@example.test"), false);
  add("address: true", one(A, true), false);
  add("address: non-ASCII local part", one(A, "jöse@example.test"), true, false);
  add("address: NBSP in local part", one(A, "a b@example.test"), false);
  add("platformAddresses: uppercase", one(["keep", "platformAddresses"], "X@example.test"), false);

  add("localPart: 64 chars", lp({ value: "a".repeat(64), match: "prefix" }), true);
  add("localPart: 65 chars", lp({ value: "a".repeat(65), match: "prefix" }), false);
  add("localPart: empty", lp({ value: "", match: "exact" }), false);
  add("localPart: contains at", lp({ value: "a@b", match: "exact" }), false);
  add("localPart: uppercase", lp({ value: "NoReply", match: "exact" }), false);
  add("localPart: space", lp({ value: "no reply", match: "exact" }), false);
  add("localPart: symbols", lp({ value: "no-reply+x_y.z", match: "exact" }), true);
  add("localPart: non-ASCII", lp({ value: "jöse", match: "exact" }), true, false);
  add("localPart: NBSP", lp({ value: "a b", match: "exact" }), false);
  add("localPart: U+2028", lp({ value: "a b", match: "exact" }), false);

  add("precedence: 32 chars", one(P, "a".repeat(32)), true);
  add("precedence: 33 chars", one(P, "a".repeat(33)), false);
  add("precedence: empty", one(P, ""), false);
  add("precedence: uppercase", one(P, "Bulk"), false);
  add("precedence: number", one(P, 1), false);
  add("precedence: with space", one(P, "bulk mail"), true, false);
  add("precedence: non-ASCII", one(P, "bülk"), true, false);
  add("precedence: symbols", one(P, "first-class"), true);

  const K = ["suppress", "bulkHeaders", "anyKeyPresent"];
  add("anyKeyPresent: all four", at(K, ["list_unsubscribe", "list_unsubscribe_post", "precedence", "auto_submitted"]), true);
  add("anyKeyPresent: authentication_results", one(K, "authentication_results"), false);
  add("anyKeyPresent: wire name", one(K, "list-unsubscribe"), false);
  add("anyKeyPresent: uppercase", one(K, "PRECEDENCE"), false);

  // ---- scalars ----
  const AS = ["suppress", "bulkHeaders", "autoSubmittedCounts"];
  add("autoSubmittedCounts: true", at(AS, true), true);
  add("autoSubmittedCounts: string", at(AS, "true"), false);
  add("autoSubmittedCounts: number", at(AS, 1), false);
  add("autoSubmittedCounts: null", at(AS, null), false);

  add("schema: 2", at(["schema"], 2), false);
  add("schema: string", at(["schema"], "1"), false);
  add("schema: null", at(["schema"], null), false);
  add("version: 7", at(["version"], 7), true);
  add("version: 0", at(["version"], 0), false);
  add("version: -1", at(["version"], -1), false);
  add("version: 1.5", at(["version"], 1.5), false);
  add("version: string", at(["version"], "1"), false);
  add("version: null", at(["version"], null), false);
  add("version: 2^53-1", at(["version"], 9007199254740991), true);
  add("version: 2^53", at(["version"], 9007199254740992), false);

  const T = (k: string, v: Json) => at(["thresholds", k], v);
  add("minCensusLinkedEmails: 0", T("minCensusLinkedEmails", 0), true);
  add("minCensusLinkedEmails: -1", T("minCensusLinkedEmails", -1), false);
  add("minCensusLinkedEmails: 1.5", T("minCensusLinkedEmails", 1.5), false);
  add("minCensusLinkedEmails: string", T("minCensusLinkedEmails", "20"), false);
  add("minCensusLinkedEmails: null", T("minCensusLinkedEmails", null), false);
  add("minCensusLinkedEmails: 2^53-1", T("minCensusLinkedEmails", 9007199254740991), true);
  add("minCensusLinkedEmails: 2^53", T("minCensusLinkedEmails", 9007199254740992), false);
  add("reportSendIntervalHours: 1", T("reportSendIntervalHours", 1), true);
  add("reportSendIntervalHours: 0", T("reportSendIntervalHours", 0), false);
  add("reportSendIntervalHours: null", T("reportSendIntervalHours", null), false);
  add("reportSendIntervalHours: 2^53-1", T("reportSendIntervalHours", 9007199254740991), true);
  add("reportSendIntervalHours: 2^53", T("reportSendIntervalHours", 9007199254740992), false);
  add("reportMaxRows: 1", T("reportMaxRows", 1), true);
  add("reportMaxRows: 500", T("reportMaxRows", 500), true);
  add("reportMaxRows: 501", T("reportMaxRows", 501), false);
  add("reportMaxRows: 0", T("reportMaxRows", 0), false);
  add("reportMaxRows: null", T("reportMaxRows", null), false);
  // BACKLOG-4212: userSuppressMinAnswers is optional, an integer 0-20
  const U = "userSuppressMinAnswers";
  add("userSuppressMinAnswers: absent", base(), true);
  add("userSuppressMinAnswers: 0", T(U, 0), true);
  add("userSuppressMinAnswers: 2", T(U, 2), true);
  add("userSuppressMinAnswers: 20", T(U, 20), true);
  add("userSuppressMinAnswers: -1", T(U, -1), false);
  add("userSuppressMinAnswers: 21", T(U, 21), false);
  add("userSuppressMinAnswers: 2.5", T(U, 2.5), false);
  add("userSuppressMinAnswers: string", T(U, "2"), false);
  add("userSuppressMinAnswers: null", T(U, null), false);
  const withSibling = base();
  (withSibling.thresholds as { [k: string]: Json })[U] = 2;
  (withSibling.thresholds as { [k: string]: Json }).extra = 1;
  add("userSuppressMinAnswers: 2 plus an unknown key", withSibling, false);
  add("userSuppressMinAnswers: wrong case", T("usersuppressminanswers", 2), false);

  // ---- modes: every cell, every value ----
  for (const s of SIGNALS) {
    for (const f of SURFACES) {
      const path = ["modes", s, f];
      add(`modes.${s}.${f}: live`, at(path, "live"), s !== "gmailUpdates");
      add(`modes.${s}.${f}: off`, at(path, "off"), true);
      add(`modes.${s}.${f}: LIVE`, at(path, "LIVE"), false);
      add(`modes.${s}.${f}: null`, at(path, null), false);
    }
  }
  add("modes.seedAddress.detector: number", at(["modes", "seedAddress", "detector"], 1), false);

  return out;
}
