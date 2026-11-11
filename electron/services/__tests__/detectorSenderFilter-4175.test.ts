/**
 * @jest-environment node
 *
 * BACKLOG-4175 PR1b — the detector's sender filter (transactionService
 * scanAndExtractTransactions). Every extraction path must see the filtered
 * list: pattern-only (`batchAnalyze`), hybrid (`extract`), and the pattern
 * fallback when hybrid throws. The scanned count stays unfiltered.
 *
 * Fetch results are shaped like the fetchers' ParsedEmail: Gmail `from` is the
 * raw From header (`"Name" <addr>`), `labels` is `labelIds`
 * (gmailFetchService.ts:816), `bulkMailHeaders` is the object built by
 * buildBulkMailHeaders (:831); Outlook `labels` are categories
 * (outlookFetchService.ts:1511). Rule sets are injected through a mutable
 * mock of bundledRules. Synthetic domains only.
 */
import type {
  SenderRuleModes,
  SenderRuleSet,
  SenderRuleSignal,
} from "../../utils/senderFilter/bundledRules";

jest.mock("../databaseService");
jest.mock("../gmailFetchService");
jest.mock("../outlookFetchService");
jest.mock("../transactionExtractorService");
jest.mock("../logService");
jest.mock("../emailAttachmentService");
jest.mock("../supabaseService");
jest.mock("../db/core/dbConnection", () => ({
  dbGet: jest.fn(() => null),
  dbAll: jest.fn(() => []),
  dbRun: jest.fn(),
  dbTransaction: <T,>(fn: () => T): T => fn(),
}));
jest.mock("../auditService", () => ({
  __esModule: true,
  default: { log: jest.fn(), recordInTransaction: jest.fn(), recordFailure: jest.fn() },
  AuditNotRecordedError: class AuditNotRecordedError extends Error {},
}));
jest.mock("../../utils/preferenceHelper", () => ({
  isContactSourceEnabled: jest.fn().mockResolvedValue(false),
  isTextPeopleEnabled: jest.fn().mockResolvedValue(false),
}));
let mockContactEmails: string[] = [];
jest.mock("../db/dealContactEmailsDb", () => ({
  listDealContactEmails: jest.fn(() => mockContactEmails),
}));
let mockRules: SenderRuleSet | null = null;
jest.mock("../../utils/senderFilter/bundledRules", () => {
  const actual = jest.requireActual("../../utils/senderFilter/bundledRules");
  return {
    ...actual,
    get BUNDLED_SENDER_RULES() {
      return mockRules ?? actual.BUNDLED_SENDER_RULES;
    },
  };
});

import transactionService from "../transactionService";
import databaseService from "../databaseService";
import gmailFetchService from "../gmailFetchService";
import outlookFetchService from "../outlookFetchService";
import transactionExtractorService from "../transactionExtractorService";
import logService from "../logService";
import { BUNDLED_SENDER_RULES } from "../../utils/senderFilter/bundledRules";

const USER = "user-4175";
let shipped: SenderRuleSet;

interface FakeParsed {
  id: string;
  subject: string;
  from: string;
  date: string;
  body: string;
  bodyPlain: string;
  labels: string[];
  bulkMailHeaders: Record<string, string> | null;
}

function msg(id: string, from: string, extra: Partial<FakeParsed> = {}): FakeParsed {
  return {
    id,
    subject: `1428 Maple Ave ${id}`,
    from,
    date: "2026-03-01T15:00:00.000Z",
    body: "1428 Maple Ave",
    bodyPlain: "1428 Maple Ave",
    labels: [],
    bulkMailHeaders: null,
    ...extra,
  };
}

function rulesWith(
  modes: Partial<Record<SenderRuleSignal, Partial<SenderRuleModes>>>,
  suppress: Partial<SenderRuleSet["suppress"]> = {},
): SenderRuleSet {
  const next = { ...shipped.modes } as Record<SenderRuleSignal, SenderRuleModes>;
  for (const [s, m] of Object.entries(modes) as Array<[SenderRuleSignal, Partial<SenderRuleModes>]>) {
    next[s] = { ...next[s], ...m };
  }
  return { ...shipped, suppress: { ...shipped.suppress, ...suppress }, modes: next };
}

const batchAnalyze = transactionExtractorService.batchAnalyze as jest.Mock;
const extract = jest.fn();
const selectStrategy = jest.fn();

function setStrategy(method: "pattern" | "hybrid"): void {
  selectStrategy.mockResolvedValue({ method, reason: "test", provider: "openai" });
}

async function scan(provider: "google" | "microsoft", fetched: FakeParsed[]) {
  const svc = provider === "google" ? gmailFetchService : outlookFetchService;
  (svc.initialize as jest.Mock).mockResolvedValue(undefined);
  (svc.searchEmails as jest.Mock).mockResolvedValue(fetched);
  const result = await transactionService.scanAndExtractTransactions(USER, { provider });
  expect(result.success).toBe(true);
  expect(result.emailsScanned).toBe(fetched.length);
  return result;
}

