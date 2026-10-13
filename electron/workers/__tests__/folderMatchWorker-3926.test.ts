/**
 * @jest-environment node
 */
/**
 * BACKLOG-3926 — folder / label match at scale, on the REAL dedicated worker.
 *
 * Encrypted file DB built from schema.sql; 60,000 cached emails (half Gmail, half
 * Outlook); 200 folders / labels (100 per account), two of them named after the deal
 * address; every email sits in one folder / label. Measures, as main-thread
 * maxEventLoopDelay (printed):
 *   - capture of all 60,000 messages' folder ids (the force re-cache worst case),
 *   - the folder pass for one deal, worker path, and its parity with the main path,
 *   - getReviewState with every folder-match item resolving its title-row label.
 *
 * Run: ELECTRON_RUN_AS_NODE=1 npx electron ./node_modules/jest/bin/jest.js --runTestsByPath <this file>
 * Invented names and ids only.
 */
import * as nodePath from "path";
import * as nodeFs from "fs";
import * as os from "os";
import { monitorEventLoopDelay } from "perf_hooks";
import { build } from "esbuild";
import type { Database as DatabaseType } from "better-sqlite3";

jest.mock("@sentry/electron/main", () => ({ addBreadcrumb: jest.fn(), captureException: jest.fn(), captureMessage: jest.fn() }));
jest.mock("../../services/logService", () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const N_EMAILS = 60_000;
const N_FOLDERS_PER_ACCOUNT = 100;

/** 100 Gmail labels: Label_0 .. Label_99; Label_42 is the deal's. */
const GMAIL_LABELS = Array.from({ length: N_FOLDERS_PER_ACCOUNT }, (_, i) => ({
  id: `Label_${i}`,
  name: i === 42 ? "Deals/Maple Ave 1428" : `Client ${i}/${2000 + i} Oak St`,
  type: "user",
})).concat([{ id: "INBOX", name: "INBOX", type: "system" }]);
/** 100 Outlook folders under Inbox; F17 is the deal's. */
const OUTLOOK_FOLDERS = [{ id: "FInbox", displayName: "Inbox", parentFolderId: "FRoot" }].concat(
  Array.from({ length: N_FOLDERS_PER_ACCOUNT }, (_, i) => ({
    id: `F${i}`,
    displayName: i === 17 ? "1428 Maple" : `${3000 + i} Pine Rd`,
    parentFolderId: "FInbox",
  })),
);

jest.mock("../../services/gmailFetchService", () => ({
  __esModule: true,
  default: { listLabelCatalogSource: async () => GMAIL_LABELS },
}));
jest.mock("../../services/outlookFetchService", () => ({
  __esModule: true,
  default: { listFolderCatalogSource: async () => ({ folders: OUTLOOK_FOLDERS, systemFolderIds: ["FInbox", "FRoot"] }) },
}));

import { initializePool, isPoolReady, setContactWorkerPathForTests, shutdownPool } from "../contactWorkerPool";
import { setDb } from "../../services/db/core/dbConnection";
import { recordMailFoldersForFetchedEmails, __resetMailFolderCaptureForTests } from "../../services/mailFolderCaptureService";
import { getReviewState, queueFolderMatchesForTransaction } from "../../services/reviewStateService";
import { readFolderMatchCandidatesOn } from "../../services/db/folderMatchCandidatesDb";

const DRIVER = nodePath.join(__dirname, "..", "..", "..", "node_modules", "better-sqlite3-multiple-ciphers");
const KEY_HEX = "3926".repeat(16);
const USER = "user-3926p";
const GMAIL = "acct-g-3926p";
const OUTLOOK = "acct-o-3926p";
const TXN = "txn-3926p";

function loadDriver(): (new (file: string, opts?: object) => DatabaseType) | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const D = require(DRIVER);
    new D(":memory:").close();
    return D;
  } catch (error) {
    process.stderr.write(`[3926] skipped: sqlite driver not loadable here (${(error as Error).message.slice(0, 80)})\n`);
    return null;
  }
}
const Database = loadDriver();
const maybe = Database ? describe : describe.skip;

async function maxStallDuring<T>(work: () => Promise<T>): Promise<{ value: T; maxMs: number; ms: number }> {
  const h = monitorEventLoopDelay({ resolution: 10 });
  h.enable();
  await new Promise((r) => setTimeout(r, 50));
  const t0 = Date.now();
  const value = await work();
  const ms = Date.now() - t0;
  await new Promise((r) => setTimeout(r, 50));
  h.disable();
  return { value, maxMs: Math.round(h.max / 1e6), ms };
}

