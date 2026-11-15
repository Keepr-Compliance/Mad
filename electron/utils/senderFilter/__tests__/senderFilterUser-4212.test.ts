/**
 * BACKLOG-4212 — U1, the per-user suppress list, in `decide()` and
 * `filterForSurface()`. Pure: no database. Synthetic reserved domains only.
 *
 *   U1a  a listed sender is dropped on the detector and the address pass (live, rule U1, no signal)
 *   U1b  exact address only: another sender at the same domain passes (M1)
 *   U1c  K1, K2 and K3 each beat U1 (M2)
 *   U1d  U1 is never evaluated on learnQuestions (M7)
 *   U1e  S0 matched but not live on the surface: U1 still drops (M11, SR R2)
 *   U1f  the From header is normalised before the lookup
 *   U1g  filterForSurface counts userDropped and reports rule U1; bySignal is not touched
 *   U1h  no list = the decision without U1 (the default is empty)
 */
import { BUNDLED_SENDER_RULES, type SenderRuleSet } from "../bundledRules";
import { buildKeepSets, decide, NO_KEEP, type FilterRow } from "../senderFilter";
import { filterForSurface } from "../siteFilter";

const LISTED = "news@mail.example";
const LIST: ReadonlySet<string> = new Set([LISTED]);

/** Shipped modes; seeds and platform hosts replaced with reserved domains. */
const RULES: SenderRuleSet = {
  ...BUNDLED_SENDER_RULES,
  suppress: { ...BUNDLED_SENDER_RULES.suppress, exactAddresses: ["seed@seed.example"], hosts: [] },
  keep: { platformHosts: ["platform.example"], platformAddresses: [] },
};

const row = (sender: string): FilterRow => ({ sender, source: "gmail" });

describe("U1a a listed sender is dropped where U1 is live", () => {
  it.each(["detector", "addressPass"] as const)("%s", (surface) => {
    expect(decide(row(LISTED), RULES, surface, NO_KEEP, { userSuppress: LIST })).toEqual({
      outcome: "suppress",
      rule: "U1",
      signal: null,
      live: true,
      liveRule: "U1",
      keepConflict: null,
    });
  });
});

describe("U1b exact address only", () => {
  it("another sender at the listed address's domain passes", () => {
    expect(decide(row("friend@mail.example"), RULES, "detector", NO_KEEP, { userSuppress: LIST }).outcome).toBe("pass");
  });
  it("a subdomain sender passes", () => {
    expect(decide(row("news@sub.mail.example"), RULES, "detector", NO_KEEP, { userSuppress: LIST }).outcome).toBe("pass");
  });
});

describe("U1c a keep rule beats U1", () => {
  it("K1: the listed sender is a contact on one of the user's deals", () => {
    const keep = buildKeepSets([LISTED], RULES);
    const d = decide(row(LISTED), RULES, "detector", keep, { userSuppress: LIST });
    expect(d).toMatchObject({ outcome: "keep", rule: "K1", live: false, liveRule: null });
  });
  it("K2: the listed sender is on a deal-platform host", () => {
    const listed = new Set(["sign@platform.example"]);
    const d = decide(row("sign@platform.example"), RULES, "addressPass", NO_KEEP, { userSuppress: listed });
    expect(d).toMatchObject({ outcome: "keep", rule: "K2", live: false, liveRule: null });
  });
  it("K3: the listed sender shares a contact's (non-free-mail) domain", () => {
    const keep = buildKeepSets(["agent@mail.example"], RULES);
    const d = decide(row(LISTED), RULES, "detector", keep, { userSuppress: LIST });
    expect(d).toMatchObject({ outcome: "keep", rule: "K3", live: false, liveRule: null });
  });
  it("positive control: the same sender with no keep rule is dropped", () => {
    expect(decide(row(LISTED), RULES, "detector", NO_KEEP, { userSuppress: LIST }).liveRule).toBe("U1");
  });
});

describe("U1d off on learnQuestions", () => {
  it("a listed sender passes on learnQuestions", () => {
    expect(decide(row(LISTED), RULES, "learnQuestions", NO_KEEP, { userSuppress: LIST })).toMatchObject({
      outcome: "pass",
      live: false,
      liveRule: null,
    });
  });
});

describe("U1e S0 matched but not live on the surface (SR R2)", () => {
  const seedMeasure: SenderRuleSet = {
    ...RULES,
    modes: { ...RULES.modes, seedAddress: { ...RULES.modes.seedAddress, detector: "measure" } },
  };
  it("the listed seed address is still dropped, by U1", () => {
    const listed = new Set(["seed@seed.example"]);
    const d = decide(row("seed@seed.example"), seedMeasure, "detector", NO_KEEP, { userSuppress: listed });
    expect(d).toMatchObject({ outcome: "suppress", rule: "S0", live: true, liveRule: "U1" });
  });
  it("control: unlisted, the measured seed is not dropped", () => {
    const d = decide(row("seed@seed.example"), seedMeasure, "detector", NO_KEEP, { userSuppress: LIST });
    expect(d).toMatchObject({ outcome: "suppress", rule: "S0", live: false, liveRule: null });
  });
  it("S0 live: S0 wins over U1", () => {
    const listed = new Set(["seed@seed.example"]);
    expect(decide(row("seed@seed.example"), RULES, "detector", NO_KEEP, { userSuppress: listed }).liveRule).toBe("S0");
  });
});

describe("U1f the From header is normalised", () => {
  it("a display-name header in mixed case matches the lowercased entry", () => {
    expect(
      decide(row('"Digest" <News@Mail.Example>'), RULES, "detector", NO_KEEP, { userSuppress: LIST }).liveRule,
    ).toBe("U1");
  });
});

describe("U1g filterForSurface", () => {
  it("counts userDropped, reports rule U1, leaves bySignal alone", () => {
    const items = [row(LISTED), row("client@client.example"), row("friend@mail.example")];
    const r = filterForSurface(items, (x) => x, RULES, "detector", NO_KEEP, { userSuppress: LIST });
    expect(r.passed.map((x) => x.sender)).toEqual(["client@client.example", "friend@mail.example"]);
    expect(r.dropped).toEqual([{ item: items[0], rule: "U1" }]);
    expect(r.counts.userDropped).toBe(1);
    expect(r.counts.liveDropped).toBe(1);
    expect(Object.values(r.counts.bySignal).every((s) => s.matched === 0)).toBe(true);
  });
  it("without a list nothing is user-dropped", () => {
    const r = filterForSurface([row(LISTED)], (x) => x, RULES, "detector", NO_KEEP);
    expect(r.counts.userDropped).toBe(0);
    expect(r.passed).toHaveLength(1);
  });
});

describe("U1h the default is empty", () => {
  it("decide without opts equals decide with an empty list", () => {
    for (const s of [LISTED, "seed@seed.example", "sign@platform.example", "x@y.example"]) {
      for (const surface of ["detector", "addressPass", "learnQuestions"] as const) {
        expect(decide(row(s), RULES, surface)).toEqual(decide(row(s), RULES, surface, NO_KEEP, { userSuppress: new Set() }));
      }
    }
  });
});
