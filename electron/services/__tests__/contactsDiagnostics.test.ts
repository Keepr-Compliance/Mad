/**
 * @jest-environment node
 *
 * BACKLOG-2394 — the Contacts section of the support-ticket diagnostics block.
 *
 * The contract under test is the COMPOSED OUTPUT, not the code's intentions.
 * Every assertion below runs against the joined string a support engineer would
 * actually read, built from fixtures deliberately stuffed with a real-looking
 * account name so a leaked absolute path has something to be caught by.
 *
 * The three properties that matter, in order of how badly their absence hurt:
 *   1. a machine with 2+ address books shows the count (the question three
 *      investigations could not answer);
 *   2. a machine where a sync never ran SAYS SO — it must never emit `0`,
 *      because `0` reads as "this user has no contacts";
 *   3. a failed or partial read is distinguishable from an empty one.
 */

import fs from "fs";
import os from "os";
import path from "path";

const mockLogInfo = jest.fn();

jest.mock("../logService", () => ({
  __esModule: true,
  default: {
    info: (...args: unknown[]) => mockLogInfo(...args),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

import {
  collectContactsDiagnostics,
  formatContactsDiagnostics,
  formatRecordedAt,
} from "../contactsDiagnostics";
import {
  recordDiscovery,
  recordParse,
  recordPicker,
  recordShadowSync,
  resetContactIngestionFunnel,
  type DiscoveryStage,
  type ParseStage,
  type PickerStage,
  type ShadowSyncStage,
} from "../contactIngestionFunnel";

// A realistic account name. If it ever appears in the composed block, an
// absolute path leaked.
const ACCOUNT = "margaret";

const BASE_REL = "Library/Application Support/AddressBook";

let tmpRoot: string;
let home: string;

/** Create an on-disk address book. Discovery never opens these — it lists. */
function makeBook(relPath: string): void {
  const full = path.join(home, BASE_REL, relPath);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, "");
}

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "keepr-2394-"));
  home = path.join(tmpRoot, "Users", ACCOUNT);
  fs.mkdirSync(home, { recursive: true });
  resetContactIngestionFunnel();
  mockLogInfo.mockClear();
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  resetContactIngestionFunnel();
});

async function compose(now?: number): Promise<string> {
  const diag = await collectContactsDiagnostics({
    homeDir: home,
    platform: "darwin",
    fullDiskAccess: "granted",
    uptimeSeconds: 42,
  });
  return formatContactsDiagnostics(diag, now).join("\n");
}

// ============================================
// 1. THE MACHINE WITH MORE THAN ONE ADDRESS BOOK
// ============================================

