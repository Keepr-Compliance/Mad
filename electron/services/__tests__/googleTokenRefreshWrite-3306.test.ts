/**
 * @jest-environment node
 *
 * BACKLOG-3306: a refreshed Google token is saved in ONE write, with its real
 * expiry, and a failed write is logged instead of escaping as an unhandled
 * rejection.
 *
 * Drives the REAL google-auth-library 401/403 retry refresh through the REAL
 * gmailFetchService / googleContactProvider, real better-sqlite3 and the
 * shipped schema. Only the network (gaxiosNetFetch) is scripted. The "tokens"
 * listener is never called directly: it fires from the library's own retry.
 *
 * The injector throws on the k-th `UPDATE oauth_tokens` and records firedAt,
 * so every crash point is asserted to have actually been reached.
 *
 * Real-driver suite. Run with:
 *   ELECTRON_RUN_AS_NODE=1 npx electron ./node_modules/jest/bin/jest.js <this file>
 */
import type { Database as DatabaseType, Statement } from "better-sqlite3";
import crypto from "crypto";
import fs from "fs";
import path from "path";

jest.mock("electron", () => ({
  app: { getPath: jest.fn(() => "/tmp"), getVersion: jest.fn(() => "0.0.0-test"), isPackaged: false },
  net: { fetch: jest.fn() },
  ipcMain: { handle: jest.fn(), on: jest.fn() },
  BrowserWindow: { getAllWindows: () => [] },
}));
jest.mock("@sentry/electron/main", () => ({
  captureException: jest.fn(),
  setUser: jest.fn(),
  addBreadcrumb: jest.fn(),
}));
jest.mock("../logService", () => {
  const m = {
    info: jest.fn().mockResolvedValue(undefined),
    warn: jest.fn().mockResolvedValue(undefined),
    error: jest.fn().mockResolvedValue(undefined),
    debug: jest.fn().mockResolvedValue(undefined),
  };
  return { __esModule: true, default: m, logService: m };
});
jest.mock("../googleAuthService", () => ({ __esModule: true, default: {} }));

// Network script. Records every URL.
const mockNet: { calls: string[]; tokenBody: Record<string, unknown>; apiStatus: number[] } = {
  calls: [],
  tokenBody: {},
  apiStatus: [],
};
jest.mock("../mainNetFetch", () => ({
  __esModule: true,
  mainNetFetch: jest.fn(),
  gaxiosNetFetch: jest.fn(async (url: string | URL) => {
    const u = String(url);
    mockNet.calls.push(u);
    const json = (status: number, body: unknown) =>
      new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    if (u.includes("oauth2.googleapis.com/token")) return json(200, mockNet.tokenBody);
    const status = mockNet.apiStatus.shift() ?? 200;
    if (status !== 200) return json(status, { error: { code: status, message: "x" } });
    if (u.includes("people.googleapis.com")) return json(200, { connections: [], totalItems: 0 });
    return json(200, { id: "m1", threadId: "t1", labelIds: [], payload: { headers: [], mimeType: "text/plain", body: { data: "" } }, internalDate: "0" });
  }),
}));

jest.mock("../databaseService", () => {
  const m = jest.requireActual("../db/oauthTokenDbService") as Record<string, unknown>;
  const proxy = new Proxy({} as Record<string | symbol, unknown>, {
    get(_t, name) {
      if (typeof name !== "string") return undefined;
      const fn = m[name];
      if (typeof fn !== "function") return undefined;
      return async (...args: unknown[]) => (fn as (...a: unknown[]) => unknown)(...args);
    },
  });
  return { __esModule: true, default: proxy };
});

// eslint-disable-next-line @typescript-eslint/no-require-imports
const Database = require(
  path.join(__dirname, "..", "..", "..", "node_modules", "better-sqlite3-multiple-ciphers"),
) as typeof import("better-sqlite3-multiple-ciphers");

import { setDb } from "../db/core/dbConnection";
import { saveOAuthTokenSync } from "../db/oauthTokenDbService";
import gmailFetchService from "../gmailFetchService";
import { GoogleContactProvider } from "../providers/googleContactProvider";

const SCHEMA = fs.readFileSync(path.join(__dirname, "..", "..", "database", "schema.sql"), "utf8");
const USER = crypto.randomUUID();

let writeCount = 0;
let crashAt = 0;
let firedAt = 0;
const writes: string[] = [];
let db: DatabaseType;

function instrument(handle: DatabaseType): void {
  const realPrepare = handle.prepare.bind(handle);
  (handle as unknown as { prepare: (s: string) => Statement }).prepare = (source: string) => {
    const stmt = realPrepare(source);
    if (/^\s*UPDATE\s+oauth_tokens/i.test(source)) {
      const realRun = stmt.run.bind(stmt);
      (stmt as unknown as { run: (...a: unknown[]) => unknown }).run = (...p: unknown[]) => {
        writeCount += 1;
        writes.push(source.replace(/\s+/g, " ").trim());
        if (crashAt && writeCount === crashAt) {
          firedAt = writeCount;
          throw new Error(`INJECTED CRASH at write ${writeCount}`);
        }
        return realRun(...(p as never[]));
      };
    }
    return stmt;
  };
}

const unhandled: unknown[] = [];
const onUnhandled = (e: unknown) => unhandled.push(e);