/** Subjects passed to batchAnalyze (pattern path) — the subject carries the id. */
function analyzedIds(): string[] {
  expect(batchAnalyze).toHaveBeenCalledTimes(1);
  return (batchAnalyze.mock.calls[0][0] as Array<{ subject?: string }>).map((e) => String(e.subject).split(" ").pop()!);
}

function extractedIds(): string[] {
  expect(extract).toHaveBeenCalledTimes(1);
  return (extract.mock.calls[0][0] as Array<{ subject: string }>).map((m) => m.subject.split(" ").pop()!);
}

function filterLog(): Record<string, unknown> {
  const call = (logService.info as jest.Mock).mock.calls.find((c) => String(c[0]).includes("detector sender filter"));
  if (!call) throw new Error("no detector sender filter log");
  return call[2] as Record<string, unknown>;
}

const SEED = () => shipped.suppress.exactAddresses[0];

beforeAll(() => {
  shipped = BUNDLED_SENDER_RULES;
});

beforeEach(() => {
  jest.clearAllMocks();
  mockRules = null;
  mockContactEmails = [];
  (databaseService.getOAuthTokenSyncTime as jest.Mock).mockResolvedValue(null);
  (databaseService.updateOAuthTokenSyncTime as jest.Mock).mockResolvedValue(undefined);
  (databaseService.getTransactions as jest.Mock).mockResolvedValue([]);
  (databaseService.getContacts as jest.Mock).mockResolvedValue([]);
  batchAnalyze.mockReturnValue([]);
  (transactionExtractorService.groupByProperty as jest.Mock).mockReturnValue({});
  extract.mockResolvedValue({
    detectedTransactions: [],
    analyzedMessages: [],
    extractionMethod: "hybrid",
    llmUsed: true,
    latencyMs: 1,
  });
  const t = transactionService as unknown as Record<string, unknown>;
  t.llmConfigService = {};
  t.strategyService = { selectStrategy };
  t.hybridExtractor = { extract };
});

describe("C9: a seed row never reaches extraction", () => {
  const fetched = () => [msg("seed", `"Alerts" <${SEED()}>`), msg("agent", `"Agent" <agent@example.com>`)];

  it("pattern path: batchAnalyze never sees the seed", async () => {
    setStrategy("pattern");
    await scan("google", fetched());
    expect(analyzedIds()).toEqual(["agent"]);
  });

  it("hybrid path: extract never sees the seed", async () => {
    setStrategy("hybrid");
    await scan("google", fetched());
    expect(extractedIds()).toEqual(["agent"]);
    expect(batchAnalyze).not.toHaveBeenCalled();
  });

  it("hybrid failure falls back to pattern: batchAnalyze never sees the seed", async () => {
    setStrategy("hybrid");
    extract.mockRejectedValue(new Error("llm down"));
    await scan("google", fetched());
    expect(extract).toHaveBeenCalledTimes(1);
    expect(analyzedIds()).toEqual(["agent"]);
  });
});