describe("live: address books on disk", () => {
  it("reports the count and the redacted path of every book on a 3-book machine", async () => {
    makeBook("AddressBook-v22.abcddb");
    makeBook("Sources/0CA70C1F-1234-5678-9ABC-DEF012345678/AddressBook-v22.abcddb");
    makeBook("Sources/AAAAAAAA-9999-0000-1111-222222222222/AddressBook-v22.abcddb");

    const block = await compose();

    expect(block).toContain("address books on disk: 3");
    expect(block).toContain("FDA=granted");
    // One line per book, base-relative and UUID-shortened.
    expect(block).toContain("AddressBook-v22.abcddb");
    expect(block).toContain("Sources/0CA70…/AddressBook-v22.abcddb");
    expect(block).toContain("Sources/AAAAA…/AddressBook-v22.abcddb");
  });

  it("stays true when a sync has never run — the live half does not depend on the funnel", async () => {
    makeBook("AddressBook-v22.abcddb");
    makeBook("Sources/0CA70C1F-1234-5678-9ABC-DEF012345678/AddressBook-v22.abcddb");

    const block = await compose();

    expect(block).toContain("address books on disk: 2");
    expect(block).toContain("no contacts read recorded since app start");
  });

  it("says n/a rather than 0 on a platform with no .abcddb stores", async () => {
    const diag = await collectContactsDiagnostics({
      homeDir: home,
      platform: "win32",
      fullDiskAccess: "unknown",
      uptimeSeconds: 10,
    });
    const block = formatContactsDiagnostics(diag).join("\n");

    expect(diag.live.address_books_on_disk).toBeNull();
    expect(block).toContain("address books on disk: n/a (macOS-only store)");
    expect(block).not.toMatch(/address books on disk: 0/);
  });

  it("reports FDA=n/a on Windows, never a granted permission that has no meaning", async () => {
    // Full Disk Access is a macOS concept. `FDA=granted` on a Windows ticket is
    // a confidently wrong line, and a human triages from this block.
    const diag = await collectContactsDiagnostics({
      homeDir: home,
      platform: "win32",
      // The caller passes "granted" and the collector must override it anyway,
      // so a stale or mis-plumbed value cannot reach a Windows ticket.
      fullDiskAccess: "granted",
      uptimeSeconds: 10,
    });
    const block = formatContactsDiagnostics(diag).join("\n");

    expect(diag.live.full_disk_access).toBe("n/a");
    expect(block).toContain("FDA=n/a");
    expect(block).not.toContain("FDA=granted");
  });

  it("still reports a real FDA state on macOS", async () => {
    makeBook("AddressBook-v22.abcddb");
    const diag = await collectContactsDiagnostics({
      homeDir: home,
      platform: "darwin",
      fullDiskAccess: "denied",
      uptimeSeconds: 10,
    });

    expect(diag.live.full_disk_access).toBe("denied");
    expect(formatContactsDiagnostics(diag).join("\n")).toContain("FDA=denied");
  });

  it("reports a genuinely empty AddressBook directory as 0, which is a true zero", async () => {
    fs.mkdirSync(path.join(home, BASE_REL), { recursive: true });

    const block = await compose();

    // This IS a legitimate zero: the directory exists, we listed it, nothing
    // is there. It is only "0" as a stand-in for "we never looked" that lies.
    expect(block).toContain("address books on disk: 0");
  });
});

// ============================================
// 2. THE ZERO TRAP
// ============================================

describe("the zero trap: never-run must not render as zero", () => {
  it("emits no numeric count anywhere in the recorded half when nothing was recorded", async () => {
    makeBook("AddressBook-v22.abcddb");

    const block = await compose();
    const recorded = block
      .split("\n")
      .filter((l) => l.includes("[sync"))
      .join("\n");

    expect(recorded).toContain("no contacts read recorded since app start");
    expect(recorded).toContain("uptime 42s");
    expect(recorded).toContain("NOT a count of zero");

    // The load-bearing assertion. Any bare number in the recorded half of a
    // never-synced machine is the original bug, rebuilt one level up.
    // (`42s` is the uptime, which is a true live fact, so it is stripped first.)
    const withoutUptime = recorded.replace(/uptime \d+s/g, "uptime <n>s");
    expect(withoutUptime).not.toMatch(/\d/);
  });

  it("distinguishes never-read from read-and-found-nothing", async () => {
    makeBook("AddressBook-v22.abcddb");

    const neverRead = await compose();

    // Now record a real read that legitimately found nothing.
    recordDiscovery(discoveryStage({ found: 1, readCount: 1, failedCount: 0 }));
    recordParse(parseStage({ rowsRead: 0, usable: 0 }));
    const readEmpty = await compose();

    expect(neverRead).toContain("no contacts read recorded since app start");
    expect(readEmpty).not.toContain("no contacts read recorded since app start");
    expect(readEmpty).toContain("read 1 of 1");
    expect(readEmpty).toContain("parsed 0 rows from 1 book(s) -> usable 0");
  });
});

// ============================================
// 3. FAILED / PARTIAL READS
// ============================================

