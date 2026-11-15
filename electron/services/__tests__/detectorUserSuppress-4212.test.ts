/**
 * @jest-environment node
 *
 * BACKLOG-4212 PR2 — U1 on the detector (transactionService
 * scanAndExtractTransactions -> _filterDetectorInput). Harness transcribed from
 * detectorSenderFilter-4175.test.ts; the user list is injected through a mock
 * of userSuppressService. Synthetic reserved domains only.
 *
 *   D1  a listed sender never reaches extraction; an unlisted one at the same domain does
 *   D2  the list is built for the scanning user from the ACTIVE rule set
 *   D3  a deal contact (K1) on the list still reaches extraction
 *   D4  the log carries the list size and userDropped, never an address (M8)
 */
import type { SenderRuleSet } from "../../utils/senderFilter/bundledRules";

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
let mockUserList: ReadonlySet<string> = new Set();
const buildUserSuppressMock = jest.fn((_u: string, _r: SenderRuleSet) => mockUserList);
jest.mock("../userSuppressService", () => ({
  buildUserSuppress: (u: string, r: SenderRuleSet) => buildUserSuppressMock(u, r),
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

const USER = "user-4212-det";
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

beforeAll(() => {
  shipped = BUNDLED_SENDER_RULES;
});

beforeEach(() => {
  jest.clearAllMocks();
  mockRules = null;
  mockContactEmails = [];
  mockUserList = new Set();
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

const LISTED = "news@mail.example";

describe("D1 a listed sender never reaches extraction", () => {
  it("pattern path", async () => {
    mockUserList = new Set([LISTED]);
    setStrategy("pattern");
    await scan("google", [msg("listed", `"Digest" <News@Mail.Example>`), msg("friend", `"Friend" <friend@mail.example>`)]);
    expect(analyzedIds()).toEqual(["friend"]);
  });
  it("hybrid path", async () => {
    mockUserList = new Set([LISTED]);
    setStrategy("hybrid");
    await scan("microsoft", [msg("listed", `Digest <${LISTED}>`), msg("friend", "friend@mail.example")]);
    expect(extractedIds()).toEqual(["friend"]);
  });
  it("control: an empty list drops nothing", async () => {
    setStrategy("pattern");
    await scan("google", [msg("listed", `"Digest" <${LISTED}>`), msg("friend", `"Friend" <friend@mail.example>`)]);
    expect(analyzedIds()).toEqual(["listed", "friend"]);
  });
});

describe("D2 built for the scanning user from the active rule set", () => {
  it("called once with the user id and the active set", async () => {
    setStrategy("pattern");
    await scan("google", [msg("a", "a@client.example")]);
    expect(buildUserSuppressMock).toHaveBeenCalledTimes(1);
    expect(buildUserSuppressMock.mock.calls[0][0]).toBe(USER);
    expect(buildUserSuppressMock.mock.calls[0][1]).toBe(shipped);
  });
});

describe("D3 a deal contact on the list is kept", () => {
  it("K1 beats U1 on the detector", async () => {
    mockUserList = new Set([LISTED]);
    mockContactEmails = [LISTED];
    setStrategy("pattern");
    await scan("google", [msg("listed", `"Digest" <${LISTED}>`)]);
    expect(analyzedIds()).toEqual(["listed"]);
  });
});

describe("D4 the log shape", () => {
  it("size and userDropped only; no address anywhere", async () => {
    mockUserList = new Set([LISTED, "other@list.example"]);
    setStrategy("pattern");
    await scan("google", [msg("listed", `"Digest" <${LISTED}>`), msg("friend", `"Friend" <friend@mail.example>`)]);
    const log = filterLog();
    expect(log).toMatchObject({ userSuppressSize: 2, userDropped: 1, liveDropped: 1, evaluated: 2 });
    const serialized = JSON.stringify(log);
    expect(serialized).not.toContain("@");
    for (const forbidden of ["mail.example", "list.example", USER]) expect(serialized).not.toContain(forbidden);
  });
});
