/**
 * @jest-environment node
 *
 * BACKLOG-4175 PR0 — exact sender seeds, pure filter.
 *
 *   PIN  the bundled seed list is exactly the two shipped addresses, lowercase,
 *        and the seed signal is live on every surface
 *   P1   sweep against the BUNDLED rules: host, suffix, prefix and local-part
 *        neighbours of a seed all pass
 *   P2   case and the stored From shapes both match: the raw Gmail From header
 *        (gmailFetchService.ts:678, `getHeader("From")`) and the Outlook
 *        `Name <addr>` / bare form (outlookFetchService.ts:1384-1388)
 *
 * Non-Zillow addresses use reserved domains only.
 */
import { BUNDLED_SENDER_RULES, type SenderRuleSet } from "../bundledRules";
import { fromAddress, isSignalLive, matchesExactAddress } from "../senderFilter";

const SEED_A = "my-saved-home@mail.zillow.com";
const SEED_B = "recommendations@mail.zillow.com";

describe("PIN the bundled rules", () => {
  it("the seed list is exactly the two shipped addresses, all lowercase", () => {
    expect([...BUNDLED_SENDER_RULES.suppress.exactAddresses]).toEqual([SEED_A, SEED_B]);
    for (const a of BUNDLED_SENDER_RULES.suppress.exactAddresses) expect(a).toBe(a.toLowerCase().trim());
  });

  it("only the seed list is populated; hosts and local parts are empty", () => {
    expect(BUNDLED_SENDER_RULES.suppress.hosts).toEqual([]);
    expect(BUNDLED_SENDER_RULES.suppress.localParts).toEqual([]);
  });

  it("the seed signal is live for Learn questions, the address pass and the detector", () => {
    expect(BUNDLED_SENDER_RULES.modes.seedAddress).toEqual({ learnQuestions: "live", addressPass: "live", detector: "live" });
    expect(isSignalLive(BUNDLED_SENDER_RULES, "seedAddress", "addressPass")).toBe(true);
    expect(isSignalLive(BUNDLED_SENDER_RULES, "gmailUpdates", "addressPass")).toBe(false);
  });
});

describe("P1 sweep against the bundled rules: only the exact address suppresses", () => {
  it.each([
    ["the seed itself", SEED_A, true],
    ["the second seed", SEED_B, true],
    ["another sender on the same host", "agent@mail.zillow.com", false],
    ["the seed as a prefix of a longer host", "my-saved-home@mail.zillow.com.example.test", false],
    ["the seed as a suffix of a longer local part", "xmy-saved-home@mail.zillow.com", false],
    ["the seed local part on the parent host", "my-saved-home@zillow.com", false],
    ["the second seed local part on the parent host", "recommendations@zillow.com", false],
    ["the seed local part on a sibling host", "my-saved-home@mail2.zillow.com", false],
    ["a host-only string", "mail.zillow.com", false],
    ["a sub-host of the seed host", "my-saved-home@x.mail.zillow.com", false],
    ["a lead from an ordinary sender", "buyer@example.org", false],
  ])("%s -> %s", (_label, sender, suppressed) => {
    expect(matchesExactAddress(sender, BUNDLED_SENDER_RULES)).toBe(suppressed);
  });
});

describe("P2 case and stored From shapes", () => {
  it.each([
    ["mixed case", "My-Saved-Home@Mail.Zillow.com"],
    ["Gmail raw From header, quoted name", `"Zillow" <${SEED_A}>`],
    ["Gmail raw From header, mixed-case address", `"Zillow" <Recommendations@Mail.Zillow.COM>`],
    ["Outlook Name <addr>", `Zillow <${SEED_B}>`],
    ["Outlook bare address", SEED_B],
    ["surrounding whitespace", `  ${SEED_A}  `],
  ])("%s -> suppressed", (_label, sender) => {
    expect(matchesExactAddress(sender, BUNDLED_SENDER_RULES)).toBe(true);
  });

  it("only the FIRST parsed address counts (a seed second in the list passes)", () => {
    expect(matchesExactAddress(`client@example.org, ${SEED_A}`, BUNDLED_SENDER_RULES)).toBe(false);
  });

  it("empty / unparseable senders pass and parse to null", () => {
    expect([fromAddress(null), fromAddress(""), fromAddress("not an address")]).toEqual([null, null, null]);
    expect(matchesExactAddress(null, BUNDLED_SENDER_RULES)).toBe(false);
  });
});

describe("rules are data: another seed list changes what matches", () => {
  const SYNTHETIC: SenderRuleSet = {
    ...BUNDLED_SENDER_RULES,
    suppress: { ...BUNDLED_SENDER_RULES.suppress, exactAddresses: ["alerts@seed.example"] },
  };
  it("matches the synthetic seed and no longer matches the bundled ones", () => {
    expect(matchesExactAddress("Alerts <ALERTS@seed.example>", SYNTHETIC)).toBe(true);
    expect(matchesExactAddress(SEED_A, SYNTHETIC)).toBe(false);
  });
});
