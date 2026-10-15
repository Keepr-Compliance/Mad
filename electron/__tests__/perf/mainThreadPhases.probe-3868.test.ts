/**
 * @jest-environment node
 *
 * BACKLOG-3868 MEASUREMENT PROBE — not a gate. Skipped unless KEEPR_PERF_3868=1.
 *
 * Builds a store the size of the founder's PC (671,105 text messages, 1,186 iPhone
 * contacts) from the REAL schema.sql, then times on the main thread, with the
 * event-loop stall printed for each:
 *   post-sync: existing-id dedupe read, iPhone contacts upsert (1,186), auto-link of new
 *              messages, the attached-thread expansion (pre-3868 full index vs targeted /
 *              incremental / skipped);
 *   create:    createAuditedTransaction for contacts holding 108 chats + 22 emails,
 *              under a CPU profile whose top self-time frames are printed (file:line).
 *
 * Run (Electron's node, real driver):
 *   KEEPR_PERF_3868=1 ELECTRON_RUN_AS_NODE=1 npx electron ./node_modules/jest/bin/jest.js \
 *     --bail=0 --testTimeout=900000 electron/__tests__/perf/mainThreadPhases.probe-3868.test.ts
 * Handles are reserved 555-01xx numbers and .test addresses (public repo).
 */
import * as nodePath from "path";
import * as nodeFs from "fs";
import * as os from "os";
import * as inspector from "inspector";
import { monitorEventLoopDelay } from "perf_hooks";
import type { Database as DatabaseType } from "better-sqlite3";

