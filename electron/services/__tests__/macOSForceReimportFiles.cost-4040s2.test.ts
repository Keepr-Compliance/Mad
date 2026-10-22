/**
 * @jest-environment node
 *
 * BACKLOG-4040 S2 — cost of the post-swap file cleanup on a large history.
 *
 * The real schema (electron/database/schema.sql), the real swap
 * (`swapStagingIntoLive`) and the real cleanup (`removeFilesLeftByForceSwap`),
 * real files in a temp userData. Population: 65,000 attachment rows (the
 * large-history size the S1 cost probe used) of which 2,409 belong to this
 * user's Mac texts (the founder's Force Re-import count); half of those files
 * are shared with an iPhone row (relative, upper-case extension).
 *
 * "Import message text only" ON: staging holds no attachment rows, so every
 * Mac-only file is a candidate. Asserted: the swap reads the deleted paths in
 * ONE statement; the cleanup reads the names once per block (S1's chunking),
 * never once per file; exactly the Mac-only files go. Measured ms are logged;
 * the hard timing gate stays in S1's opt-in perf probe (Windows runners).
 */

import * as os from "os";
import * as fs from "fs";
import * as nodePath from "path";
import * as crypto from "crypto";
// eslint-disable-next-line @typescript-eslint/no-require-imports
const Database = require(
  nodePath.join(__dirname, "..", "..", "..", "node_modules", "better-sqlite3-multiple-ciphers"),
) as typeof import("better-sqlite3-multiple-ciphers");
import type { Database as DatabaseType } from "better-sqlite3";

import { forceStagingLifecycle, swapStagingIntoLive } from "../macOSMessagesImportService/forceStaging";
import { removeFilesLeftByForceSwap } from "../macOSMessagesImportService/forceFileCleanup";

const ROWS = 65_000;
const MAC = 2_409;
const USER = "user-4040s2-cost";
const hash = (n: number) => crypto.createHash("sha256").update(`4040s2-${n}`).digest("hex");

let db: DatabaseType;
let userData: string;
let msgDir: string;

beforeAll(() => {
  userData = fs.mkdtempSync(nodePath.join(os.tmpdir(), "keepr-4040s2-cost-"));
  msgDir = nodePath.join(userData, "message-attachments");
  fs.mkdirSync(msgDir);
  db = new Database(":memory:");
  db.pragma("foreign_keys = OFF");
  db.exec(fs.readFileSync(nodePath.join(__dirname, "..", "..", "database", "schema.sql"), "utf8"));
});

afterAll(() => {
  db?.close();
  fs.rmSync(userData, { recursive: true, force: true });
});

it(`${ROWS} rows, ${MAC} Mac texts, text only: one read of the deleted paths, one read of the names per block`, async () => {
  const msg = db.prepare(
    "INSERT INTO messages (id, user_id, channel, external_id, body_text, metadata) VALUES (?, ?, 'imessage', ?, 'x', ?)",
  );
  const att = db.prepare(
    "INSERT INTO attachments (id, message_id, external_message_id, filename, storage_path) VALUES (?, ?, ?, 'f', ?)",
  );
  const mac = JSON.stringify({ source: "macos_messages" });
  const iphone = JSON.stringify({ source: "iphone_sync" });
  const body = Buffer.alloc(4096, 7);
  db.transaction(() => {
    for (let n = 0; n < MAC; n++) {
      const p = nodePath.join(msgDir, `${hash(n)}.jpg`);
      fs.writeFileSync(p, body);
      msg.run(`mac-${n}`, USER, `mac-guid-${n}`, mac);
      att.run(`mac-att-${n}`, `mac-${n}`, `mac-guid-${n}`, p);
      if (n % 2 === 0) {
        // Shared: an iPhone row for the same bytes, relative + upper-case.
        msg.run(`iph-${n}`, USER, `iph-guid-${n}`, iphone);
        att.run(`iph-att-${n}`, `iph-${n}`, `iph-guid-${n}`, `message-attachments/${hash(n)}.JPG`);
      }
    }
    // The rest of the history: other sources' rows (files not needed: never candidates).
    const shared = Math.ceil(MAC / 2);
    for (let n = 0; n < ROWS - MAC - shared; n++) {
      msg.run(`hist-${n}`, USER, `hist-guid-${n}`, iphone);
      att.run(`hist-att-${n}`, `hist-${n}`, `hist-guid-${n}`, nodePath.join(msgDir, `${hash(1_000_000 + n)}.heic`));
    }
  })();
  expect((db.prepare("SELECT COUNT(*) c FROM attachments").get() as { c: number }).c).toBe(ROWS);

  // Text only: the rebuild staged the messages but no attachment rows.
  const staging = forceStagingLifecycle.create(db, USER);
  const cols = (db.prepare("PRAGMA table_info(messages)").all() as Array<{ name: string }>).map((c) => `"${c.name}"`).join(", ");
  db.exec(`INSERT INTO "${staging.messagesTable}" (${cols}) SELECT ${cols} FROM messages WHERE id LIKE 'mac-%'`);
  db.exec(`UPDATE "${staging.messagesTable}" SET id = 'new-' || id`);

  let statementRuns = 0;
  const realPrepare = db.prepare.bind(db);
  const spy = jest.spyOn(db, "prepare").mockImplementation(((q: string) => {
    const st = realPrepare(q);
    if (/SELECT storage_path FROM attachments/.test(q)) {
      for (const m of ["get", "all", "iterate"] as const) {
        const fn = (st as unknown as Record<string, (...a: unknown[]) => unknown>)[m].bind(st);
        (st as unknown as Record<string, unknown>)[m] = (...a: unknown[]) => (statementRuns++, fn(...a));
      }
    }
    return st;
  }) as typeof db.prepare);

  const t0 = performance.now();
  const counts = swapStagingIntoLive(db, staging);
  const swapMs = performance.now() - t0;
  const swapReads = statementRuns;
  staging.drop();
  statementRuns = 0;

  const r = await removeFilesLeftByForceSwap(db, counts.removedStoragePaths, userData);
  spy.mockRestore();

  process.stdout.write(
    `[4040 S2 cost] rows=${ROWS} mac=${MAC} candidates=${counts.removedStoragePaths.length} swapMs=${swapMs.toFixed(1)} ` +
      `lookupMs=${r.lookupMs.toFixed(1)} maxLookupMs=${r.maxLookupMs.toFixed(1)} longestBlockMs=${r.longestBlockMs.toFixed(1)} ` +
      `unlinkMs=${r.unlinkMs.toFixed(1)} blocks=${r.blocks} nameReads=${statementRuns} removed=${r.removed} kept=${r.stillReferenced}\n`,
  );

  expect(counts.attachmentsDeleted).toBe(MAC);
  expect(counts.removedStoragePaths).toHaveLength(MAC);
  expect(swapReads).toBe(1);
  expect(r.removed).toBe(Math.floor(MAC / 2));
  expect(r.stillReferenced).toBe(Math.ceil(MAC / 2));
  expect(r.blocks).toBeGreaterThanOrEqual(1);
  expect(statementRuns).toBe(r.blocks);
  expect(fs.readdirSync(msgDir)).toHaveLength(Math.ceil(MAC / 2));
}, 120_000);
