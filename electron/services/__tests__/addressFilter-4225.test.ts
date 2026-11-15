/**
 * @jest-environment node
 *
 * BACKLOG-4225 follow-up — the address filter: a detected candidate that is a
 * sentence, not an address, is dropped. The filter only removes.
 *
 * Invariant I (every email): the new `addresses` is a subsequence of the old
 * one, and is empty or starts with the same first address. Old = output of
 * the UNMODIFIED extractor at develop d079d6433, recorded in the fixtures
 * (generated, never hand-edited).
 *
 * Synthetic text only (Testville / Sampleton / Exampleburg, ZIP 00000).
 * The hold-out (addressFilter-4225.holdout.json) was written by an author who
 * never saw the checks; it is committed byte-identical and is not edited.
 */
import * as nodePath from "path";
import * as fs from "fs";
import type { Database as DatabaseType } from "better-sqlite3";
import svc, { addressCandidates } from "../transactionExtractorService";
import corpus from "./fixtures/addressFilter-4225.corpus.json";
import overrun from "./fixtures/addressOverrun-4225.corpus.json";
import holdout from "./fixtures/addressFilter-4225.holdout.json";
import holdoutOld from "./fixtures/addressFilter-4225.holdout-old.json";

let db: DatabaseType;
jest.mock("../db/core/dbConnection", () => ({
  dbGet: (sql: string, params: unknown[] = []) => db.prepare(sql).get(...(params as never[])),
  dbAll: (sql: string, params: unknown[] = []) => db.prepare(sql).all(...(params as never[])),
  dbRun: (sql: string, params: unknown[] = []) => db.prepare(sql).run(...(params as never[])),
  dbTransaction: (fn: () => unknown) => db.transaction(fn)(),
  ensureDb: () => db,
  getRawDatabase: () => db,
}));
jest.mock("../logService", () => {
  const m = { info: jest.fn(), debug: jest.fn(), warn: jest.fn(), error: jest.fn() };
  return { __esModule: true, default: m, logService: m };
});

import { runBaseline0 } from "../learn/baselineRunner";
import { nextCleanupQuestion } from "../learn/cleanupPass";
import { addressKey } from "../learn/dealMatcher";
import { insertStoredEmail } from "./helpers/storedEmail-4175";

type Email = { subject?: string; bodyPlain?: string };
type Row = { id: string; kind: "pos" | "neg" | "residual"; email: Email; oldAddresses: string[] };
type HoldRow = { id: string; category: string; subject: string; body: string; expected: string | null };

const rows = corpus.rows as Row[];
const byId = new Map(rows.map((r) => [r.id, r]));
const row = (id: string): Row => {
  const r = byId.get(id);
  if (!r) throw new Error(`no corpus row ${id}`);
  return r;
};

function addresses(email: Email): string[] {
  return svc.analyzeEmail({ ...email, date: "2026-11-01" } as never).addresses;
}
/** The text analyzeEmail reads (as _getEmailText builds it). */
function textOf(email: Email): string {
  return [email.subject || "", email.bodyPlain || "", ""].join(" ").toLowerCase();
}
function reasons(email: Email): Array<string | null> {
  return addressCandidates(textOf(email)).map((c) => c.reason);
}
function invariantI(oldA: string[], newA: string[]): boolean {
  let i = 0;
  for (const a of oldA) if (a === newA[i]) i++;
  return i === newA.length && (newA.length === 0 || newA[0] === oldA[0]);
}
/** "2.47 got it right": its first address is the expected street (a unit or tail after it is fine). */
function rightStreet(addr: string | undefined, expected: string): boolean {
  if (addr === undefined) return false;
  const e = expected.toLowerCase().replace(/\s+/g, " ").trim();
  return addr === e || addr.startsWith(`${e},`) || addr.startsWith(`${e} `);
}

/** Corpus rows the filter drops (all junk in 2.47), with the reason of the first candidate. */
const DROPPED: Array<[string, string]> = [
  ["n01", "C1"],
  ["n03", "C1"],
  ["n05", "C1"],
  ["n07", "C1"],
  ["n09", "C4"],
  ["n12", "C1"],
  ["n18", "C4"],
  ["x-C1", "C1"],
  ["x-C1cap5", "C1"],
  ["x-C1shown", "C1"],
  ["x-C2", "C2"],
  ["x-C4stop", "C4stop"],
  ["x-P3", "C1"],
  ["x-W1v2", "C1"],
];