jest.mock("electron", () => ({
  app: { isPackaged: false, getPath: jest.fn(() => "/tmp/keepr-3868-probe"), getVersion: () => "0.0.0" },
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
const PERF = process.env.KEEPR_PERF_3868 === "1";
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

const USER = "38680000-0000-4000-8000-000000000001"; // pii-allow-uuid: invented, not from any live row
const KEY_HEX = "3868".repeat(16);
const USER_LOGIN = "+19995550100";
const TOTAL = 671_105;
const THREADS = 4_000;
const CHATS_PER_CONTACT = 27; // 4 contacts x 27 chat ids = 108 chats (macOS multi chat id)
const CREATE_CONTACTS = 4;

function phoneOf(t: number): string {
  // reserved 555-01xx, area code varies per hundred threads
  return `+1${200 + Math.floor(t / 100)}5550${String(100 + (t % 100)).padStart(3, "0")}`;
}

async function stall<T>(label: string, work: () => Promise<T> | T): Promise<T> {
  const h = monitorEventLoopDelay({ resolution: 10 });
  h.enable();
  await new Promise((r) => setTimeout(r, 20));
  const t0 = Date.now();
  const value = await work();
  const ms = Date.now() - t0;
  await new Promise((r) => setTimeout(r, 20));
  h.disable();
  process.stderr.write(`[3868 probe] ${label}: ${ms} ms wall, max event-loop stall ${Math.round(h.max / 1e6)} ms\n`);
  return value;
}

async function profile<T>(label: string, work: () => Promise<T>): Promise<T> {
  const session = new inspector.Session();
  session.connect();
  const post = (m: string, p?: object) =>
    new Promise<unknown>((res, rej) => session.post(m, p ?? {}, (e, r) => (e ? rej(e) : res(r))));
  await post("Profiler.enable");
  await post("Profiler.setSamplingInterval", { interval: 500 });
  await post("Profiler.start");
  const value = await stall(label, work);
  const { profile: prof } = (await post("Profiler.stop")) as {
    profile: {
      nodes: Array<{
        id: number;
        callFrame: { functionName: string; url: string; lineNumber: number };
        children?: number[];
      }>;
      samples: number[];
      timeDeltas: number[];
    };
  };
  session.disconnect();
  const selfUs = new Map<number, number>();
  prof.samples.forEach((id, i) => selfUs.set(id, (selfUs.get(id) ?? 0) + (prof.timeDeltas[i] ?? 0)));
  // Native frames (a statement's all/run) are charged to the nearest repo frame that
  // called them, so the line printed is the one that issued the SQL.
  const parent = new Map<number, number>();
  for (const n of prof.nodes) for (const c of n.children ?? []) parent.set(c, n.id);
  const byId = new Map(prof.nodes.map((n) => [n.id, n]));
  const isRepo = (id: number) => /Mad-3868\/electron\//.test(byId.get(id)?.callFrame.url ?? "") && !/dbTiming|wrappers|dbConnection/.test(byId.get(id)?.callFrame.url ?? "");
  const byFrame = new Map<string, number>();
  for (const n of prof.nodes) {
    const us = selfUs.get(n.id) ?? 0;
    if (!us) continue;
    let id: number | undefined = n.id;
    while (id !== undefined && !isRepo(id)) id = parent.get(id);
    const f = id !== undefined ? byId.get(id)!.callFrame : n.callFrame;
    const url = f.url.replace(/^.*\/Mad-3868\//, "");
    const key = `${f.functionName || "(anon)"} ${url}:${f.lineNumber + 1}`;
    byFrame.set(key, (byFrame.get(key) ?? 0) + us);
  }
  const top = [...byFrame.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12);
  process.stderr.write(`[3868 probe] ${label} top self time:\n`);
  for (const [k, us] of top) process.stderr.write(`    ${Math.round(us / 1000)} ms  ${k}\n`);
  return value;
}

maybe("BACKLOG-3868 main-thread phases on a 671k-message store (probe)", () => {
  let dir: string;
  let dbPath: string;
  let db: DatabaseType;

  beforeAll(async () => {
    dir = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), "keepr-3868-probe-"));
    dbPath = nodePath.join(dir, "mad.db");
    db = new (Database as NonNullable<typeof Database>)(dbPath);
    // encrypted like production, so the real contact query worker can open it
    db.pragma(`key = "x'${KEY_HEX}'"`);
    db.pragma("cipher_compatibility = 4");
    db.pragma("journal_mode = WAL");
    db.exec(nodeFs.readFileSync(nodePath.join(__dirname, "../../database/schema.sql"), "utf8"));
    db.prepare("INSERT INTO users_local (id, email, oauth_provider, oauth_id) VALUES (?, 'owner@example.test', 'google', 'o-3868')").run(USER);
    const ins = db.prepare(
      `INSERT INTO messages (id, user_id, external_id, channel, direction, body_text, participants, participants_flat, thread_id, sent_at, message_type)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'text')`,
    );
    const t0 = Date.now();
    db.transaction(() => {
      for (let i = 0; i < TOTAL; i++) {
        const t = i % THREADS;
        // threads 0..107 belong to the 4 create contacts (27 chat ids each)
        const phone = t < CREATE_CONTACTS * CHATS_PER_CONTACT ? phoneOf(Math.floor(t / CHATS_PER_CONTACT)) : phoneOf(t);
        const inbound = i % 2 === 0;
        const participants = JSON.stringify({ from: inbound ? phone : USER_LOGIN, to: [inbound ? USER_LOGIN : phone] });
        const day = new Date(Date.UTC(2019, 0, 1) + (i % 2000) * 86400000).toISOString();
        ins.run(
          `m${i}`,
          USER,
          `guid-${i}`,
          i % 3 ? "imessage" : "sms",
          inbound ? "inbound" : "outbound",
          `message body ${i} with some ordinary words about the closing and the inspection`,
          participants,
          `${phone.replace(/\D/g, "")},${USER_LOGIN.replace(/\D/g, "")}`,
          `macos-chat-${t}`,
          day,
        );
      }
    })();
    // the create contacts: phones of threads 0..107 and 22 emails among them
    for (let c = 0; c < CREATE_CONTACTS; c++) {
      const cid = `c-${c}`;
      db.prepare("INSERT INTO contacts (id, user_id, display_name, source) VALUES (?, ?, ?, 'manual')").run(cid, USER, `Party ${c}`);
      db.prepare("INSERT INTO contact_phones (id, contact_id, phone_e164, phone_normalized) VALUES (?, ?, ?, ?)").run(
        `cp-${c}`,
        cid,
        phoneOf(c),
        phoneOf(c).replace(/\D/g, ""),
      );
      db.prepare("INSERT INTO contact_emails (id, contact_id, email, is_primary) VALUES (?, ?, ?, 1)").run(`ce-${c}`, cid, `party${c}@example.test`);
    }
    const insE = db.prepare(
      `INSERT INTO emails (id, user_id, external_id, source, thread_id, sender, recipients, subject, body_plain, sent_at)
       VALUES (?, ?, ?, 'gmail', ?, ?, 'owner@example.test', 'Re: 1420 Marlin Court', 'see attached', ?)`,
    );
    for (let e = 0; e < 22; e++) {
      insE.run(`e-${e}`, USER, `gm-${e}`, `gt-${e}`, `party${e % CREATE_CONTACTS}@example.test`, `2024-0${1 + (e % 9)}-1${e % 9}T10:00:00Z`);
    }
    process.stderr.write(`[3868 probe] seeded ${TOTAL} messages in ${Date.now() - t0} ms\n`);
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { setDb } = require("../../services/db/core/dbConnection");
    setDb(db);
  }, 900_000);

  afterAll(() => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    require("../../workers/contactWorkerPool").shutdownPool();
    db?.close();
    nodeFs.rmSync(dir, { recursive: true, force: true });
  });

  async function startWorkerPool(): Promise<void> {
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

  let syncRound = 0;
  /** What runs on the main process after a sync stores `n` new texts (syncHandlers.ts:690-720). */
  async function postSync(tag: string, n: number): Promise<void> {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const syncDb = require("../../services/db/syncDbService");
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const externalContactDb = require("../../services/db/externalContactDbService");
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const autoLink = require("../../services/autoLinkService");
    syncRound++;
    await stall(`${tag} storeMessages dedupe read getExistingMessageExternalIds (671k ids)`, () => syncDb.getExistingMessageExternalIds(USER).size);
    const insNew = db.prepare(
      `INSERT INTO messages (id, user_id, external_id, channel, direction, body_text, participants, participants_flat, thread_id, sent_at, message_type)
       VALUES (?, ?, ?, 'imessage', 'inbound', 'new', ?, ?, ?, '2026-10-08', 'text')`,
    );
    await stall(`${tag} storeMessages insert ${n}`, () => {
      db.transaction(() => {
        for (let i = 0; i < n; i++) {
          const t = (i * 97 + syncRound) % THREADS;
          insNew.run(`new-${syncRound}-${i}`, USER, `new-guid-${syncRound}-${i}`, JSON.stringify({ from: phoneOf(t), to: [USER_LOGIN] }), phoneOf(t).replace(/\D/g, ""), `macos-chat-${t}`);
        }
      })();
    });
    const contacts = Array.from({ length: 1186 }, (_, i) => ({
      name: `Contact ${i}`,
      phones: [phoneOf(i % THREADS)],
      emails: [`contact${i}@example.test`],
      recordId: String(i + 1),
    }));
    await stall(`${tag} storeContacts upsertFromiPhone (1,186)`, () => externalContactDb.upsertFromiPhone(USER, contacts, `s-${syncRound}`));
    await profile(`${tag} autoLinkNewMessagesForUser`, () => autoLink.autoLinkNewMessagesForUser(USER));
    const exp = await profile<{ mode?: string; messageRowsRead: number; messagesLinked: number }>(`${tag} expandAttachedThreadsForUser`, () => autoLink.expandAttachedThreadsForUser(USER));
    process.stderr.write(`[3868 probe] ${tag} expansion mode=${exp.mode} rowsRead=${exp.messageRowsRead} linked=${exp.messagesLinked}\n`);
  }

  async function createDeal(tag: string, address: string): Promise<string> {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const transactionService = require("../../services/transactionService").default;
    const created = await profile<{ id: string }>(`${tag} createAuditedTransaction (4 contacts holding 108 chats; 22 emails)`, () =>
      transactionService.createAuditedTransaction(USER, {
        property_address: address,
        transaction_type: "purchase",
        started_at: "2019-01-01T00:00:00Z",
        contact_assignments: Array.from({ length: CREATE_CONTACTS }, (_, c) => ({
          contact_id: `c-${c}`,
          role: "buyer",
          role_category: "client",
          is_primary: c === 0,
        })),
      }),
    );
    const linked = db.prepare("SELECT COUNT(*) AS n FROM communications WHERE transaction_id = ?").get(created.id) as { n: number };
    process.stderr.write(`[3868 probe] ${tag} create linked ${linked.n} communication rows\n`);
    return created.id as string;
  }

  function attachPairs(txn: string): void {
    // 5 attached pairs (per-message manual links), as on the PC
    for (const t of [500, 501, 502, 503, 504]) {
      const mid = `m${t + (txn.length % 7) * 4000}`;
      db.prepare("UPDATE messages SET transaction_id = ? WHERE id = ?").run(txn, mid);
      db.prepare(
        "INSERT INTO communications (id, user_id, transaction_id, message_id, link_source, link_confidence) VALUES (?, ?, ?, ?, 'manual', 1)",
      ).run(`cm-${txn}-${t}`, USER, txn, mid);
    }
  }

  it("BEFORE 3868 (no worker, full-index expansion): create, then a sync", async () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const autoLink = require("../../services/autoLinkService");
    const txn = await createDeal("BEFORE", "1420 Marlin Court");
    attachPairs(txn);
    autoLink.setFullIndexOracleForTests(true);
    try {
      await postSync("BEFORE", 37);
    } finally {
      autoLink.setFullIndexOracleForTests(false);
    }
  });

  it("AFTER 3868 (contact query worker up): create, then two syncs and an idle trigger", async () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const autoLink = require("../../services/autoLinkService");
    await startWorkerPool();
    autoLink.resetExpansionWatermarksForTests();
    const txn = await createDeal("AFTER", "1421 Marlin Court");
    attachPairs(txn);
    await postSync("AFTER sync 1 (first expansion of the session: targeted)", 37);
    await postSync("AFTER sync 2 (incremental)", 37);
    const idle = await stall("AFTER re-trigger, nothing new (skipped)", () => autoLink.expandAttachedThreadsForUser(USER));
    process.stderr.write(`[3868 probe] AFTER idle expansion mode=${idle.mode} rowsRead=${idle.messageRowsRead}\n`);
    expect(idle.messageRowsRead).toBe(0);
  });
});
