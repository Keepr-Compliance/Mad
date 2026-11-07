/**
 * BACKLOG-4175 — decide(): the outcome is the first match whose mode on the
 * surface is LIVE; every non-off match is still counted, attributed to the
 * first match in precedence order (the census's existing meaning).
 *
 *   L1  bulkHeaders measure + Promotions live on one row -> dropped by S4
 *   L2  same row, keep rule K1 matches -> kept (keep still wins)
 *   L3  a measure-only match alone -> not dropped, still counted
 *   L4  census: the live S4 drop is attributed to the first match (S3)
 *   L5  S0 measured, a later live signal: dropped by it unless a keep rule matches
 *   L6  shipped defaults: decide() equals the pre-fix decide() over an
 *       enumerated corpus, on every surface, with and without K1/K3
 *
 * Synthetic domains only (`*.example`), except the pinned shipped data.
 */
import { BUNDLED_SENDER_RULES, type SenderRuleSet, type SenderRuleSignal } from "../bundledRules";
import { hostMatchesAny, hostOf, localPartOf } from "../hostMatch";
import {
  buildKeepSets,
  decide,
  fromAddress,
  NO_KEEP,
  SIGNAL_OF_RULE,
  type DecideOptions,
  type FilterRow,
  type KeepRuleId,
  type KeepSets,
  type SenderFilterSurface,
  type SuppressRuleId,
} from "../senderFilter";
import { filterForSurface } from "../siteFilter";

const OFF = { learnQuestions: "off", addressPass: "off", detector: "off" } as const;
const MEASURE = { learnQuestions: "measure", addressPass: "measure", detector: "measure" } as const;
const LIVE = { learnQuestions: "live", addressPass: "live", detector: "live" } as const;

const RULES: SenderRuleSet = {
  ...BUNDLED_SENDER_RULES,
  suppress: {
    exactAddresses: ["alerts@seed.example"],
    hosts: [],
    localParts: [],
    bulkHeaders: { anyKeyPresent: ["list_unsubscribe"], precedenceValues: ["bulk"], autoSubmittedCounts: false },
  },
  keep: { platformHosts: ["platform.example"], platformAddresses: [] },
  freeMailDomains: ["freemail.example"],
  modes: {
    seedAddress: LIVE,
    approvedHost: LIVE,
    localPart: OFF,
    bulkHeaders: MEASURE,
    gmailPromotions: LIVE,
    gmailSocial: OFF,
    gmailUpdates: OFF,
  },
};

const UNSUB = JSON.stringify({ list_unsubscribe: "<mailto:u@list.example>" });
const PROMO = JSON.stringify(["INBOX", "CATEGORY_PROMOTIONS"]);
const BOTH: FilterRow = { sender: "Shop <news@shop.example>", source: "gmail", labels: PROMO, bulkMailHeaders: UNSUB };

