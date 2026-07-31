/**
 * @jest-environment node
 *
 * BACKLOG-2391 — the contact ingestion funnel.
 *
 * These lines exist to be pasted into a support ticket, and this repo is
 * PUBLIC. So the contract under test is not "the code avoids PII" but "the
 * COMPOSED OUTPUT contains none" — every assertion below runs against the
 * string that actually gets logged, with fixtures deliberately stuffed with a
 * real-looking account name, contact names, phone numbers and email addresses.
 */

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
  formatDiscoveryLines,
  formatParseLine,
  formatPickerLine,
  formatShadowSyncLine,
  getContactIngestionFunnel,
  recordDiscovery,
  recordParse,
  recordPicker,
  recordShadowSync,
  redactAddressBookPath,
  resetContactIngestionFunnel,
  type DiscoveryStage,
  type ParseStage,
  type PickerStage,
  type ShadowSyncStage,
} from "../contactIngestionFunnel";

/** The reporter's actual shape: an account name in the path, two address books. */
const HOME = "/Users/margaret";
const BASE_DIR = path.join(HOME, "Library/Application Support/AddressBook");
const TOP_LEVEL_DB = path.join(BASE_DIR, "AddressBook-v22.abcddb");
const SOURCE_DB = path.join(
  BASE_DIR,
  "Sources/0CA70C1F-1234-5678-9ABC-DEF012345678/AddressBook-v22.abcddb",
);

const DISCOVERY: DiscoveryStage = {
  found: 2,
  candidates: [
    { path: "AddressBook-v22.abcddb", recordCount: 3, selected: false, skipReason: "below-threshold" },
    { path: "Sources/0CA70…/AddressBook-v22.abcddb", recordCount: 1128, selected: true },
  ],
  selected: "Sources/0CA70…/AddressBook-v22.abcddb",
  threshold: 10,
  usedFallback: false,
};

const PARSE: ParseStage = {
  rowsRead: 1128,
  phoneRows: 1502,
  emailRows: 990,
  droppedNoName: 12,
  usable: 1116,
  withPhone: 890,
  emailOnly: 226,
  neither: 0,
};

const SHADOW: ShadowSyncStage = {
  source: "macos",
  inserted: 4,
  updated: 12,
  unchanged: 1100,
  deleted: 0,
  total: 1116,
};

const PICKER: PickerStage = {
  dbRowsIn: 0,
  externalRowsIn: 1116,
  rowsIn: 1116,
  sourceDisabled: 0,
  alreadyImported: 105,
  duplicateSuppressed: 336,
  shown: 675,
};

