/**
 * BACKLOG-4175 PR1a — the full sender filter (S0-S6, K1-K3, modes) and the
 * rule-set schema. Pure: no database.
 *
 *   PIN   the shipped modes table, the free-mail list, the platform hosts and
 *         the bulk-header rule are exactly the shipped data
 *   SCH   the schema accepts the bundled set and refuses extra keys at every
 *         level, `gmailUpdates: live`, Authentication-Results as a bulk key,
 *         bad hosts / addresses / uppercase
 *   C1    keep beats S3-S6 (platform host + List-Unsubscribe -> keep)
 *   C2    keep beats S2 (no-reply local part on a platform host -> keep)
 *   C3    a Promotions-labelled Gmail row: counted on Learn questions, passes
 *         where the mode is off; an Outlook row with the same category passes
 *   C4    host match is exact-or-subdomain, never substring
 *   C5/P1 the exact-seed sweep runs through decide(): no widening
 *   C14   modes decide: an S3 row passes on a surface where bulkHeaders is off
 *   C15   K3 never includes a free-mail domain
 *   C16   local parts are literal strings (no RegExp from data)
 *   S0    an exact seed beats a keep rule and records the conflict
 *
 * Synthetic domains only (`*.example`, `*.test`), except the pinned shipped data.
 */
import { BUNDLED_SENDER_RULES, type SenderRuleSet } from "../bundledRules";
import { parseSenderRuleSet, SenderRuleSetSchema } from "../ruleSetSchema";
import { buildKeepSets, decide, NO_KEEP, type FilterRow } from "../senderFilter";
import { hostMatches } from "../hostMatch";

/** Synthetic rules: every signal measured on Learn questions, off on the address pass. */
const MEASURE = { learnQuestions: "measure", addressPass: "off", detector: "measure" } as const;
const RULES: SenderRuleSet = {
  ...BUNDLED_SENDER_RULES,
  suppress: {
    exactAddresses: ["alerts@seed.example"],
    hosts: ["blocked.example"],
    localParts: [
      { value: "noreply", match: "exact" },
      { value: "no.reply", match: "exact" },
      { value: "newsletter", match: "prefix" },
    ],
    bulkHeaders: { anyKeyPresent: ["list_unsubscribe"], precedenceValues: ["bulk"], autoSubmittedCounts: false },
  },
  keep: { platformHosts: ["platform.example"], platformAddresses: ["deals@partner.example"] },
  freeMailDomains: ["freemail.example"],
  modes: {
    seedAddress: { learnQuestions: "live", addressPass: "live", detector: "live" },
    approvedHost: { learnQuestions: "live", addressPass: "live", detector: "live" },
    localPart: MEASURE,
    bulkHeaders: MEASURE,
    gmailPromotions: MEASURE,
    gmailSocial: MEASURE,
    gmailUpdates: MEASURE,
  },
};

const UNSUB = { list_unsubscribe: "<mailto:u@x.example>" };
const row = (sender: string, extra: Partial<FilterRow> = {}): FilterRow => ({ sender, source: "gmail", ...extra });

