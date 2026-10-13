/**
 * @jest-environment node
 *
 * BACKLOG-3925 MEASUREMENT PROBE — not a gate. Skipped unless KEEPR_PERF_3925=1.
 *
 * The address-only Needs Review pass (queueAddressMatchesForTransaction) on an encrypted
 * file database built from the REAL schema.sql, at 20k and 60k cached emails (~4 KB
 * plain bodies, every one inside the deal's window). For three deals — a short number
 * with a common name word, a long number, and a one-digit number — it prints:
 *   candidates  rows the SQL prefilter returned
 *   SQL alone   the candidate statement run directly on the main thread
 *   pass        wall time of the pass
 *   max block   the longest gap of a setInterval(2 ms) timer during the pass = the longest
 *               main-thread block (monitorEventLoopDelay misses a block at its first
 *               sample, so it is not used)
 *   2nd pass    the same pass again on the unchanged deal
 *
 * KEEPR_PERF_3925_POOL=1 starts the real contact query worker pool first (the shipped
 * configuration); without it the pass reads on the main thread (pool not up).
 * KEEPR_PERF_3925_SIZES=20000,60000 (default) picks the store sizes.
 * KEEPR_PERF_3925_NAMES=0 keeps the street-name words out of the filler text.
 *
 * Run (Electron's node, real driver):
 *   KEEPR_PERF_3925=1 KEEPR_PERF_3925_POOL=1 ELECTRON_RUN_AS_NODE=1 npx electron \
 *     ./node_modules/jest/bin/jest.js --bail=0 --testTimeout=1800000 \
 *     electron/__tests__/perf/addressMatchPass.probe-3925.test.ts
 * Addresses are .test, ids invented (public repo).
 */
import * as nodePath from "path";
import * as nodeFs from "fs";
import * as os from "os";
import type { Database as DatabaseType } from "better-sqlite3";

jest.mock("electron", () => ({
  app: { isPackaged: false, getPath: jest.fn(() => "/tmp/keepr-3925-probe"), getVersion: () => "0.0.0" },
  ipcMain: { handle: jest.fn(), on: jest.fn() },
  BrowserWindow: { getAllWindows: () => [] },
  shell: {},
}));
jest.mock("@sentry/electron/main", () => ({
  addBreadcrumb: jest.fn(),
  captureException: jest.fn(),
  captureMessage: jest.fn(),
  setUser: jest.fn(),
}));
jest.mock("../../services/logService", () => {
  const m = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
  for (const f of Object.values(m)) f.mockResolvedValue(undefined);
  return { __esModule: true, default: m, logService: m };
});

const DRIVER = nodePath.join(__dirname, "..", "..", "..", "node_modules", "better-sqlite3-multiple-ciphers");
const PERF = process.env.KEEPR_PERF_3925 === "1";
const WITH_POOL = process.env.KEEPR_PERF_3925_POOL === "1";
const SIZES = (process.env.KEEPR_PERF_3925_SIZES || "20000,60000").split(",").map((s) => Number(s.trim()));
function loadDriver(): (new (file: string) => DatabaseType) | null {
  if (!PERF) return null;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require(DRIVER);
  } catch {
    return null;
  }
}
const Database = loadDriver();
const maybe = Database ? describe : describe.skip;

const USER = "39250000-0000-4000-8000-000000000001"; // pii-allow-uuid: invented, not from any live row
const KEY_HEX = "3925".repeat(16);
const DEALS: Array<[string, string]> = [
  ["d-park", "12 Park Rd, Springfield"],
  ["d-maple", "1428 Maple Ave, Springfield"],
  ["d-oak", "7 Oak St, Springfield"],
];