describe("first LIVE match decides", () => {
  it("L1 bulkHeaders measure + Promotions live -> dropped by Promotions", () => {
    const d = decide(BOTH, RULES, "detector");
    expect(d.outcome).toBe("suppress");
    expect(d.live).toBe(true);
    expect(d.liveRule).toBe("S4");
    const r = filterForSurface([BOTH], (x) => x, RULES, "detector", NO_KEEP);
    expect(r.dropped.map((x) => x.rule)).toEqual(["S4"]);
    expect(r.passed).toHaveLength(0);
  });

  it("L2 same row, a K1 contact -> kept", () => {
    const keep = buildKeepSets(["news@shop.example"], RULES);
    const d = decide(BOTH, RULES, "detector", keep);
    expect(d.outcome).toBe("keep");
    expect(d.rule).toBe("K1");
    expect(d.live).toBe(false);
    expect(d.liveRule).toBeNull();
    const r = filterForSurface([BOTH], (x) => x, RULES, "detector", keep);
    expect(r.dropped).toHaveLength(0);
    expect(r.counts.keptBy.K1).toBe(1);
  });

  it("L3 a measure-only match alone -> not dropped, still counted", () => {
    const only: FilterRow = { ...BOTH, labels: JSON.stringify(["INBOX"]) };
    const d = decide(only, RULES, "detector");
    expect(d.outcome).toBe("suppress");
    expect(d.signal).toBe("bulkHeaders");
    expect(d.live).toBe(false);
    expect(d.liveRule).toBeNull();
    const r = filterForSurface([only], (x) => x, RULES, "detector", NO_KEEP);
    expect(r.dropped).toHaveLength(0);
    expect(r.counts.bySignal.bulkHeaders.matched).toBe(1);
    expect(r.counts.liveDropped).toBe(0);
  });

  it("L4 census attribution: first match, once per row", () => {
    const d = decide(BOTH, RULES, "detector");
    expect(d.rule).toBe("S3");
    expect(d.signal).toBe("bulkHeaders");
    const r = filterForSurface([BOTH], (x) => x, RULES, "detector", NO_KEEP);
    expect(r.counts.bySignal.bulkHeaders.matched).toBe(1);
    expect(r.counts.bySignal.gmailPromotions.matched).toBe(0);
    expect(r.counts.liveDropped).toBe(1);
  });

  it("L5 S0 measured: a later live signal drops it, unless a keep rule matches", () => {
    const rules: SenderRuleSet = { ...RULES, modes: { ...RULES.modes, seedAddress: MEASURE } };
    const seeded: FilterRow = { ...BOTH, sender: "alerts@seed.example" };
    const d = decide(seeded, rules, "detector");
    expect(d.rule).toBe("S0");
    expect(d.liveRule).toBe("S4");
    expect(d.live).toBe(true);
    const keep = buildKeepSets(["alerts@seed.example"], rules);
    const k = decide(seeded, rules, "detector", keep);
    expect(k.rule).toBe("S0");
    expect(k.keepConflict).toBe("K1");
    expect(k.live).toBe(false);
    expect(k.liveRule).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// L6 oracle: decide() as it was before this change (int-portal/auto-detect @ 33d53fdfe),
// copied verbatim except for names. Used only to prove shipped-default equality.
// ---------------------------------------------------------------------------

const GMAIL_CATEGORY_RULES: ReadonlyArray<[SuppressRuleId, string]> = [
  ["S4", "CATEGORY_PROMOTIONS"],
  ["S5", "CATEGORY_SOCIAL"],
  ["S6", "CATEGORY_UPDATES"],
];
function parseJson(v: unknown): unknown {
  if (typeof v !== "string") return v;
  try {
    return JSON.parse(v);
  } catch {
    return null;
  }
}
function labelsOf(row: FilterRow): string[] {
  const v = parseJson(row.labels ?? null);
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}
function headersOf(row: FilterRow): Record<string, unknown> | null {
  const v = parseJson(row.bulkMailHeaders ?? null);
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}
function headerText(h: Record<string, unknown>, key: string): string | null {
  const v = h[key];
  return typeof v === "string" && v.trim() ? v.trim().toLowerCase() : null;
}
function isBulk(row: FilterRow, rules: SenderRuleSet): boolean {
  const h = headersOf(row);
  if (!h) return false;
  const cfg = rules.suppress.bulkHeaders;
  for (const key of cfg.anyKeyPresent) if (headerText(h, key) !== null) return true;
  const precedence = headerText(h, "precedence");
  if (precedence !== null && cfg.precedenceValues.includes(precedence)) return true;
  const auto = headerText(h, "auto_submitted");
  return cfg.autoSubmittedCounts && auto !== null && auto !== "no";
}
function hostInSet(host: string | null, set: ReadonlySet<string>): boolean {
  if (!host || set.size === 0) return false;
  for (let h = host; ; ) {
    if (set.has(h)) return true;
    const dot = h.indexOf(".");
    if (dot < 0) return false;
    h = h.slice(dot + 1);
  }
}
function keepRuleOf(from: string | null, rules: SenderRuleSet, keep: KeepSets, opts: DecideOptions): KeepRuleId | null {
  if (!from) return null;
  const host = hostOf(from);
  if (!opts.withoutContactKeeps && keep.contactAddresses.has(from)) return "K1";
  if (rules.keep.platformAddresses.includes(from) || hostMatchesAny(host, rules.keep.platformHosts)) return "K2";
  if (!opts.withoutContactKeeps && hostInSet(host, keep.contactDomains)) return "K3";
  return null;
}
function firstSuppressAfterKeep(
  from: string | null,
  row: FilterRow,
  rules: SenderRuleSet,
  on: (signal: SenderRuleSignal) => boolean,
): SuppressRuleId | null {
  const host = hostOf(from);
  if (on("approvedHost") && hostMatchesAny(host, rules.suppress.hosts)) return "S1";
  if (on("localPart")) {
    const lp = localPartOf(from);
    if (
      lp !== null &&
      rules.suppress.localParts.some((p) => (p.match === "exact" ? lp === p.value : lp.startsWith(p.value)))
    ) {
      return "S2";
    }
  }
  if (on("bulkHeaders") && isBulk(row, rules)) return "S3";
  if (row.source === "gmail") {
    const labels = labelsOf(row);
    for (const [rule, label] of GMAIL_CATEGORY_RULES) {
      if (on(SIGNAL_OF_RULE[rule]) && labels.includes(label)) return rule;
    }
  }
  return null;
}
function decideBefore(
  row: FilterRow,
  rules: SenderRuleSet,
  surface: SenderFilterSurface,
  keep: KeepSets = NO_KEEP,
  opts: DecideOptions = {},
) {
  const on = (signal: SenderRuleSignal) => rules.modes[signal][surface] !== "off";
  const liveOn = (signal: SenderRuleSignal) => rules.modes[signal][surface] === "live";
  const from = fromAddress(row.sender);
  const keepRule = keepRuleOf(from, rules, keep, opts);
  if (on("seedAddress") && from !== null && rules.suppress.exactAddresses.includes(from)) {
    return { outcome: "suppress", rule: "S0", signal: "seedAddress", live: liveOn("seedAddress"), keepConflict: keepRule };
  }
  const rule = firstSuppressAfterKeep(from, row, rules, on);
  if (rule === null) return { outcome: "pass", rule: null, signal: null, live: false, keepConflict: null };
  const signal = SIGNAL_OF_RULE[rule];
  if (keepRule !== null) return { outcome: "keep", rule: keepRule, signal, live: false, keepConflict: null };
  return { outcome: "suppress", rule, signal, live: liveOn(signal), keepConflict: null };
}

/** Every subset of a list, in a fixed order. */
function subsets<T>(xs: readonly T[]): T[][] {
  return xs.reduce<T[][]>((acc, x) => acc.concat(acc.map((s) => [...s, x])), [[]]);
}

describe("L6 shipped defaults: identical to the pre-fix decide()", () => {
  const rules = BUNDLED_SENDER_RULES;
  const seed = rules.suppress.exactAddresses[0];
  const platform = `deals@${rules.keep.platformHosts[0]}`;
  const senders = [seed, "agent@corp.example", platform, "bad", null];
  const keeps: KeepSets[] = [
    NO_KEEP,
    buildKeepSets([seed, "agent@corp.example"], rules),
    buildKeepSets(["other@corp.example"], rules),
  ];
  const headerSets = [null, UNSUB, JSON.stringify({ precedence: "bulk" }), "not json"];
  const labelSets = subsets(["CATEGORY_PROMOTIONS", "CATEGORY_SOCIAL", "CATEGORY_UPDATES"]).map((l) =>
    JSON.stringify(["INBOX", ...l]),
  );
  const surfaces: SenderFilterSurface[] = ["learnQuestions", "addressPass", "detector"];

  const rows: FilterRow[] = [];
  for (const sender of senders)
    for (const source of ["gmail", "outlook"])
      for (const bulkMailHeaders of headerSets)
        for (const labels of labelSets) rows.push({ sender, source, labels, bulkMailHeaders });

  it("enumerates a non-trivial corpus with every outcome", () => {
    const outcomes = new Set(rows.map((r) => decide(r, rules, "learnQuestions", keeps[1]).outcome));
    expect(rows.length).toBe(5 * 2 * 4 * 8);
    expect([...outcomes].sort()).toEqual(["keep", "pass", "suppress"]);
  });

  it("decide() matches the oracle on every row, surface, keep set and option", () => {
    let compared = 0;
    for (const surface of surfaces)
      for (const keep of keeps)
        for (const opts of [{}, { withoutContactKeeps: true }])
          for (const r of rows) {
            const { liveRule, ...now } = decide(r, rules, surface, keep, opts);
            const before = decideBefore(r, rules, surface, keep, opts);
            expect(now).toEqual(before);
            expect(liveRule).toBe(before.live ? before.rule : null);
            compared += 1;
          }
    expect(compared).toBe(3 * 3 * 2 * 320);
  });
});