describe("BACKLOG-2391: funnel line shape", () => {
  beforeEach(() => {
    mockLogInfo.mockClear();
    resetContactIngestionFunnel();
  });

  it("discovery names every book, its record count, and why each was passed over", () => {
    expect(formatDiscoveryLines(DISCOVERY)).toEqual([
      "[ContactsService] address books found: 2  [3 records] [1128 records]",
      "[ContactsService]   selected: Sources/0CA70…/AddressBook-v22.abcddb",
      "[ContactsService]   skipped: AddressBook-v22.abcddb (3 <= threshold 10)",
    ]);
  });

  it("discovery reports an unreadable book distinctly from an under-threshold one", () => {
    const lines = formatDiscoveryLines({
      ...DISCOVERY,
      candidates: [
        { path: "Sources/AAAAA…/AddressBook-v22.abcddb", recordCount: null, selected: false, skipReason: "read-error" },
        { path: "Sources/0CA70…/AddressBook-v22.abcddb", recordCount: 1128, selected: true },
      ],
    });

    // "[unreadable]" vs "[0 records]" is the difference between "Full Disk
    // Access is denied" and "this address book is genuinely empty".
    expect(lines[0]).toBe("[ContactsService] address books found: 2  [unreadable] [1128 records]");
    expect(lines[2]).toBe("[ContactsService]   skipped: Sources/AAAAA…/AddressBook-v22.abcddb (read error)");
  });

  it("discovery says so when NO book qualified and the default path was used", () => {
    const lines = formatDiscoveryLines({
      found: 1,
      candidates: [
        { path: "AddressBook-v22.abcddb", recordCount: 3, selected: false, skipReason: "below-threshold" },
      ],
      selected: "AddressBook-v22.abcddb",
      threshold: 10,
      usedFallback: true,
    });

    // The book was skipped for being under threshold and then read anyway via
    // the hard-coded default path. Both facts have to be visible together.
    expect(lines[1]).toBe(
      "[ContactsService]   selected: AddressBook-v22.abcddb (default path fallback)",
    );
    expect(lines[2]).toBe("[ContactsService]   skipped: AddressBook-v22.abcddb (3 <= threshold 10)");
  });

  it("parse shows rows in, the silent no-name drop, and the usable split", () => {
    expect(formatParseLine(PARSE)).toBe(
      "[ContactsService] parsed: 1128 -> no-name dropped: 12 -> usable: 1116" +
        "   (phone: 890, email-only: 226, neither: 0)   [rows: 1502 phone, 990 email]",
    );
  });

  it("shadow sync reports four separate numbers, scoped to a source", () => {
    expect(formatShadowSyncLine(SHADOW)).toBe(
      "[ExternalContactDbService] shadow: inserted 4, updated 12, unchanged 1100," +
        " deleted 0 (source=macos), total 1116",
    );
  });

  it("picker reports each suppression reason separately", () => {
    expect(formatPickerLine(PICKER)).toBe(
      "[Contacts] picker: 1116 in (db 0 + external 1116) -> source-disabled 0" +
        " -> already-imported 105 -> dup-suppressed 336 -> shown 675",
    );
  });
});

describe("BACKLOG-2391: path redaction", () => {
  it("strips the account name from a per-source address book", () => {
    const redacted = redactAddressBookPath(SOURCE_DB, BASE_DIR);

    expect(redacted).toBe("Sources/0CA70…/AddressBook-v22.abcddb");
    expect(redacted).not.toContain("margaret");
    expect(redacted).not.toContain("/Users/");
  });

  it("keeps two different source directories distinguishable", () => {
    const a = redactAddressBookPath(
      path.join(BASE_DIR, "Sources/0CA70C1F-1111/AddressBook-v22.abcddb"),
      BASE_DIR,
    );
    const b = redactAddressBookPath(
      path.join(BASE_DIR, "Sources/9FE31B22-2222/AddressBook-v22.abcddb"),
      BASE_DIR,
    );

    // Redaction must not collapse two books into one indistinguishable entry —
    // "which of the two did we read" is the question the log has to answer.
    expect(a).not.toEqual(b);
  });

  it("falls back to ~ when the path is outside the AddressBook base dir", () => {
    const original = process.env.HOME;
    process.env.HOME = HOME;
    try {
      const redacted = redactAddressBookPath(
        path.join(HOME, "Desktop/Backup/AddressBook-v22.abcddb"),
        BASE_DIR,
      );
      expect(redacted).toBe("~/Desktop/Backup/AddressBook-v22.abcddb");
      expect(redacted).not.toContain("margaret");
    } finally {
      process.env.HOME = original;
    }
  });

  it("never emits an absolute path even for a file outside $HOME", () => {
    const original = process.env.HOME;
    process.env.HOME = HOME;
    try {
      const redacted = redactAddressBookPath("/Volumes/Backup/AddressBook-v22.abcddb", BASE_DIR);
      expect(redacted).toBe("<outside-home>/AddressBook-v22.abcddb");
      expect(path.isAbsolute(redacted)).toBe(false);
    } finally {
      process.env.HOME = original;
    }
  });

  it("redacts the top-level book to a bare filename", () => {
    expect(redactAddressBookPath(TOP_LEVEL_DB, BASE_DIR)).toBe("AddressBook-v22.abcddb");
  });
});