const FILLER = [
  "Thanks for the update on the inspection, I will call you at 12 tomorrow.",
  "The buyers want 7 days for the appraisal and the lender needs 30 more.",
  "We offered $7,000 over asking and they countered at 12,500 above list.",
  "Please sign pages 3 through 12 and return them by Friday at 4.",
  // KEEPR_PERF_3925_NAMES=0: no street-name word in the filler, so the name-word
  // prefilter can narrow the candidates (default: every body contains "park" and "oak").
  process.env.KEEPR_PERF_3925_NAMES === "0"
    ? "The garden near the school is lovely and the elm trees are 100 years old."
    : "The park near the school is lovely and the oak trees are 100 years old.",
  "Escrow opens on the 14th, earnest money of 2% is due within 3 business days.",
  "Here is the HOA packet, 47 pages, plus the CC&Rs and the 2025 budget.",
  "Our title officer is out until the 21st; her backup can help with item 7.",
];

/** A ~4 KB body; some mention a deal address, most only numbers and common words. */
function bodyFor(i: number): string {
  const parts: string[] = [];
  let len = 0;
  let k = i;
  while (len < 4000) {
    const s = FILLER[k % FILLER.length];
    parts.push(s);
    len += s.length + 1;
    k = (k * 31 + 7) % 1_000_003;
  }
  if (i % 50 === 0) parts.splice(3, 0, "Showing at 12 Park Rd went well.");
  if (i % 200 === 0) parts.splice(5, 0, "Re the unit at 1428 Maple Ave #4, see attached.");
  if (i % 40 === 0) parts.splice(2, 0, "Oak St 7 had two offers.");
  return parts.join(" ");
}

maybe("BACKLOG-3925 address pass on the main thread (probe)", () => {
  for (const size of SIZES) {
    describe(`${size} emails`, () => {
      let dir: string;
      let dbPath: string;
      let db: DatabaseType;

      beforeAll(async () => {
        jest.resetModules();
        dir = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), "keepr-3925-probe-"));
        dbPath = nodePath.join(dir, "mad.db");
        db = new (Database as NonNullable<typeof Database>)(dbPath);
        db.pragma(`key = "x'${KEY_HEX}'"`);
        db.pragma("cipher_compatibility = 4");
        db.pragma("journal_mode = WAL");
        db.pragma("foreign_keys = ON");
        db.exec(nodeFs.readFileSync(nodePath.join(__dirname, "../../database/schema.sql"), "utf8"));
        db.prepare(
          "INSERT INTO users_local (id, email, oauth_provider, oauth_id) VALUES (?, 'owner@example.test', 'google', 'o-3925')",
        ).run(USER);
        const insE = db.prepare(
          `INSERT INTO emails (id, user_id, external_id, source, thread_id, sender, recipients, subject, body_plain, sent_at)
           VALUES (?, ?, ?, 'gmail', ?, ?, 'owner@example.test', ?, ?, ?)`,
        );
        const insP = db.prepare(
          "INSERT INTO email_participants (email_id, role, position, participant_hash, email_address) VALUES (?, ?, 0, ?, ?)",
        );
        const t0 = Date.now();
        db.transaction(() => {
          for (let i = 0; i < size; i++) {
            const from = `sender${i % 900}@example.test`;
            const sent = new Date(Date.UTC(2026, 0, 2) + (i % 250) * 86_400_000).toISOString();
            insE.run(`e${i}`, USER, `gm-${i}`, `gt-${i % 5000}`, from, `Update ${i % 97}`, bodyFor(i), sent);
            insP.run(`e${i}`, "from", `h-f-${i}`, from);
            insP.run(`e${i}`, "to", `h-t-${i}`, "owner@example.test");
          }
        })();
        for (const [id, address] of DEALS) {
          db.prepare(
            `INSERT INTO transactions (id, user_id, property_address, status, started_at, created_at, submission_status)
             VALUES (?, ?, ?, 'active', '2026-01-01', '2026-01-01', 'not_submitted')`,
          ).run(id, USER, address);
        }
        const mb = Math.round(nodeFs.statSync(dbPath).size / 1e6);
        process.stderr.write(`[3925 probe] seeded ${size} emails (${mb} MB) in ${Date.now() - t0} ms\n`);
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        require("../../services/db/core/dbConnection").setDb(db);
        if (WITH_POOL) await startWorkerPool(dir, dbPath);
      }, 1_800_000);

      afterAll(() => {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        require("../../workers/contactWorkerPool").shutdownPool();
        db?.close();
        nodeFs.rmSync(dir, { recursive: true, force: true });
      });

      it(`passes for ${DEALS.length} deals (pool ${WITH_POOL ? "UP" : "down"})`, async () => {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const svc = require("../../services/reviewStateService");
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const sqlMod = require("../../services/db/addressMatchCandidatesDb");
        for (const [id] of DEALS) {
          const sqlAlone = timeSqlAlone(db, sqlMod, id);
          const first = await blockDuring(() => svc.queueAddressMatchesForTransaction(id));
          const second = await blockDuring(() => svc.queueAddressMatchesForTransaction(id));
          const r1 = first.value as { candidates: number; matched: number; queued: number };
          const r2 = second.value as { queued: number };
          process.stderr.write(
            `[3925 probe] ${size} | ${id} | candidates ${r1.candidates} | SQL alone ${sqlAlone} ms | pass ${first.ms} ms | ` +
              `max block ${first.maxGap} ms | queued ${r1.queued} | 2nd pass ${second.ms} ms, max block ${second.maxGap} ms, queued ${r2.queued}\n`,
          );
        }
      });
    });
  }
});