describe("BACKLOG-4225 address filter: invariant I (the filter only removes)", () => {
  it("I holds on every filter-corpus row", () => {
    expect(rows.length).toBe(73);
    const bad = rows.filter((r) => !invariantI(r.oldAddresses, addresses(r.email))).map((r) => r.id);
    expect(bad).toEqual([]);
  });

  it("I holds on every row of the 80-row overrun fixture, and none of them changes", () => {
    const fx = overrun.rows as Array<{ email: Email }>;
    const old = corpus.overrunFixtureOld as string[][];
    expect(fx.length).toBe(80);
    expect(old.length).toBe(80);
    const got = fx.map((r) => addresses(r.email));
    expect(got.filter((a, i) => !invariantI(old[i], a)).length).toBe(0);
    expect(got).toEqual(old);
  });

  it("hold-out (a): I holds on every hold-out row", () => {
    const h = holdout as HoldRow[];
    const old = holdoutOld.rows as Array<{ id: string; oldAddresses: string[] }>;
    expect(h.length).toBe(76);
    expect(old.map((o) => o.id)).toEqual(h.map((r) => r.id));
    const bad = h.filter((r, i) => !invariantI(old[i].oldAddresses, addresses({ subject: r.subject, bodyPlain: r.body })));
    expect(bad.map((r) => r.id)).toEqual([]);
  });

  /**
   * Bar (b) as ruled by the founder on 2026-11-11 (pm_comments on BACKLOG-4225):
   * the filter ships as built and these two hold-out losses are accepted. Both are
   * a weak suffix rejected by C4 (no city+state tail). Any OTHER loss fails.
   */
  const ACCEPTED_HOLDOUT_LOSSES = ["h007", "h009"];

  it("hold-out (b): every row 2.47 got right is still right, except the two accepted losses", () => {
    const h = holdout as HoldRow[];
    const old = holdoutOld.rows as Array<{ id: string; oldAddresses: string[] }>;
    const right = h.filter((r, i) => r.expected !== null && rightStreet(old[i].oldAddresses[0], r.expected));
    expect(right.length).toBe(20); // measured on the d079d6433 output; not a tuning target
    const lost = right.filter((r) => {
      const now = addresses({ subject: r.subject, bodyPlain: r.body });
      return !rightStreet(now[0], r.expected as string);
    });
    expect(lost.map((r) => r.id)).toEqual(ACCEPTED_HOLDOUT_LOSSES);
    for (const id of ACCEPTED_HOLDOUT_LOSSES) {
      const r = h.find((x) => x.id === id) as HoldRow;
      expect(addresses({ subject: r.subject, bodyPlain: r.body })).toEqual([]);
      expect(reasons({ subject: r.subject, bodyPlain: r.body })[0]).toBe("C4");
    }
  });

  it("hold-out (c): at least half of the junk 2.47 showed is removed", () => {
    const h = holdout as HoldRow[];
    const old = holdoutOld.rows as Array<{ id: string; oldAddresses: string[] }>;
    const junk = h.filter((r, i) => r.expected === null && old[i].oldAddresses.length > 0);
    expect(junk.length).toBe(14); // measured on the d079d6433 output
    const removed = junk.filter((r) => addresses({ subject: r.subject, bodyPlain: r.body }).length === 0);
    expect(removed.map((r) => r.id)).toEqual(["h058", "h059", "h060", "h061", "h062", "h063", "h069", "h073"]);
    expect(removed.length * 2).toBeGreaterThanOrEqual(junk.length);
  });
});

