/**
 * @jest-environment node
 */

/**
 * BACKLOG-4040 S1 timing probe (skipped unless KEEPR_PERF_4040=1). The shared
 * file clean-up against 65,000 attachment rows, with 2,409 and 20,000
 * unreferenced 200 KB candidates on the real file system. Times the name lookup
 * and the unlinks separately, and the longest synchronous block. Values are
 * invented.
 *
 *   KEEPR_PERF_4040=1 ELECTRON_RUN_AS_NODE=1 npx electron ./node_modules/jest/bin/jest.js --bail=0 <this file>
 */

import * as nodePath from "path";
import * as fs from "fs";
import * as os from "os";
import type { Database as DatabaseType } from "better-sqlite3";

jest.mock("../../services/logService", () => {
  const noop = jest.fn().mockResolvedValue(undefined);
  return { __esModule: true, default: { info: noop, warn: noop, error: noop, debug: noop } };
});

// eslint-disable-next-line @typescript-eslint/no-require-imports
const Database = require(
  nodePath.join(__dirname, "..", "..", "..", "node_modules", "better-sqlite3-multiple-ciphers"),
) as typeof import("better-sqlite3-multiple-ciphers");

import { containedIn, removeUnreferencedFiles } from "../../services/attachmentFileRefs";
import { unreferencedAttachmentPaths } from "../../services/db/attachmentFileRefsSql";
import { SCOPE_MESSAGE_ATTACHMENTS } from "../../services/atRest/markers";

const SCHEMA = nodePath.join(__dirname, "..", "..", "database", "schema.sql");
const ROWS = 65_000;
const FILE_BYTES = 200 * 1024;
const run = process.env.KEEPR_PERF_4040 === "1" ? describe : describe.skip;
const hash = (n: number): string => n.toString(16).padStart(64, "0");

run("BACKLOG-4040 file clean-up cost", () => {
  jest.setTimeout(600_000);
  let db: DatabaseType;
  let tmp: string;
  let msgDir: string;

  beforeAll(() => {
    tmp = fs.mkdtempSync(nodePath.join(os.tmpdir(), "keepr-4040p-"));
    msgDir = nodePath.join(tmp, "message-attachments");
    fs.mkdirSync(msgDir);
    db = new Database(":memory:") as unknown as DatabaseType;
    db.pragma("foreign_keys = OFF");
    db.exec(fs.readFileSync(SCHEMA, "utf8"));
    const insert = db.prepare("INSERT INTO attachments (id, message_id, filename, storage_path) VALUES (?, 'm', 'f', ?)");
    db.transaction(() => {
      for (let n = 0; n < ROWS; n++) insert.run(`r-${n}`, nodePath.join(msgDir, `${hash(1_000_000 + n)}.jpg`));
    })();
  });
  afterAll(() => {
    db.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it.each([2_409, 20_000])("%d unreferenced 200 KB candidates", async (count) => {
    const bytes = Buffer.alloc(FILE_BYTES, 7);
    const candidates: string[] = [];
    for (let n = 0; n < count; n++) {
      const p = nodePath.join(msgDir, `${hash(9_000_000 + count * 10 + n)}.heic`);
      fs.writeFileSync(p, bytes);
      candidates.push(p);
    }
    let longest = 0;
    let blockStart = 0;
    const realNow = () => performance.now();
    const r = await removeUnreferencedFiles(candidates, {
      contain: containedIn(tmp, [SCOPE_MESSAGE_ATTACHMENTS]),
      unreferenced: (ps) => {
        blockStart = realNow();
        return unreferencedAttachmentPaths(db, ps);
      },
      deleteFile: (p) => {
        fs.unlinkSync(p);
        longest = Math.max(longest, realNow() - blockStart);
        return true;
      },
    });
    process.stdout.write(
      `[4040 perf] rows=${ROWS} candidates=${count} lookupMs=${r.lookupMs.toFixed(1)} unlinkMs=${r.unlinkMs.toFixed(1)} ` +
        `blocks=${r.blocks} longestBlockMs=${longest.toFixed(1)} removed=${r.removed}\n`,
    );
    expect(r.removed).toBe(count);
    expect(longest).toBeLessThan(400);
  });
});