describe("failed and partial reads are distinguishable from empty ones", () => {
  it("renders read 1 of 3 with the failure count and per-book remedy", async () => {
    makeBook("AddressBook-v22.abcddb");
    makeBook("Sources/0CA70C1F-1111-1111-1111-111111111111/AddressBook-v22.abcddb");
    makeBook("Sources/BBBBBBBB-2222-2222-2222-222222222222/AddressBook-v22.abcddb");

    recordDiscovery({
      found: 3,
      readCount: 1,
      failedCount: 2,
      usedFallback: false,
      candidates: [
        { path: "AddressBook-v22.abcddb", recordCount: 3, read: true },
        {
          path: "Sources/0CA70…/AddressBook-v22.abcddb",
          recordCount: null,
          read: false,
          skipReason: "read-error",
        },
        {
          path: "Sources/BBBBB…/AddressBook-v22.abcddb",
          recordCount: null,
          read: false,
          skipReason: "load-error",
        },
      ],
    });

    const block = await compose();

    // The line that diagnoses the whole reported bug at a glance.
    expect(block).toContain("address books on disk: 3");
    expect(block).toContain("read 1 of 3 (failed 2)");
    // The two failure modes name DIFFERENT remedies.
    expect(block).toContain("could not open — check Full Disk Access");
    expect(block).toContain("opened, then failed mid-read — store may be corrupt");
  });

  it("a total read failure reports 0 of 3 with the reason, never a bare 0", async () => {
    makeBook("AddressBook-v22.abcddb");
    makeBook("Sources/0CA70C1F-1111-1111-1111-111111111111/AddressBook-v22.abcddb");
    makeBook("Sources/BBBBBBBB-2222-2222-2222-222222222222/AddressBook-v22.abcddb");

    recordDiscovery({
      found: 3,
      readCount: 0,
      failedCount: 3,
      usedFallback: false,
      candidates: [1, 2, 3].map((i) => ({
        path: `book-${i}.abcddb`,
        recordCount: null,
        read: false,
        skipReason: "read-error" as const,
      })),
    });

    const block = await compose();

    expect(block).toContain("read 0 of 3 (failed 3)");
    expect(block).toContain("check Full Disk Access");
    // "0 contacts" must not be inferable: the count of books on disk is right
    // there on the line above, and every failure carries a reason.
    expect(block).toContain("address books on disk: 3");
  });
});

// ============================================
// 4. STALENESS — every recorded value carries its timestamp
// ============================================

describe("staleness: recorded values carry a timestamp and an age", () => {
  it("labels each recorded stage with its own timestamp and relative age", async () => {
    makeBook("AddressBook-v22.abcddb");

    const now = Date.parse("2026-07-31T14:02:00.000Z");
    const AT = "2026-07-28T14:02:00.000Z";

    // The stage timestamps are set explicitly rather than by moving the system
    // clock. Fake timers are process-wide state that outlives the assertion,
    // and what is under test here is how the FORMATTER renders an age — not
    // how `record*` stamps one (the end-to-end suite covers that).
    const diag = await collectContactsDiagnostics({
      homeDir: home,
      platform: "darwin",
      fullDiskAccess: "granted",
      uptimeSeconds: 42,
    });
    diag.recorded = {
      discovery: { ...discoveryStage({ found: 1, readCount: 1, failedCount: 0 }), at: AT },
      parse: { ...parseStage({ rowsRead: 716, usable: 704 }), at: AT },
      shadowSync: { ...shadowStage(), at: AT },
      picker: { ...pickerStage(), at: AT },
    };
    const block = formatContactsDiagnostics(diag, now).join("\n");

    // Three days stale, and it says so — this is the thing whose absence sent
    // the investigation down the wrong path twice.
    expect(block).toContain("2026-07-28T14:02:00.000Z");
    expect(block).toContain("(3d ago)");

    // EVERY recorded group carries one, not just the first.
    const recordedLines = block.split("\n").filter((l) => /parsed|shadow|picker/.test(l));
    expect(recordedLines.length).toBeGreaterThanOrEqual(3);
    for (const line of recordedLines) {
      if (/^\s+of usable:/.test(line)) continue;
      expect(line).toMatch(/2026-07-28T14:02:00\.000Z/);
    }
  });

  it("formatRecordedAt renders minutes, hours and days", () => {
    const base = Date.parse("2026-07-31T12:00:00.000Z");
    expect(formatRecordedAt("2026-07-31T11:59:30.000Z", base)).toContain("just now");
    expect(formatRecordedAt("2026-07-31T11:30:00.000Z", base)).toContain("30m ago");
    expect(formatRecordedAt("2026-07-31T07:00:00.000Z", base)).toContain("5h ago");
    expect(formatRecordedAt("2026-07-28T12:00:00.000Z", base)).toContain("3d ago");
    expect(formatRecordedAt("not-a-date", base)).toContain("age unknown");
  });
});