describe("BACKLOG-4225 address filter: what is dropped, and why", () => {
  it.each(DROPPED)("%s is dropped; first candidate rejected as %s", (id, reason) => {
    const r = row(id);
    expect(r.oldAddresses.length).toBeGreaterThan(0);
    expect(addresses(r.email)).toEqual([]);
    expect(reasons(r.email)[0]).toBe(reason);
  });

  it("every corpus row not in the dropped list keeps exactly what 2.47 showed", () => {
    const dropped = new Set(DROPPED.map(([id]) => id));
    const changed = rows.filter((r) => !dropped.has(r.id) && JSON.stringify(addresses(r.email)) !== JSON.stringify(r.oldAddresses));
    expect(changed.map((r) => r.id)).toEqual([]);
  });

  it("C1 name length: 5 name words is a sentence (x-C1cap5), 4 is a street (k-mlk, k-4w)", () => {
    expect(reasons(row("x-C1cap5").email)).toEqual(["C1"]);
    expect(addresses(row("k-mlk").email)).toEqual(["1200 martin luther king jr way, testville, wa 00000"]);
    // A leading direction word is not counted: 5 words before the suffix, 4 after it is dropped.
    expect(addresses(row("k-mlk-dir").email)).toEqual(["500 n martin luther king jr way, testville, wa 00000"]);
    expect(addresses(row("k-4w").email)).toEqual(["55 old mill pond road, testville, wa 00000"]);
  });

  it("C2 sentence break: a period after a 1-2 letter word is not one (k-abbr, k-dirdot)", () => {
    expect(reasons(row("x-C2").email)).toEqual(["C2"]);
    expect(addresses(row("k-abbr").email)).toEqual(["100 st. james pl, testville, wa 00000"]);
    expect(addresses(row("k-dirdot").email)).toEqual(["1607 n. maple st, testville, wa 00000"]);
  });

  it("C4stop: a weak suffix whose first city word starts prose (the row ends at the state)", () => {
    const r = row("x-C4stop");
    expect(r.email.bodyPlain).toMatch(/In The Park WA$/);
    expect(reasons(r.email)).toEqual(["C4stop"]);
  });

  it("W2 guard: junk first, a real address later -> no address (the later one is not promoted)", () => {
    expect(reasons(row("x-P3").email)).toEqual(["C1", null]);
    expect(row("x-P3").oldAddresses[1]).toBe("1234 sample river lane, testville, wa");
    expect(addresses(row("x-P3").email)).toEqual([]);
  });

  it("W1 guard: a rejected ZIP match does not fall back to the no-ZIP pattern", () => {
    expect(row("x-W1v2").oldAddresses).toEqual(["2 queen beds and an ocean view, testville, wa 00000"]);
    expect(addresses(row("x-W1v2").email)).toEqual([]);
  });

  it("a later rejected candidate is skipped; the first address stays", () => {
    const email = {
      subject: "",
      bodyPlain:
        "Offer accepted on 4225 Sampletest Way, Testville, WA 00000. Escrow closing.\nRooms With 2 Queen Beds And An Ocean View, Testville, WA 00000",
    };
    expect(reasons(email)).toEqual([null, "C1"]);
    expect(addresses(email)).toEqual(["4225 sampletest way, testville, wa 00000"]);
  });

  it("founder shapes n01-n04 give no address", () => {
    for (const id of ["n01", "n02", "n03", "n04"]) expect(addresses(row(id).email)).toEqual([]);
  });

  it("known residual: junk whose tail ends in a state-code word is still emitted (r-*)", () => {
    const residual = rows.filter((r) => r.kind === "residual");
    expect(residual.length).toBe(5);
    for (const r of residual) {
      expect(addresses(r.email)).toEqual(r.oldAddresses);
      expect(r.oldAddresses.length).toBe(1);
    }
  });
});