describe("PIN the shipped rule data", () => {
  it("modes equal the shipped defaults table", () => {
    const measureOnly = { learnQuestions: "measure", addressPass: "off", detector: "measure" };
    const live = { learnQuestions: "live", addressPass: "live", detector: "live" };
    expect(BUNDLED_SENDER_RULES.modes).toEqual({
      seedAddress: live,
      approvedHost: live,
      localPart: measureOnly,
      bulkHeaders: measureOnly,
      gmailPromotions: measureOnly,
      gmailSocial: measureOnly,
      gmailUpdates: measureOnly,
    });
  });

  it("platform hosts are exactly the five confirmed hosts; platform addresses empty", () => {
    expect([...BUNDLED_SENDER_RULES.keep.platformHosts]).toEqual([
      "docusign.net",
      "docusign.com",
      "springcm.net",
      "showingtime.com",
      "showingtime.net",
    ]);
    expect(BUNDLED_SENDER_RULES.keep.platformAddresses).toEqual([]);
  });

  it("free-mail domains are exactly the shipped list, under 30 entries, no duplicates", () => {
    expect([...BUNDLED_SENDER_RULES.freeMailDomains]).toEqual([
      "gmail.com", "googlemail.com", "outlook.com", "hotmail.com", "live.com", "msn.com",
      "yahoo.com", "ymail.com", "rocketmail.com", "icloud.com", "me.com", "mac.com",
      "aol.com", "proton.me", "protonmail.com", "pm.me", "gmx.com", "gmx.net", "mail.com",
      "zoho.com", "yandex.com", "fastmail.com", "comcast.net", "verizon.net", "att.net",
      "sbcglobal.net", "bellsouth.net", "cox.net", "charter.net", "earthlink.net",
    ]);
    expect(new Set(BUNDLED_SENDER_RULES.freeMailDomains).size).toBe(BUNDLED_SENDER_RULES.freeMailDomains.length);
  });

  it("the bulk-header rule and the census threshold", () => {
    expect(BUNDLED_SENDER_RULES.suppress.bulkHeaders).toEqual({
      anyKeyPresent: ["list_unsubscribe", "list_unsubscribe_post"],
      precedenceValues: ["bulk", "list", "junk"],
      autoSubmittedCounts: false,
    });
    expect(BUNDLED_SENDER_RULES.thresholds.minCensusLinkedEmails).toBe(20);
  });
});

describe("SCH the rule-set schema", () => {
  const clone = (): Record<string, unknown> => JSON.parse(JSON.stringify(BUNDLED_SENDER_RULES));

  it("accepts the bundled set and the synthetic test set", () => {
    expect(parseSenderRuleSet(clone())).not.toBeNull();
    expect(parseSenderRuleSet(JSON.parse(JSON.stringify(RULES)))).not.toBeNull();
  });

  it.each<[string, string[], unknown]>([
    ["an extra top-level key", ["extra"], 1],
    ["an extra key under suppress", ["suppress", "extra"], []],
    ["an extra key in a localParts item", ["suppress", "localParts"], [{ value: "x", match: "exact", re: "." }]],
    ["an extra key under bulkHeaders", ["suppress", "bulkHeaders", "extra"], true],
    ["an extra key in a mode", ["modes", "seedAddress", "extra"], "live"],
    ["an extra signal", ["modes", "outlookOther"], { learnQuestions: "off", addressPass: "off", detector: "off" }],
    ["gmailUpdates live on learnQuestions", ["modes", "gmailUpdates", "learnQuestions"], "live"],
    ["gmailUpdates live on detector", ["modes", "gmailUpdates", "detector"], "live"],
    ["authentication_results as a bulk key", ["suppress", "bulkHeaders", "anyKeyPresent"], ["authentication_results"]],
    ["a host with a space", ["suppress", "hosts"], ["a b"]],
    ["a host without a dot", ["suppress", "hosts"], ["localhost"]],
    ["an uppercase host", ["keep", "platformHosts"], ["Platform.example"]],
    ["an address with two @", ["suppress", "exactAddresses"], ["a@b@c.example"]],
    ["schema 2", ["schema"], 2],
    ["reportMaxRows over 500", ["thresholds", "reportMaxRows"], 501],
  ])("refuses %s", (_label, path, value) => {
    const r = clone();
    let at = r;
    for (const k of path.slice(0, -1)) at = at[k] as Record<string, unknown>;
    at[path[path.length - 1]] = value;
    expect(SenderRuleSetSchema.safeParse(r).success).toBe(false);
    expect(parseSenderRuleSet(r)).toBeNull();
  });
});

describe("C4 host match: exact or true subdomain, never substring", () => {
  it.each([
    ["sub.blocked.example", "suppress"],
    ["blocked.example", "suppress"],
    ["notblocked.example", "pass"],
    ["blocked.example.evil.test", "pass"],
    ["xblocked.example", "pass"],
  ])("x@%s -> %s", (host, outcome) => {
    expect(decide(row(`x@${host}`), RULES, "learnQuestions").outcome).toBe(outcome);
  });

  it("hostMatches is the same rule", () => {
    expect(hostMatches("a.b.example", "b.example")).toBe(true);
    expect(hostMatches("ab.example", "b.example")).toBe(false);
  });
});