/** The candidate statement run directly on the main thread, with the pass's own parameters. */
function timeSqlAlone(
  db: DatabaseType,
  sqlMod: { ADDRESS_MATCH_CANDIDATE_EMAILS_SQL: unknown },
  txnId: string,
): number {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const svc = require("../../services/reviewStateService");
  // Before this probe's PR the statement took the number only (9 parameters).
  const legacy = (): unknown[] => {
    const num = (DEALS.find(([id]) => id === txnId)?.[1] ?? "").split(" ")[0];
    return [USER, "2026-01-01T00:00:00.000Z", "2099-01-01T00:00:00.000Z", num, num, txnId, txnId, txnId, txnId];
  };
  const params: unknown[] =
    typeof svc.addressMatchCandidateParamsForTests === "function" ? svc.addressMatchCandidateParamsForTests(txnId) : legacy();
  const t0 = Date.now();
  db.prepare(String(sqlMod.ADDRESS_MATCH_CANDIDATE_EMAILS_SQL)).all(...params);
  return Date.now() - t0;
}

async function blockDuring<T>(work: () => Promise<T>): Promise<{ value: T; ms: number; maxGap: number }> {
  let last = Date.now();
  let maxGap = 0;
  const timer = setInterval(() => {
    const now = Date.now();
    maxGap = Math.max(maxGap, now - last);
    last = now;
  }, 2);
  await new Promise((r) => setTimeout(r, 20));
  last = Date.now();
  maxGap = 0;
  const t0 = Date.now();
  const value = await work();
  const ms = Date.now() - t0;
  await new Promise((r) => setTimeout(r, 10));
  clearInterval(timer);
  return { value, ms, maxGap };
}

async function startWorkerPool(dir: string, dbPath: string): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { build } = require("esbuild");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const pool = require("../../workers/contactWorkerPool");
  const workerScript = nodePath.join(dir, "contactQueryWorker.js");
  await build({
    entryPoints: [nodePath.join(__dirname, "..", "..", "workers", "contactQueryWorker.ts")],
    bundle: true,
    platform: "node",
    format: "cjs",
    outfile: workerScript,
    plugins: [
      {
        name: "driver-from-repo",
        setup(b: { onResolve: (o: { filter: RegExp }, cb: () => { path: string; external: boolean }) => void }) {
          b.onResolve({ filter: /^better-sqlite3-multiple-ciphers$/ }, () => ({ path: DRIVER, external: true }));
        },
      },
    ],
    logLevel: "silent",
  });
  pool.setContactWorkerPathForTests(workerScript);
  await pool.initializePool(dbPath, KEY_HEX);
  expect(pool.isPoolReady()).toBe(true);
}