// ============================================
// 5. PII — asserted on the composed string
// ============================================

describe("PII: the composed section carries none", () => {
  it("contains no account name, absolute path, contact name, phone or email", async () => {
    makeBook("AddressBook-v22.abcddb");
    makeBook("Sources/0CA70C1F-1234-5678-9ABC-DEF012345678/AddressBook-v22.abcddb");

    recordDiscovery(discoveryStage({ found: 2, readCount: 2, failedCount: 0 }));
    recordParse(parseStage({ rowsRead: 1128, usable: 1116 }));
    recordShadowSync(shadowStage());
    recordPicker(pickerStage());

    const diag = await collectContactsDiagnostics({
      homeDir: home,
      platform: "darwin",
      fullDiskAccess: "granted",
      uptimeSeconds: 42,
    });

    // Flatten and serialise EVERYTHING, not just the rendered lines: a recent
    // PR shipped absolute paths because only one level was asserted on and the
    // paths were hiding inside a metadata object.
    const rendered = formatContactsDiagnostics(diag).join("\n");
    const serialized = JSON.stringify(diag);
    const everything = `${rendered}\n${serialized}`;

    expect(everything).not.toContain(ACCOUNT);
    expect(everything).not.toContain(home);
    expect(everything).not.toContain(tmpRoot);
    expect(everything).not.toMatch(/\/Users\//);
    // No email addresses, and no phone number in any shape this app produces.
    // These are deliberately SPECIFIC: a greedy "digits and punctuation"
    // pattern matches an ISO timestamp and a run of counts, so it can never
    // fail and would be an assertion in name only.
    expect(everything).not.toMatch(/[\w.+-]+@[\w.-]+\.\w{2,}/);
    expect(everything).not.toMatch(/\+\d{10,}/); // E.164, e.g. +14155550123
    expect(everything).not.toMatch(/\(\d{3}\)\s*\d{3}-\d{4}/); // (415) 555-0123
    expect(everything).not.toMatch(/\b\d{3}-\d{3}-\d{4}\b/); // 415-555-0123
    // A bare run of 9+ digits. Nothing legitimate here reaches that length —
    // the longest real value is a 5-digit count and a timestamp's longest run
    // is 4 — so this fires on a raw number pasted into any field.
    expect(everything).not.toMatch(/\d{9,}/);
    // The full UUID of an account directory is unlinkable, not printed whole.
    expect(everything).not.toContain("0CA70C1F-1234-5678-9ABC-DEF012345678");
  });
});

// ============================================
// FIXTURE BUILDERS
// ============================================

function discoveryStage(over: Partial<DiscoveryStage>): DiscoveryStage {
  return {
    found: 1,
    readCount: 1,
    failedCount: 0,
    usedFallback: false,
    candidates: [{ path: "AddressBook-v22.abcddb", recordCount: 3, read: true }],
    ...over,
  };
}

function parseStage(over: Partial<ParseStage>): ParseStage {
  return {
    books: 1,
    rowsRead: 0,
    nonPersonRows: 0,
    missingUniqueId: 0,
    phoneRows: 0,
    emailRows: 0,
    droppedRows: 0,
    nameless: 0,
    usable: 0,
    withPhone: 0,
    emailOnly: 0,
    neither: 0,
    labelFromContact: 0,
    unlabelled: 0,
    ...over,
  };
}

function shadowStage(): ShadowSyncStage {
  return {
    source: "macos",
    inserted: 4,
    updated: 12,
    unchanged: 1100,
    deleted: 0,
    total: 1116,
  };
}

function pickerStage(): PickerStage {
  return {
    dbRowsIn: 0,
    externalRowsIn: 1116,
    rowsIn: 1116,
    sourceDisabled: 0,
    alreadyImported: 105,
    duplicateSuppressed: 336,
    shown: 675,
  };
}