describe("shipped modes: the detector drops ONLY the exact seeds", () => {
  it("bulk and Promotions mail reaches batchAnalyze; the seed does not; measure counts are logged", async () => {
    setStrategy("pattern");
    await scan("google", [
      msg("seed", `"Alerts" <${SEED()}>`),
      msg("bulk", `"News" <news@list.example>`, { bulkMailHeaders: { list_unsubscribe: "<mailto:u@list.example>" } }),
      msg("promo", `"Deals" <deals@shop.example>`, { labels: ["INBOX", "CATEGORY_PROMOTIONS"] }),
    ]);
    expect(analyzedIds()).toEqual(["bulk", "promo"]);
    const log = filterLog();
    expect(log).toMatchObject({
      evaluated: 3,
      liveDropped: 1,
      bySignal: expect.objectContaining({
        seedAddress: { mode: "live", matched: 1 },
        bulkHeaders: { mode: "measure", matched: 1 },
        gmailPromotions: { mode: "measure", matched: 1 },
      }),
    });
    expect(Object.keys(log).sort()).toEqual(["bySignal", "evaluated", "keptBy", "liveDropped", "senderRulesSource", "senderRulesVersion"]);
    const serialized = JSON.stringify(log);
    expect(serialized).not.toContain("@");
    for (const forbidden of ["list.example", "shop.example", SEED().split("@")[1], USER]) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  it("the measure count moves when a measure-mode match is added", async () => {
    setStrategy("pattern");
    await scan("google", [
      msg("bulk1", `"News" <news@list.example>`, { bulkMailHeaders: { list_unsubscribe: "<mailto:u@list.example>" } }),
      msg("bulk2", `"News" <news@list2.example>`, { bulkMailHeaders: { precedence: "bulk" } }),
    ]);
    expect(filterLog()).toMatchObject({ bySignal: expect.objectContaining({ bulkHeaders: { mode: "measure", matched: 2 } }) });
  });
});

describe("provider tag: Gmail labels count only on Gmail mail", () => {
  it("a Google-account message reaches decide() with source gmail (Promotions live drops it)", async () => {
    mockRules = rulesWith({ gmailPromotions: { detector: "live" } });
    setStrategy("pattern");
    await scan("google", [
      msg("promo", `"Deals" <deals@shop.example>`, { labels: ["CATEGORY_PROMOTIONS"] }),
      msg("plain", `"Agent" <agent@example.com>`),
    ]);
    expect(analyzedIds()).toEqual(["plain"]);
  });

  it("an Outlook category with the same text is not a Gmail label", async () => {
    mockRules = rulesWith({ gmailPromotions: { detector: "live" } });
    setStrategy("pattern");
    await scan("microsoft", [msg("cat", "Deals <deals@shop.example>", { labels: ["CATEGORY_PROMOTIONS"] })]);
    expect(analyzedIds()).toEqual(["cat"]);
  });
});

describe("surface wiring: the detector decides on surface detector", () => {
  it("Promotions live on Learn and the address pass but measure on detector: nothing dropped", async () => {
    mockRules = rulesWith({ gmailPromotions: { detector: "measure", learnQuestions: "live", addressPass: "live" } });
    setStrategy("pattern");
    await scan("google", [msg("promo", `"Deals" <deals@shop.example>`, { labels: ["CATEGORY_PROMOTIONS"] })]);
    expect(analyzedIds()).toEqual(["promo"]);
  });

  it("Promotions live on detector only: dropped (positive control)", async () => {
    mockRules = rulesWith({ gmailPromotions: { detector: "live", learnQuestions: "measure", addressPass: "off" } });
    setStrategy("pattern");
    await scan("google", [msg("promo", `"Deals" <deals@shop.example>`, { labels: ["CATEGORY_PROMOTIONS"] })]);
    expect(analyzedIds()).toEqual([]);
  });
});

describe("KH detector: a deal contact on an approved host is never dropped", () => {
  it("K1 keeps the contact; an unkept approved-host sender is dropped (positive control)", async () => {
    mockRules = rulesWith({}, { hosts: ["corp.example", "blocked.example"] });
    mockContactEmails = ["agent@corp.example"];
    setStrategy("pattern");
    await scan("google", [
      msg("contact", `"Agent" <agent@corp.example>`),
      msg("host", `"News" <news@blocked.example>`),
    ]);
    expect(analyzedIds()).toEqual(["contact"]);
    expect(filterLog()).toMatchObject({ keptBy: { K1: 1, K2: 0, K3: 0 } });
  });
});

describe("PR4 (4175) the detector reads the ACTIVE rule set and never waits on the download", () => {
  const SEED_X = "x@example.test";
  let store: typeof import("../senderRuleSetStore");
  beforeEach(async () => {
    const paths = await import("../../capabilities/appPathsProvider");
    paths.resetAppPaths(); // memory only: never write a cache into the shared test userData
    store = await import("../senderRuleSetStore");
    store.__resetForTests();
  });
  afterEach(() => store.__resetForTests());

  it("RS16 a downloaded set's seed (absent from bundled) is dropped; the log names the source", async () => {
    expect(shipped.suppress.exactAddresses).not.toContain(SEED_X);
    const { parseSenderRuleSet } = await import("../../utils/senderFilter/ruleSetSchema");
    const downloaded = parseSenderRuleSet(
      JSON.parse(JSON.stringify({ ...shipped, version: 5, suppress: { ...shipped.suppress, exactAddresses: [SEED_X] } })),
    );
    await store.applyServerOutcome({ kind: "valid", rules: downloaded! }, USER);
    setStrategy("pattern");
    await scan("google", [msg("x", `"Alerts" <${SEED_X}>`), msg("agent", `"Agent" <agent@example.com>`)]);
    expect(analyzedIds()).toEqual(["agent"]);
    expect(filterLog()).toMatchObject({ senderRulesVersion: 5, senderRulesSource: "download", liveDropped: 1 });
  });

  it("RS9a (detector) a scan completes while the session read and the download never answer", async () => {
    const supabaseService = (await import("../supabaseService")).default as unknown as { getAuthSession: jest.Mock };
    supabaseService.getAuthSession.mockReturnValue(new Promise(() => undefined));
    const triggered = jest.fn(() => new Promise(() => undefined));
    store.setRefreshTrigger(triggered);
    setStrategy("pattern");
    (gmailFetchService.initialize as jest.Mock).mockResolvedValue(undefined);
    (gmailFetchService.searchEmails as jest.Mock).mockResolvedValue([msg("agent", `"Agent" <agent@example.com>`)]);
    const HUNG = Symbol("hung");
    let sentinel: ReturnType<typeof setTimeout> | undefined;
    const outcome = await Promise.race([
      transactionService.scanAndExtractTransactions(USER, { provider: "google" }),
      new Promise((resolve) => {
        sentinel = setTimeout(() => resolve(HUNG), 3_000);
      }),
    ]);
    clearTimeout(sentinel);
    expect(outcome).not.toBe(HUNG);
    expect((outcome as { success: boolean }).success).toBe(true);
    expect(triggered).toHaveBeenCalled();
    expect(filterLog()).toMatchObject({ evaluated: 1 });
  });
});
