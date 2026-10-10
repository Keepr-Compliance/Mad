/**
 * @jest-environment node
 *
 * BACKLOG-3837: first-run link pass over PC-scale data (KEEPR_3837_LINKS, default 1186 contacts).
 * Real encrypted WAL database from schema.sql; run under Electron (see wizardContinueOffMain-3837).
 */
import * as nodePath from "path";
import * as nodeFs from "fs";
import * as os from "os";

jest.mock("electron", () => ({ app: { getPath: jest.fn().mockReturnValue("/tmp/keepr-3837"), isPackaged: true } }));
jest.mock("electron-log", () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock("@sentry/electron/main", () => ({ addBreadcrumb: jest.fn(), captureException: jest.fn() }));
jest.mock("../logService", () => {
  const m = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
  return { __esModule: true, default: m, logService: m };
});

import { setDb } from "../db/core/dbConnection";
import { linkExternalContactsForUser } from "../contactSourceLinker";
import { runUniqueNameAutoLink } from "../contactNameAutoLink";

const DRIVER = nodePath.join(__dirname, "..", "..", "..", "node_modules", "better-sqlite3-multiple-ciphers");
const KEY_HEX = "3837".repeat(16);
const USER = "u-links";
const N = Number(process.env.KEEPR_3837_LINKS ?? 1186);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let Database: any = null;
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  Database = require(DRIVER);
  new Database(":memory:").close();
} catch {
  Database = null;
}

(Database ? describe : describe.skip)("BACKLOG-3837 link pass at PC scale", () => {
  it("first pass creating one link per contact; steady-state second pass", () => {
    const dir = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), "keepr-3837-links-"));
    const db = new Database(nodePath.join(dir, "mad.db"));
    db.pragma(`key = "x'${KEY_HEX}'"`);
    db.pragma("cipher_compatibility = 4");
    db.pragma("journal_mode = WAL");
    db.exec(nodeFs.readFileSync(nodePath.join(__dirname, "..", "..", "database", "schema.sql"), "utf8"));
    db.prepare("INSERT INTO users_local (id, email, oauth_provider, oauth_id) VALUES (?, ?, 'google', ?)").run(USER, "l@example.test", "o-l");
    db.transaction(() => {
      for (let i = 0; i < N; i++) {
        const email = `person${i}@example.test`;
        db.prepare("INSERT INTO contacts (id, user_id, display_name, is_imported, source) VALUES (?, ?, ?, 1, 'contacts_app')").run(`c${i}`, USER, `Person ${i} Name${i}`);
        db.prepare("INSERT INTO contact_emails (id, contact_id, email, is_primary, source) VALUES (?, ?, ?, 1, 'import')").run(`e${i}`, `c${i}`, email);
        db.prepare("INSERT INTO external_contacts (id, user_id, name, phones_json, emails_json, external_record_id, source, external_uuid) VALUES (?, ?, ?, '[]', ?, ?, 'macos', ?)").run(
          `x${i}`, USER, `Person ${i} Name${i}`, JSON.stringify([email]), `rec${i}`, `uuid${i}`);
      }
    })();
    setDb(db);
    // Count autocommit statements: writes issued outside any transaction.
    let autocommitWrites = 0;
    const realPrepare = db.prepare.bind(db);
    db.prepare = (s: string) => {
      const st = realPrepare(s);
      if (/^\s*(INSERT|UPDATE|DELETE)/i.test(s)) {
        const run = st.run.bind(st);
        st.run = (...a: unknown[]) => {
          if (!db.inTransaction) autocommitWrites++;
          return run(...a);
        };
      }
      return st;
    };
    const pass = (): { ms: number; linked: number } => {
      const t = Date.now();
      const s = linkExternalContactsForUser(USER);
      const ns = runUniqueNameAutoLink(USER);
      return { ms: Date.now() - t, linked: s.idMatched + s.contentMatched + ns.autoLinked };
    };
    const first = pass();
    const w1 = autocommitWrites;
    const second = pass();
    const link = db.prepare("SELECT COUNT(*) n FROM contact_source_links").get() as { n: number };
    process.stderr.write(
      `[3837-links] contacts=${N} first: ${first.ms}ms linked=${first.linked} autocommitWrites=${w1} | second: ${second.ms}ms | links rows=${link.n}\n`,
    );
    expect(link.n).toBe(N);
    expect(first.linked).toBe(N);
    // Batched: no link write is its own transaction (was one per link before 3837).
    expect(w1).toBe(0);
    db.close();
    nodeFs.rmSync(dir, { recursive: true, force: true });
  }, 600_000);
});