maybe("BACKLOG-3926 folder / label match at 60k emails / 200 folders", () => {
  let dir: string;
  let dbPath: string;
  let main: DatabaseType;

  function open(readonly = false): DatabaseType {
    const db = new (Database as NonNullable<typeof Database>)(dbPath, readonly ? { readonly: true } : undefined);
    db.pragma(`key = "x'${KEY_HEX}'"`);
    db.pragma("cipher_compatibility = 4");
    if (!readonly) db.pragma("journal_mode = WAL");
    return db;
  }

  /** Email i: even = Gmail, odd = Outlook; folder = i % 100 of its account. */
  const folderOf = (i: number): string => (i % 2 === 0 ? `Label_${(i >> 1) % N_FOLDERS_PER_ACCOUNT}` : `F${(i >> 1) % N_FOLDERS_PER_ACCOUNT}`);

  beforeAll(async () => {
    dir = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), "keepr-3926-folder-"));
    dbPath = nodePath.join(dir, "mad.db");
    main = open();
    main.exec(nodeFs.readFileSync(nodePath.join(__dirname, "..", "..", "database", "schema.sql"), "utf8"));
    main.prepare("INSERT INTO users_local (id, email, oauth_provider, oauth_id) VALUES (?, 'owner@example.test', 'google', 'o')").run(USER);
    main.prepare("INSERT INTO oauth_tokens (id, user_id, provider, purpose) VALUES (?, ?, 'google', 'mailbox')").run(GMAIL, USER);
    main.prepare("INSERT INTO oauth_tokens (id, user_id, provider, purpose) VALUES (?, ?, 'microsoft', 'mailbox')").run(OUTLOOK, USER);
    main
      .prepare(
        `INSERT INTO transactions (id, user_id, property_address, status, started_at, created_at, submission_status)
         VALUES (?, ?, '1428 Maple Ave, Springfield', 'active', '2026-01-01', '2026-01-01', 'not_submitted')`,
      )
      .run(TXN, USER);
    const ins = main.prepare(
      `INSERT INTO emails (id, user_id, external_id, source, account_id, subject, body_plain, sender, sent_at, thread_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'someone@example.test', ?, ?)`,
    );
    main.transaction(() => {
      for (let i = 0; i < N_EMAILS; i++) {
        const gm = i % 2 === 0;
        const day = String(1 + (i % 28)).padStart(2, "0");
        ins.run(`e${i}`, USER, `x${i}`, gm ? "gmail" : "outlook", gm ? GMAIL : OUTLOOK, `Subject ${i}`, "Body text ".repeat(40), `2026-03-${day}T10:00:00.000Z`, `th${i}`);
      }
    })();
    setDb(main);

    const workerScript = nodePath.join(dir, "contactQueryWorker.js");
    await build({
      entryPoints: [nodePath.join(__dirname, "..", "contactQueryWorker.ts")],
      bundle: true,
      platform: "node",
      format: "cjs",
      outfile: workerScript,
      plugins: [
        {
          name: "driver-from-repo",
          setup(b) {
            b.onResolve({ filter: /^better-sqlite3-multiple-ciphers$/ }, () => ({ path: DRIVER, external: true }));
          },
        },
      ],
      logLevel: "silent",
    });
    setContactWorkerPathForTests(workerScript);
    await initializePool(dbPath, KEY_HEX);
    __resetMailFolderCaptureForTests();
  }, 300_000);

  afterAll(async () => {
    await shutdownPool();
    setContactWorkerPathForTests(null);
    main.close();
    nodeFs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  it("capture, pass (worker == main) and read-time labels stay under the stall budget (numbers printed)", async () => {
    const gmailMsgs: Array<{ id: string; labels: string[] }> = [];
    const outlookMsgs: Array<{ id: string; parentFolderId: string }> = [];
    for (let i = 0; i < N_EMAILS; i++) {
      if (i % 2 === 0) gmailMsgs.push({ id: `x${i}`, labels: ["INBOX", "UNREAD", folderOf(i)] });
      else outlookMsgs.push({ id: `x${i}`, parentFolderId: folderOf(i) });
    }
    const capture = await maxStallDuring(async () => {
      await recordMailFoldersForFetchedEmails({ provider: "gmail", userId: USER, accountId: GMAIL, emails: gmailMsgs });
      await recordMailFoldersForFetchedEmails({ provider: "outlook", userId: USER, accountId: OUTLOOK, emails: outlookMsgs });
    });
    const refs = (main.prepare("SELECT COUNT(*) AS n FROM mail_folder_refs").get() as { n: number }).n;
    const names = (main.prepare("SELECT COUNT(*) AS n FROM mail_folder_names").get() as { n: number }).n;
    expect(refs).toBe(N_EMAILS);
    expect(names).toBe(GMAIL_LABELS.length + OUTLOOK_FOLDERS.length);

    // Expected: every email in Label_42 or F17.
    const expected = new Set<string>();
    for (let i = 0; i < N_EMAILS; i++) if (folderOf(i) === "Label_42" || folderOf(i) === "F17") expected.add(`e${i}`);

    expect(isPoolReady()).toBe(true);
    const pass = await maxStallDuring(() => queueFolderMatchesForTransaction(TXN));
    expect(pass.value).toEqual({ queued: expected.size, folders: 2, candidates: expected.size });

    // Parity: the same statement on a main-thread read connection.
    const ro = open(true);
    let mainIds: string[];
    try {
      const params = [
        JSON.stringify([[GMAIL, "Label_42"], [OUTLOOK, "F17"]]),
        USER,
        "2026-01-01T00:00:00.000Z",
        "2099-01-01T00:00:00.000Z",
        "none",
        "none",
      ];
      mainIds = readFolderMatchCandidatesOn(ro, params);
    } finally {
      ro.close();
    }
    expect(new Set(mainIds)).toEqual(expected);

    const state = await maxStallDuring(async () => getReviewState(TXN));
    expect(state.value.items.filter((i) => i.matchFolder).length).toBe(expected.size);
    // Tripwire for the label lookup's index (idx_mail_folder_refs_external): without it
    // this call measured 2,430 ms here; with it, ~30 ms.
    expect(state.ms).toBeLessThan(500);

    process.stderr.write(
      `[3926] ${N_EMAILS} emails / ${N_FOLDERS_PER_ACCOUNT * 2} folders+labels: ` +
        `capture ${capture.ms}ms maxEventLoopDelay=${capture.maxMs}ms; ` +
        `folder pass (worker, ${expected.size} queued) ${pass.ms}ms maxEventLoopDelay=${pass.maxMs}ms; ` +
        `getReviewState ${state.ms}ms (one synchronous call)\n`,
    );
  }, 300_000);
});