describe("C5/P1 the exact-seed sweep through decide(): only the exact address suppresses", () => {
  it.each([
    ["my-saved-home@mail.zillow.com", "suppress"],
    ["recommendations@mail.zillow.com", "suppress"],
    ["agent@mail.zillow.com", "pass"],
    ["other@zillow.com", "pass"],
    ["my-saved-home@zillow.com", "pass"],
    ["my-saved-home@x.mail.zillow.com", "pass"],
    ["xmy-saved-home@mail.zillow.com", "pass"],
  ])("%s -> %s (bundled rules)", (sender, outcome) => {
    const d = decide(row(sender), BUNDLED_SENDER_RULES, "learnQuestions");
    expect(d.outcome).toBe(outcome);
    if (outcome === "suppress") expect(d.rule).toBe("S0");
  });
});

describe("C1/C2 keep rules beat S1-S6", () => {
  it("C1 a platform host carrying List-Unsubscribe -> keep (K2); without keep it would be S3", () => {
    const r = row("envelopes@mail.platform.example", { bulkMailHeaders: UNSUB });
    expect(decide(r, RULES, "learnQuestions")).toMatchObject({ outcome: "keep", rule: "K2", signal: "bulkHeaders" });
    const noKeep = { ...RULES, keep: { platformHosts: [], platformAddresses: [] } };
    expect(decide(r, noKeep, "learnQuestions")).toMatchObject({ outcome: "suppress", rule: "S3" });
  });

  it("C1 a platform address with a Promotions label -> keep (K2)", () => {
    const r = row("deals@partner.example", { labels: '["CATEGORY_PROMOTIONS"]' });
    expect(decide(r, RULES, "learnQuestions")).toMatchObject({ outcome: "keep", rule: "K2" });
  });

  it("C2 noreply@ on a platform host -> keep (K2), not S2", () => {
    expect(decide(row("noreply@platform.example"), RULES, "learnQuestions")).toMatchObject({ outcome: "keep", rule: "K2", signal: "localPart" });
    expect(decide(row("noreply@other.example"), RULES, "learnQuestions")).toMatchObject({ outcome: "suppress", rule: "S2" });
  });

  it("a keep rule with nothing to override is a pass, not a keep", () => {
    expect(decide(row("agent@platform.example"), RULES, "learnQuestions")).toMatchObject({ outcome: "pass", rule: null });
  });
});

describe("S0 beats keep and records the conflict", () => {
  it("a seed address that is also a deal contact -> suppress, keepConflict K1", () => {
    const keep = buildKeepSets(["Alerts@Seed.example"], RULES);
    const d = decide(row('"Seed" <alerts@seed.example>'), RULES, "learnQuestions", keep);
    expect(d).toMatchObject({ outcome: "suppress", rule: "S0", live: true, keepConflict: "K1" });
    expect(decide(row("alerts@seed.example"), RULES, "learnQuestions").keepConflict).toBeNull();
  });
});

describe("S3 bulk headers: the rule-set values decide", () => {
  it.each([
    ["List-Unsubscribe present", { list_unsubscribe: "<https://u.example>" }, "suppress"],
    ["Precedence: Bulk", { precedence: " Bulk " }, "suppress"],
    ["Precedence: first-class", { precedence: "first-class" }, "pass"],
    ["Authentication-Results only", { authentication_results: ["mx.example; spf=pass"] }, "pass"],
    ["Auto-Submitted: auto-generated (autoSubmittedCounts false)", { auto_submitted: "auto-generated" }, "pass"],
    ["an empty List-Unsubscribe", { list_unsubscribe: "  " }, "pass"],
  ])("%s -> %s", (_l, headers, outcome) => {
    expect(decide(row("a@x.example", { bulkMailHeaders: JSON.stringify(headers) }), RULES, "learnQuestions").outcome).toBe(outcome);
  });

  it("autoSubmittedCounts true makes Auto-Submitted count, except 'no'", () => {
    const r = { ...RULES, suppress: { ...RULES.suppress, bulkHeaders: { ...RULES.suppress.bulkHeaders, autoSubmittedCounts: true } } };
    expect(decide(row("a@x.example", { bulkMailHeaders: { auto_submitted: "auto-generated" } }), r, "learnQuestions").outcome).toBe("suppress");
    expect(decide(row("a@x.example", { bulkMailHeaders: { auto_submitted: "no" } }), r, "learnQuestions").outcome).toBe("pass");
  });

  it("unparseable stored JSON is no signal", () => {
    expect(decide(row("a@x.example", { bulkMailHeaders: "{not json" }), RULES, "learnQuestions").outcome).toBe("pass");
  });
});