describe("BACKLOG-4225 address filter: real addresses are kept as 2.47 shows them", () => {
  it.each([
    ["k-splitA", "8 sea view road, some town, wa 00000"],
    ["k-splitB", "8 sea view road, some town, wa 00000"],
    ["k-cityA", "15 mill creek path, the dalles, or 00000"],
    ["k-cityB", "25 timber ridge, the woodlands, tx 00000"],
    ["k-cityC", "12 sunset ridge, lake in the hills, il 00000"],
    ["k-cityD", "9 harbor view, isle of palms, sc 00000"],
    ["k-hill", "8 oak hill, testville, wa 00000"],
    ["k-hill-nozip", "8 oak hill, testville, wa"],
    ["k-price", "8 oak hill, testville, wa 00000"],
    ["k-suite", "200 main street, testville, wa 00000"],
  ])("%s -> %s", (id, shown) => {
    const r = row(id);
    expect(r.oldAddresses).toEqual([shown]);
    expect(addresses(r.email)).toEqual([shown]);
  });

  it("the two-line weak-word street is checked on the street that is SHOWN", () => {
    // DETECT alone ends this street at "view"; the shown (strict) street is "8 sea view road".
    expect(reasons(row("k-splitA").email)).toEqual([null]);
    // x-C1shown: detection ends at the first suffix word ("... gamma view", 3 name words);
    // the shown street runs on to "road" (5 name words) and is the one checked -> C1.
    // Checking the detection street would pass it.
    const shownStreet = row("x-C1shown").oldAddresses[0].split(",")[0];
    expect(shownStreet).toBe("9 alpha beta gamma view delta epsilon road");
    expect(reasons(row("x-C1shown").email)).toEqual(["C1"]);
    expect(addresses(row("x-C1shown").email)).toEqual([]);
  });
});

describe("BACKLOG-4225 address filter: Learn does not re-ask a stored answer", () => {
  const USER = "user-4225-f";
  const NOW = Date.UTC(2026, 10, 1, 12);
  const REAL = "4225 Sampletest Way, Testville, WA 00000";
  const SCHEMA = nodePath.join(__dirname, "..", "..", "database", "schema.sql");

  beforeEach(() => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const Database = require(nodePath.join(__dirname, "..", "..", "..", "node_modules", "better-sqlite3-multiple-ciphers"));
    db = new Database(":memory:") as DatabaseType;
    db.pragma("foreign_keys = OFF");
    db.exec(fs.readFileSync(SCHEMA, "utf8"));
    db.pragma("foreign_keys = ON");
    db.prepare(`INSERT INTO users_local (id, email, oauth_provider, oauth_id) VALUES (?, 'f@example.test', 'google', 'oa-f')`).run(USER);
  });
  afterEach(() => db.close());

  const mail = (id: string, body: string, day: number) =>
    insertStoredEmail(db, {
      id,
      userId: USER,
      sender: "agent@example.com",
      subject: "Offer update",
      bodyPlain: body,
      sentAt: `2026-06-${String(day).padStart(2, "0")}T10:00:00.000Z`,
    });

  it("an answer stored under rules v3 is still answered; the junk email forms no question", async () => {
    mail("e-4225-1", `Offer accepted on ${REAL}. Escrow closing, buyer inspection.`, 1);
    // Real address first, junk later: keeps the same first address (same key).
    mail("e-4225-2", `Offer accepted on ${REAL}. Escrow closing buyer.\nRooms With 2 Queen Beds And An Ocean View, Testville, WA 00000`, 2);
    // Junk only: 2.47 made a detection of it.
    mail("e-4225-3", "Rooms With 2 Queen Beds And An Ocean View, Testville, WA 00000\nVacation home offer, escrow-free booking for buyers.", 3);

    const key = addressKey(REAL.toLowerCase());
    expect(key).not.toBeNull();
    db.prepare(
      `INSERT INTO learn_deal_answers (id, user_id, run_id, address_key, property_address, answer, answered_at, rule_version, created_at, updated_at)
       VALUES ('dla-4225-v3', ?, 'run-v3', ?, ?, 'yes', '2026-10-01T00:00:00Z', 3, '2026-10-01T00:00:00Z', '2026-10-01T00:00:00Z')`,
    ).run(USER, key, REAL.toLowerCase());

    const r = await runBaseline0(USER, 12, { nowMs: NOW, yieldFn: noYieldFn });
    expect(r.detections.map((d) => d.addressKey)).toEqual([key]);
    expect(r.detections[0].emailIds.sort()).toEqual(["e-4225-1", "e-4225-2"]);
    expect(r.detections.some((d) => d.emailIds.includes("e-4225-3"))).toBe(false);
    expect(nextCleanupQuestion(USER, r)).toBeNull();
  });
});

function noYieldFn(): Promise<void> {
  return Promise.resolve();
}
