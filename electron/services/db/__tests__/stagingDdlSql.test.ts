/**
 * Pins for `db/stagingDdlSql` — BACKLOG-2989 commit A.
 *
 * The DDL transforms themselves are already covered by the BACKLOG-2790 suites,
 * which were re-run against this module (16/16) and are the control for having
 * touched BACKLOG-2990's file. What those suites do NOT cover is what commit A
 * adds: the anchored staging-name check, the branded type, and the fact that
 * two byte-identical `tableDdl` bodies collapsed into one without either
 * caller losing its error wording.
 */

import fs from "fs";
import os from "os";
import path from "path";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const RealDatabase = require(
  path.join(__dirname, "..", "..", "..", "..", "node_modules", "better-sqlite3-multiple-ciphers"),
) as typeof import("better-sqlite3-multiple-ciphers");

import {
  STAGING_PREFIX,
  checkedStagingTable,
  deriveStagingIndexDdl,
  deriveStagingTableDdl,
  emailTableDdl,
  messageTableDdl,
  tableDdl,
} from "../stagingDdlSql";

let tmpRoot: string;
let db: InstanceType<typeof RealDatabase>;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "keepr-2989-staging-"));
  db = new RealDatabase(path.join(tmpRoot, "t.db"));
});

afterEach(() => {
  db.close();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe("checkedStagingTable — anchored at both ends", () => {
  // Real names, generated the way the two services generate them: the prefix
  // plus 12 hex characters from randomUUID plus a suffix.
  const emailName = `${STAGING_PREFIX["email-recache"]}deadbeefcafe_emails`;
  const messageName = `${STAGING_PREFIX["message-import"]}0123456789ab_messages`;

  it("accepts a name each service actually generates", () => {
    expect(checkedStagingTable(emailName, "email-recache")).toBe(emailName);
    expect(checkedStagingTable(messageName, "message-import")).toBe(messageName);
  });

  it("rejects a prefix attack — the reason the pattern is anchored at the START", () => {
    // Unanchored, this would pass and then be spliced straight into DDL.
    expect(() =>
      checkedStagingTable(`x ${emailName}`, "email-recache"),
    ).toThrow(/anchored/);
    expect(() =>
      checkedStagingTable(`"; DROP TABLE emails; -- ${emailName}`, "email-recache"),
    ).toThrow(/anchored/);
  });

  it("rejects a suffix attack — the reason it is anchored at the END", () => {
    expect(() =>
      checkedStagingTable(`${emailName}"; DROP TABLE emails; --`, "email-recache"),
    ).toThrow(/anchored/);
    expect(() =>
      checkedStagingTable(`${emailName} UNION SELECT * FROM users_local`, "email-recache"),
    ).toThrow(/anchored/);
  });

  it("rejects the LIVE table names, which are never staging tables", () => {
    expect(() => checkedStagingTable("emails", "email-recache")).toThrow(/anchored/);
    expect(() => checkedStagingTable("messages", "message-import")).toThrow(/anchored/);
  });

  it("rejects a name from the OTHER family", () => {
    // The two prefixes must not be interchangeable: `sweepStaleStaging` drops
    // every table under its own prefix unscoped, so a cross-family name would
    // let one service's sweep destroy the other's in-flight rebuild.
    expect(() => checkedStagingTable(emailName, "message-import")).toThrow(/anchored/);
    expect(() => checkedStagingTable(messageName, "email-recache")).toThrow(/anchored/);
  });

  it("rejects a token of the wrong length or alphabet", () => {
    expect(() =>
      checkedStagingTable(`${STAGING_PREFIX["email-recache"]}deadbeef_emails`, "email-recache"),
    ).toThrow(/anchored/);
    expect(() =>
      checkedStagingTable(`${STAGING_PREFIX["email-recache"]}NOTHEXNOTHEX_emails`, "email-recache"),
    ).toThrow(/anchored/);
  });
});

describe("tableDdl — one copy, both callers keep their wording", () => {
  it("returns the stored CREATE TABLE for a live table", () => {
    db.exec("CREATE TABLE emails (id TEXT PRIMARY KEY, subject TEXT)");
    expect(tableDdl(db as never, "emails", "email-recache")).toContain("CREATE TABLE emails");
  });

  it("names the operation the CALLER is performing, not a generic one", () => {
    // The two functions this replaced were byte-identical apart from these two
    // words. Parameterising `kind` is what let them collapse into one copy
    // without either caller's error becoming less specific.
    expect(() => emailTableDdl(db as never, "nope")).toThrow(
      /Cannot stage a force re-cache: table "nope" does not exist/,
    );
    expect(() => messageTableDdl(db as never, "nope")).toThrow(
      /Cannot stage a force re-import: table "nope" does not exist/,
    );
  });

  it("takes the table as a BOUND PARAMETER, so a hostile name cannot execute", () => {
    db.exec("CREATE TABLE emails (id TEXT PRIMARY KEY)");
    // The statement is a constant inside db/; only the NAME is bound. A name
    // that would be catastrophic spliced into SQL is simply not found here.
    expect(() =>
      emailTableDdl(db as never, `emails"; DROP TABLE emails; --`),
    ).toThrow(/does not exist/);
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'emails'").get()).toEqual({
      name: "emails",
    });
  });
});

describe("the brand is load-bearing, not decorative", () => {
  /**
   * These assertions are for the COMPILER, and they are the point of the brand.
   *
   * An earlier revision of this module exported `checkedStagingTable` and the
   * `StagingTableName` type, and then had both `derive*` functions take plain
   * `string`. Everything type-checked, every runtime test passed, and
   * `deriveStagingTableDdl(ddl, "emails", '; DROP TABLE emails --')` was still
   * a legal call. The mechanism existed; the door it was built for was open.
   *
   * `@ts-expect-error` FAILS THE BUILD IF THE ERROR STOPS HAPPENING, so these
   * lines are a real control: delete the brand from either signature and
   * `npm run type-check:tests` goes red. That is what makes the compiler-facing
   * half testable rather than merely asserted.
   */
  const LIVE_DDL = "CREATE TABLE emails (id TEXT PRIMARY KEY)";
  const checked = checkedStagingTable(
    `${STAGING_PREFIX["email-recache"]}deadbeefcafe_emails`,
    "email-recache",
  );

  it("refuses a raw string where a checked staging table is required", () => {
    // @ts-expect-error a hostile raw string is not a StagingTableName
    expect(() => deriveStagingTableDdl(LIVE_DDL, "emails", '; DROP TABLE emails --')).toBeDefined();

    // @ts-expect-error even a well-formed name is refused until it is checked
    expect(() => deriveStagingTableDdl(LIVE_DDL, "emails", "staging_emailrecache_deadbeefcafe_emails")).toBeDefined();

    // @ts-expect-error the index name is spliced into DDL too, so it is branded as well
    expect(() => deriveStagingIndexDdl("CREATE INDEX i ON emails (id)", "i", "emails", checked, "i_staging")).toBeDefined();
  });

  it("accepts the checked form, so the brand is satisfiable and not just obstructive", () => {
    expect(deriveStagingTableDdl(LIVE_DDL, "emails", checked)).toContain(checked);
  });
});