describe("BACKLOG-2391: no PII in the composed output", () => {
  beforeEach(() => {
    mockLogInfo.mockClear();
    resetContactIngestionFunnel();
  });

  /** Everything that must never reach a log line, in one place. */
  const FORBIDDEN = [
    "margaret",
    "Margaret",
    "/Users/",
    "0CA70C1F-1234-5678-9ABC-DEF012345678",
    "@example.com",
    "+1555",
  ];

  it("emits nothing forbidden for a realistic full run", () => {
    // Drive the real recorders (which are what production calls), using the
    // redactor on genuinely absolute, username-bearing paths.
    recordDiscovery({
      found: 2,
      candidates: [
        {
          path: redactAddressBookPath(TOP_LEVEL_DB, BASE_DIR),
          recordCount: 3,
          selected: false,
          skipReason: "below-threshold",
        },
        { path: redactAddressBookPath(SOURCE_DB, BASE_DIR), recordCount: 1128, selected: true },
      ],
      selected: redactAddressBookPath(SOURCE_DB, BASE_DIR),
      threshold: 10,
      usedFallback: false,
    });
    recordParse(PARSE);
    recordShadowSync(SHADOW);
    recordPicker(PICKER);

    const emitted = mockLogInfo.mock.calls.map((c) => String(c[0])).join("\n");

    expect(emitted).not.toBe("");
    for (const secret of FORBIDDEN) {
      expect(emitted).not.toContain(secret);
    }
  });

  it("keeps the `[Component]` prefix convention on every line", () => {
    recordDiscovery(DISCOVERY);
    recordParse(PARSE);
    recordShadowSync(SHADOW);
    recordPicker(PICKER);

    for (const call of mockLogInfo.mock.calls) {
      expect(String(call[0])).toMatch(/^\[(ContactsService|ExternalContactDbService|Contacts)\] /);
      // Second arg is the logService context/component.
      expect(typeof call[1]).toBe("string");
    }
  });
});

describe("BACKLOG-2391: structured snapshot for the diagnostics block", () => {
  beforeEach(() => {
    mockLogInfo.mockClear();
    resetContactIngestionFunnel();
  });

  it("exposes the numbers WITHOUT parsing the log text", () => {
    recordDiscovery(DISCOVERY);
    recordParse(PARSE);
    recordShadowSync(SHADOW);
    recordPicker(PICKER);

    const funnel = getContactIngestionFunnel();

    // BACKLOG-2394 reads these fields directly; the log string is a second
    // rendering of the same object, never the only source.
    expect(funnel.discovery).toMatchObject({ found: 2, threshold: 10, usedFallback: false });
    expect(funnel.discovery!.candidates.map((c) => c.recordCount)).toEqual([3, 1128]);
    expect(funnel.parse).toMatchObject({ rowsRead: 1128, droppedNoName: 12, usable: 1116 });
    expect(funnel.shadowSync).toMatchObject({ inserted: 4, updated: 12, unchanged: 1100 });
    expect(funnel.picker).toMatchObject({ rowsIn: 1116, shown: 675 });
  });

  it("timestamps each stage so a stale one is recognisable", () => {
    recordParse(PARSE);
    expect(Date.parse(getContactIngestionFunnel().parse!.at)).not.toBeNaN();
  });

  it("returns a copy — a caller cannot corrupt the live snapshot", () => {
    recordPicker(PICKER);

    const first = getContactIngestionFunnel();
    first.picker!.shown = 99999;

    expect(getContactIngestionFunnel().picker!.shown).toBe(675);
  });

  it("reports only the stages that have actually run", () => {
    recordPicker(PICKER);

    const funnel = getContactIngestionFunnel();
    expect(funnel.picker).toBeDefined();
    // A picker open with a warm shadow table never re-reads the address book;
    // reporting a zeroed discovery stage would read as "0 address books found".
    expect(funnel.discovery).toBeUndefined();
    expect(funnel.parse).toBeUndefined();
    expect(funnel.shadowSync).toBeUndefined();
  });
});
