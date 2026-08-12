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
  formatLinkLine,
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
  type LinkStage,
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

// BACKLOG-2392: the reporter has THREE accounts. Every readable one is read;
// there is no selection and no threshold.
const DISCOVERY: DiscoveryStage = {
  found: 2,
  candidates: [
    { path: "AddressBook-v22.abcddb", recordCount: 3, read: true },
    { path: "Sources/0CA70…/AddressBook-v22.abcddb", recordCount: 1128, read: true },
  ],
  readCount: 2,
  failedCount: 0,
  usedFallback: false,
};

const PARSE: ParseStage = {
  books: 2,
  rowsRead: 1128,
  nonPersonRows: 5,
  missingUniqueId: 0,
  phoneRows: 1502,
  emailRows: 990,
  droppedRows: 0,
  nameless: 18,
  usable: 1128,
  withPhone: 890,
  emailOnly: 226,
  neither: 12,
  labelFromContact: 18,
  unlabelled: 0,
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

  it("discovery names every book it read, with that book's record count", () => {
    expect(formatDiscoveryLines(DISCOVERY)).toEqual([
      "[ContactsService] address books found: 2, read: 2, failed: 0",
      "[ContactsService]   read: AddressBook-v22.abcddb (3 records)",
      "[ContactsService]   read: Sources/0CA70…/AddressBook-v22.abcddb (1128 records)",
    ]);
  });

  it("makes 'read 1 of 2' impossible to mistake for a clean run", () => {
    // BACKLOG-2392: this is the entire reason readCount/failedCount exist. A
    // partially-ingested address book must never render like a full one.
    const lines = formatDiscoveryLines({
      found: 2,
      candidates: [
        { path: "Sources/AAAAA…/AddressBook-v22.abcddb", recordCount: null, read: false, skipReason: "read-error" },
        { path: "Sources/0CA70…/AddressBook-v22.abcddb", recordCount: 1128, read: true },
      ],
      readCount: 1,
      failedCount: 1,
      usedFallback: false,
    });

    expect(lines[0]).toBe("[ContactsService] address books found: 2, read: 1, failed: 1");
  });

  it("names the REMEDY for each failure: permissions vs corruption", () => {
    // "could not open" and "opened, then died" send the user to different
    // fixes. A single generic 'read error' would send half of them to the
    // wrong one.
    const lines = formatDiscoveryLines({
      found: 2,
      candidates: [
        { path: "Sources/AAAAA…/AddressBook-v22.abcddb", recordCount: null, read: false, skipReason: "read-error" },
        { path: "Sources/BBBBB…/AddressBook-v22.abcddb", recordCount: null, read: false, skipReason: "load-error" },
      ],
      readCount: 0,
      failedCount: 2,
      usedFallback: false,
    });

    expect(lines[1]).toBe(
      "[ContactsService]   FAILED: Sources/AAAAA…/AddressBook-v22.abcddb (could not open — check Full Disk Access)",
    );
    expect(lines[2]).toBe(
      "[ContactsService]   FAILED: Sources/BBBBB…/AddressBook-v22.abcddb (opened, then failed mid-read — store may be corrupt)",
    );
  });

  it("discovery says so when the walk found nothing and the default path was used", () => {
    const lines = formatDiscoveryLines({
      found: 1,
      candidates: [{ path: "AddressBook-v22.abcddb", recordCount: 3, read: true }],
      readCount: 1,
      failedCount: 0,
      usedFallback: true,
    });

    expect(lines[0]).toBe(
      "[ContactsService] address books found: 1, read: 1, failed: 0 (default path fallback)",
    );
    // A 3-record book is READ now. Under the old >10 threshold this exact book
    // was discarded, which is how the "On My Mac" account went missing.
    expect(lines[1]).toBe("[ContactsService]   read: AddressBook-v22.abcddb (3 records)");
  });

  it("parse shows rows in, the excluded rows, and the usable split", () => {
    expect(formatParseLine(PARSE)).toBe(
      "[ContactsService] parsed: 1128 rows from 2 book(s) -> dropped: 0 -> usable: 1128" +
        "   [nameless: 18]" +
        "   (phone: 890, email-only: 226, neither: 12)" +
        "   [labelled from contact: 18, unlabelled: 0]" +
        "   [rows: 1502 phone, 990 email; excluded: 5 non-person, 0 no-uid]",
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
        { path: redactAddressBookPath(TOP_LEVEL_DB, BASE_DIR), recordCount: 3, read: true },
        { path: redactAddressBookPath(SOURCE_DB, BASE_DIR), recordCount: 1128, read: true },
      ],
      readCount: 2,
      failedCount: 0,
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
    expect(funnel.discovery).toMatchObject({
      found: 2,
      readCount: 2,
      failedCount: 0,
      usedFallback: false,
    });
    expect(funnel.discovery!.candidates.map((c) => c.recordCount)).toEqual([3, 1128]);
    expect(funnel.parse).toMatchObject({ books: 2, rowsRead: 1128, droppedRows: 0, usable: 1128 });
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

/**
 * BACKLOG-2410 — the `declined` counter on the link stage.
 *
 * A decline is a content match REFUSED because the user already answered
 * "different people" about that pair. It is counted apart from `unmatched`
 * because the two need opposite responses from whoever reads the line: a high
 * `unmatched` means new people, a high `declined` means the user has been
 * rejecting suggestions.
 */
describe("formatLinkLine — declined (BACKLOG-2410)", () => {
  const base: LinkStage = {
    recordsIn: 1116,
    idMatched: 1102,
    contentMatched: 12,
    flagged: 1,
    unmatched: 1,
  };

  it("renders declined when present, in the arithmetic order", () => {
    expect(formatLinkLine({ ...base, recordsIn: 1118, declined: 2 })).toBe(
      "[Contacts] links: 1118 records -> id-matched 1102 -> content-matched 12" +
        " -> flagged 1 -> declined 2 -> unmatched 1",
    );
  });

  /**
   * ZERO IS NOT NOTHING. A pass that ran and declined nothing must be
   * distinguishable from a snapshot that predates the counter — the same
   * "nothing found vs never looked" rule this whole epic is built on.
   *
   * NEGATIVE CONTROL RUN: changed the guard from `=== undefined` to a falsy
   * check (`stage.declined ? ... : ""`). Observed: 1 failed / 2 passed — this
   * test, with `declined 0` missing from the line.
   */
  it("renders `declined 0` rather than omitting it", () => {
    expect(formatLinkLine({ ...base, declined: 0 })).toContain("-> declined 0 ->");
  });

  it("omits declined entirely when the field is absent", () => {
    expect(formatLinkLine(base)).toBe(
      "[Contacts] links: 1116 records -> id-matched 1102 -> content-matched 12" +
        " -> flagged 1 -> unmatched 1",
    );
    expect(formatLinkLine(base)).not.toContain("declined");
  });

  it("closes the arithmetic: id + content + flagged + declined + unmatched = recordsIn", () => {
    const stage: LinkStage = {
      recordsIn: 10,
      idMatched: 4,
      contentMatched: 2,
      flagged: 1,
      declined: 2,
      unmatched: 1,
    };
    expect(
      stage.idMatched + stage.contentMatched + stage.flagged + (stage.declined ?? 0) + stage.unmatched,
    ).toBe(stage.recordsIn);
    expect(formatLinkLine(stage)).toBe(
      "[Contacts] links: 10 records -> id-matched 4 -> content-matched 2" +
        " -> flagged 1 -> declined 2 -> unmatched 1",
    );
  });
});