describe("C3 Gmail categories: Gmail rows only, mode per surface", () => {
  const promo = (source: string) => row("buyer@client.example", { source, labels: '["INBOX","CATEGORY_PROMOTIONS"]' });

  it("a forwarded listing in Promotions: counted (measure) on Learn questions, passes on the address pass", () => {
    expect(decide(promo("gmail"), RULES, "learnQuestions")).toMatchObject({ outcome: "suppress", rule: "S4", live: false });
    expect(decide(promo("gmail"), RULES, "addressPass").outcome).toBe("pass");
  });

  it("an Outlook row with the same category name passes (categories are user tags)", () => {
    expect(decide(promo("outlook"), RULES, "learnQuestions").outcome).toBe("pass");
  });

  it.each([
    ["CATEGORY_SOCIAL", "S5"],
    ["CATEGORY_UPDATES", "S6"],
  ])("%s -> %s", (label, rule) => {
    expect(decide(row("a@x.example", { labels: [label] }), RULES, "learnQuestions").rule).toBe(rule);
  });
});

describe("C14 modes decide what is evaluated", () => {
  it("an S3 row passes on the address pass (mode off) and is counted, not live, on Learn questions", () => {
    const r = row("a@x.example", { bulkMailHeaders: UNSUB });
    expect(decide(r, BUNDLED_SENDER_RULES, "addressPass").outcome).toBe("pass");
    expect(decide(r, BUNDLED_SENDER_RULES, "learnQuestions")).toMatchObject({ outcome: "suppress", rule: "S3", live: false });
  });

  it("a live approved host is live; a measured signal is not", () => {
    expect(decide(row("x@blocked.example"), RULES, "learnQuestions").live).toBe(true);
    expect(decide(row("noreply@other.example"), RULES, "learnQuestions").live).toBe(false);
  });
});

describe("C15 K3 never includes a free-mail domain", () => {
  it("a free-mail contact keeps its own address (K1) but not its domain", () => {
    const keep = buildKeepSets(["friend@freemail.example", "agent@smallco.example"], RULES);
    expect([...keep.contactDomains]).toEqual(["smallco.example"]);
    const bulk = (s: string) => row(s, { bulkMailHeaders: UNSUB });
    expect(decide(bulk("promo@freemail.example"), RULES, "learnQuestions", keep)).toMatchObject({ outcome: "suppress", rule: "S3" });
    expect(decide(bulk("friend@freemail.example"), RULES, "learnQuestions", keep)).toMatchObject({ outcome: "keep", rule: "K1" });
    expect(decide(bulk("news@smallco.example"), RULES, "learnQuestions", keep)).toMatchObject({ outcome: "keep", rule: "K3" });
    expect(decide(bulk("news@mail.smallco.example"), RULES, "learnQuestions", keep)).toMatchObject({ outcome: "keep", rule: "K3" });
  });

  it("withoutContactKeeps leaves out K1 and K3, keeps K2", () => {
    const keep = buildKeepSets(["agent@smallco.example"], RULES);
    const opts = { withoutContactKeeps: true };
    const bulk = (s: string) => row(s, { bulkMailHeaders: UNSUB });
    expect(decide(bulk("agent@smallco.example"), RULES, "learnQuestions", keep, opts).outcome).toBe("suppress");
    expect(decide(bulk("news@smallco.example"), RULES, "learnQuestions", keep, opts).outcome).toBe("suppress");
    expect(decide(bulk("x@platform.example"), RULES, "learnQuestions", keep, opts).outcome).toBe("keep");
  });
});

describe("C16 local parts are literal strings", () => {
  it.each([
    ["noXreply@x.example", "pass"],
    ["no.reply@x.example", "suppress"],
    ["newsletter-weekly@x.example", "suppress"],
    ["weekly-newsletter@x.example", "pass"],
    ["noreply2@x.example", "pass"],
  ])("%s -> %s", (sender, outcome) => {
    expect(decide(row(sender), RULES, "learnQuestions", NO_KEEP).outcome).toBe(outcome);
  });
});
