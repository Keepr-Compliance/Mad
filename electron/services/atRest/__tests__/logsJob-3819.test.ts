/**
 * @jest-environment node
 */
/**
 * BACKLOG-3819 — the at-rest "logs" job opens log sealing.
 *
 * Key available: maintenance (seal legacy plaintext, merge the fallback) runs,
 * THEN the sink starts sealing and flushes what it held. Key unavailable: the
 * sink falls back to redacted plaintext for this run. Temp dir, test key.
 */
import fs from "fs";
import os from "os";
import path from "path";

const KEY = { keyId: "66".repeat(16), key: Buffer.alloc(32, 6) };
let keyMode: "ok" | "unavailable" = "ok";

jest.mock("../dataKeyService", () => {
  const actual = jest.requireActual("../dataKeyService");
  return {
    ...actual,
    getDataKeyService: () => ({
      currentKey: async () => {
        if (keyMode === "unavailable") throw new actual.DataKeyUnavailableError("secure storage unavailable");
        return KEY;
      },
    }),
  };
});

import { AtRestStartup, registerDefaultJobs } from "../startup";
import { getLogSink, resetLogSinkForTests, SealedLogSink } from "../../sealedLogSink";
import { setLogDirectoryResolver } from "../../logScrub";
import { isSealedLog, openSealedLog } from "../sealedLog";

let dir: string;
let main: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "keepr-logsjob-"));
  main = path.join(dir, "main.log");
  setLogDirectoryResolver(() => dir);
  resetLogSinkForTests(new SealedLogSink({ report: () => undefined }));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
  setLogDirectoryResolver(null);
  resetLogSinkForTests(null);
});

async function runLogsJob(): Promise<void> {
  const q = new AtRestStartup({ log: () => undefined });
  registerDefaultJobs(q);
  const outcomes = await q.run();
  expect(outcomes.find((o) => o.id === "logs")?.status).toBe("ok");
}

describe("BACKLOG-3819 at-rest logs job", () => {
  it("with the key: legacy plaintext sealed, held lines flushed sealed after it, in order", async () => {
    keyMode = "ok";
    fs.writeFileSync(main, "[2099-01-01 00:00:00.000] [info] legacy plaintext line\n");
    getLogSink().write(main, "[2099-01-01 00:00:01.000] [info] held before key\n");
    await runLogsJob();
    expect(getLogSink().state).toBe("sealed");
    const raw = fs.readFileSync(main);
    expect(isSealedLog(raw)).toBe(true);
    expect(raw.includes(Buffer.from("legacy plaintext line"))).toBe(false);
    const read = openSealedLog(raw, (id) => (id === KEY.keyId ? KEY.key : null));
    expect(read.problems).toEqual([]);
    expect(read.text.indexOf("legacy plaintext line")).toBeLessThan(read.text.indexOf("held before key"));
  });

  it("key unavailable: held lines go to main.unsealed.log (redacted); main.log untouched", async () => {
    keyMode = "unavailable";
    getLogSink().write(main, "[2099-01-01 00:00:01.000] [info] held amy@example.com\n");
    await runLogsJob();
    expect(getLogSink().state).toBe("plaintext");
    expect(fs.existsSync(main)).toBe(false);
    expect(fs.readFileSync(path.join(dir, "main.unsealed.log"), "utf8")).toContain("held a***@example.com");
  });
});