beforeEach(() => {
  process.env.GOOGLE_CLIENT_ID = "cid";
  process.env.GOOGLE_CLIENT_SECRET = "csecret";
  db = new Database(":memory:") as unknown as DatabaseType;
  db.exec(SCHEMA);
  db.prepare("INSERT INTO users_local (id,email,oauth_provider,oauth_id) VALUES (?, 'me@example.com', 'google', 'o-me')").run(USER);
  setDb(db);
  saveOAuthTokenSync(USER, "google", "mailbox", {
    access_token: "OLD_ACCESS",
    refresh_token: "OLD_REFRESH",
    token_expires_at: SEEDED_EXPIRY,
    connected_email_address: "me@example.com",
    mailbox_connected: true,
  });
  instrument(db);
  writeCount = 0; crashAt = 0; firedAt = 0; writes.length = 0; unhandled.length = 0;
  mockNet.calls.length = 0;
  process.on("unhandledRejection", onUnhandled);
});
afterEach(() => {
  process.off("unhandledRejection", onUnhandled);
});

function row() {
  return db.prepare("SELECT access_token a, refresh_token r, token_expires_at e FROM oauth_tokens WHERE user_id = ?").get(USER);
}
const settle = () => new Promise((r) => setTimeout(r, 50));

async function runGmail(status = 401) {
  mockNet.apiStatus = [status];
  await gmailFetchService.initialize(USER);
  try { await gmailFetchService.getEmailById("m1"); } catch { /* parse may fail; irrelevant */ }
  await settle();
}
async function runContacts(status = 401) {
  mockNet.apiStatus = [status];
  try { await new GoogleContactProvider().fetchContacts(USER); } catch { /* irrelevant */ }
  await settle();
}

// Shapes of the token endpoint's reply to a refresh_token grant.
// NORMAL: no refresh_token (Google's usual reply). ROTATE: carries one.
// NO_EXPIRY: no expires_in, so the library sets no expiry_date.
const ROTATE = { access_token: "NEW_ACCESS", refresh_token: "NEW_REFRESH", expires_in: 3599, token_type: "Bearer", scope: "s" };
const NORMAL = { access_token: "NEW_ACCESS", expires_in: 3599, token_type: "Bearer", scope: "s" };
const NO_EXPIRY = { access_token: "NEW_ACCESS", token_type: "Bearer", scope: "s" };
const SEEDED_EXPIRY = "2026-01-01T00:00:00.000Z";

import logServiceMock from "../logService";
describe.each([["gmail", runGmail], ["contacts", runContacts]] as const)("%s", (_name, run) => {
  for (const [label, body] of [["NORMAL", NORMAL], ["ROTATE", ROTATE]] as const) {
    for (const k of [0, 1, 2]) {
      it(`${label} crashAt=${k}`, async () => {
        (logServiceMock.error as jest.Mock).mockClear();
        mockNet.tokenBody = { ...body };
        crashAt = k;
        await run();
        const r = row() as { a: string; r: string; e: string };
        expect(mockNet.calls.some((c) => c.includes("oauth2.googleapis.com/token"))).toBe(true);
        expect(unhandled).toEqual([]);
        if (k > 0 && firedAt !== k) {
          // No k-th write on this path: the refresh did fewer than k writes.
          expect(writeCount).toBeLessThan(k);
          expect(r).toEqual({ a: "NEW_ACCESS", r: label === "ROTATE" ? "NEW_REFRESH" : "OLD_REFRESH", e: r.e });
          return;
        }
        // generation consistency
        if (label === "ROTATE") expect([r.a, r.r].map((x) => x.slice(0, 3))).toEqual(r.a.startsWith("NEW") ? ["NEW", "NEW"] : ["OLD", "OLD"]);
        if (label === "NORMAL") expect(r.r).toBe("OLD_REFRESH");
        if (k === 0) {
          expect(writeCount).toBe(1);
          expect(r.a).toBe("NEW_ACCESS");
          expect(Math.abs(Date.parse(r.e) - Date.now())).toBeLessThan(2 * 3600 * 1000);
          if (label === "ROTATE") expect(r.r).toBe("NEW_REFRESH");
        } else {
          // The failed write left the row exactly as it was, and was logged.
          expect(r).toEqual({ a: "OLD_ACCESS", r: "OLD_REFRESH", e: SEEDED_EXPIRY });
          expect(logServiceMock.error).toHaveBeenCalled();
        }
      });
    }
  }

  it("reply with no expiry: saves the access token and leaves the stored expiry unchanged", async () => {
    mockNet.tokenBody = { ...NO_EXPIRY };
    await run();
    expect(mockNet.calls.some((c) => c.includes("oauth2.googleapis.com/token"))).toBe(true);
    expect(unhandled).toEqual([]);
    expect(writeCount).toBe(1);
    expect(row()).toEqual({ a: "NEW_ACCESS", r: "OLD_REFRESH", e: SEEDED_EXPIRY });
  });

  it("a 403 from the API also triggers the refresh and is saved in one write", async () => {
    mockNet.tokenBody = { ...NORMAL };
    await run(403);
    expect(mockNet.calls.some((c) => c.includes("oauth2.googleapis.com/token"))).toBe(true);
    expect(unhandled).toEqual([]);
    expect(writeCount).toBe(1);
    const r = row() as { a: string; r: string; e: string };
    expect(r.a).toBe("NEW_ACCESS");
    expect(r.r).toBe("OLD_REFRESH");
    expect(Math.abs(Date.parse(r.e) - Date.now())).toBeLessThan(2 * 3600 * 1000);
  });
});
