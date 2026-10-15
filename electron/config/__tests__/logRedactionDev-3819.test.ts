/**
 * BACKLOG-3819 (decision dc27e73c) — a dev (unpackaged) build writes its log as
 * REDACTED PLAINTEXT, not sealed.
 *
 * The real electron-log (jest maps `electron-log` to a mock; this file maps it
 * back to `electron-log/node`) and the real bootstrap, with `app.isPackaged`
 * false. The packaged counterpart is logRedaction-3819.test.ts.
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

jest.mock("electron-log", () => jest.requireActual("electron-log/node"));
jest.mock("../../bootstrap/appDataPaths", () => ({
  applyAppDataPaths: () => null,
  buildConsoleNotice: () => "",
  logsSealedAtRest: ({ isPackaged }: { isPackaged: boolean }) => isPackaged,
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const realLog = require("electron-log/node");

const EMAIL = "dev.customer@example.com";

describe("BACKLOG-3819: dev builds write redacted plaintext logs", () => {
  let dir: string;

  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "keepr-log-3819-dev-"));
    realLog.transports.file.resolvePathFn = () => path.join(dir, "main.log");
    realLog.transports.file.level = "info";
    realLog.transports.console.level = false;
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    require("electron").app.isPackaged = false;
    require("../../bootstrap/installAppDataPaths");
  });

  afterAll(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("the line reaches main.log as plaintext, redacted, with no key ever opened", () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { getLogSink, isLogSealingEnabled } = require("../../services/sealedLogSink");
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { isSealedLog } = require("../../services/atRest/sealedLog");
    realLog.info(`[Dev] contact ${EMAIL} (555) 555-0177`);
    const raw = fs.readFileSync(path.join(dir, "main.log"));
    expect(isSealedLog(raw)).toBe(false);
    const text = raw.toString("utf8");
    expect(text).toContain("[Dev] contact d***@example.com ***77");
    expect(text).not.toContain(EMAIL);
    expect(isLogSealingEnabled()).toBe(false);
    expect(getLogSink().state).toBe("pending");
    expect(getLogSink().pendingLines).toHaveLength(0);
  });
});
