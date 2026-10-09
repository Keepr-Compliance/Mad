/**
 * BACKLOG-3819 L1 / early-write — customer emails and phone numbers never reach
 * the log file or the console.
 *
 * Exercised against the REAL electron-log (jest maps `electron-log` to a mock;
 * this file maps it back to `electron-log/node`), with its real file transport
 * writing into a temp directory. Against the mock none of this could go red.
 */

import * as fs from "fs";
import * as os from "os";
import * as path from "path";

jest.mock("electron-log", () => jest.requireActual("electron-log/node"));
// installAppDataPaths' own job (the dev data directory) is not under test here.
jest.mock("../../bootstrap/appDataPaths", () => ({
  applyAppDataPaths: () => null,
  buildConsoleNotice: () => "",
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const realLog = require("electron-log/node");

const EMAIL = "jane.customer@example.com";

/** A class instance argument (not a plain object). */
class ContactRef {
  constructor(public email: string) {}
}
const PHONE = "+1 (555) 555-0142";

describe("BACKLOG-3819: the electron-log sink redacts emails and phones", () => {
  let dir: string;
  let consoleLines: string[];

  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "keepr-log-3819-"));
    realLog.transports.file.resolvePathFn = () => path.join(dir, "main.log");
    realLog.transports.file.level = "info";
    realLog.transports.console.level = "info";
    consoleLines = [];
    realLog.transports.console.writeFn = ({ message }: { message: { data: unknown[] } }) => {
      consoleLines.push(JSON.stringify(message.data));
    };
    // The production install: the first import in main.ts.
    require("../../bootstrap/installAppDataPaths");
  });

  afterAll(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function fileText(): string {
    const f = path.join(dir, "main.log");
    return fs.existsSync(f) ? fs.readFileSync(f, "utf8") : "";
  }

  it("main.ts imports installAppDataPaths before anything else", () => {
    const main = fs.readFileSync(path.join(__dirname, "../../main.ts"), "utf8");
    const firstImport = main.split("\n").find((l) => /^import\s/.test(l));
    expect(firstImport).toBe('import "./bootstrap/installAppDataPaths";');
  });

  it("the bootstrap registers electron-log's directory for the at-rest 'logs' job", () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { runConfiguredLogMaintenance } = require("../../services/logScrub");
    const result = runConfiguredLogMaintenance();
    expect(result).not.toBeNull();
    expect(fs.existsSync(path.join(dir, ".keepr-log-scrub-v1"))).toBe(true);
  });

  it("early write: a line logged while a module is imported is redacted", () => {
    require("./fixtures/logsAtImport3819");
    const text = fileText();
    expect(text).toContain("[Fixture] import-time line");
    expect(text).not.toContain("jane.importtime@example.com");
    expect(text).not.toContain("+15555550166");
    expect(text).toContain("j***@example.com");
    expect(text).toContain("***66");
  });

  it("L1: message text and data args are redacted in the file AND console transports", () => {
    const err = new Error(`lookup failed for ${EMAIL}`);
    realLog.info(`[Main] contact ${EMAIL} phone ${PHONE}`, {
      handle: "+15555550177",
      nested: { list: ["555-555-0188", { email: "bob.x@example.org" }] },
      contact: new ContactRef("carol.y@example.net"),
      map: new Map([["k", "dan.z@example.com"]]),
    });
    realLog.error("[Main] failure", err);

    const text = fileText();
    for (const raw of [EMAIL, PHONE, "+15555550177", "555-555-0188", "bob.x@example.org", "carol.y@example.net", "dan.z@example.com"]) {
      expect(text).not.toContain(raw);
      expect(consoleLines.join("\n")).not.toContain(raw);
    }
    expect(text).toContain("j***@example.com phone ***42");
    expect(text).toContain("***77");
    expect(text).toContain("***88");
    expect(text).toContain("b***@example.org");
    // class instances keep their content (printed form), redacted
    expect(text).toContain("ContactRef { email: 'c***@example.net' }");
    // the caller's Error is not mutated
    expect(err.message).toContain(EMAIL);
  });

  it("L1: an Error's message and stack trace are redacted in file and console", () => {
    const err = new Error(`lookup failed for erin.q@example.com`);
    err.stack = `Error: lookup failed for erin.q@example.com\n    at find (/app/contacts.js:10:5) +15555550155\n    at run (/app/x.js:1:1)`;
    realLog.error("[Main] stack test", err);
    const text = fileText();
    expect(text).toContain("lookup failed for e***@example.com");
    expect(text).toContain("at find (/app/contacts.js:10:5) ***55");
    expect(text).not.toContain("erin.q@example.com");
    expect(text).not.toContain("+15555550155");
    expect(consoleLines.join("\n")).not.toContain("erin.q@example.com");
  });

  it("L1: a multi-line message is redacted on every line", () => {
    realLog.warn("[Main] batch:\n  first frank.m@example.com\n  second (555) 555-0131\n  third +44 20 7946 0958");
    const text = fileText();
    expect(text).toContain("first f***@example.com\n  second ***31\n  third ***58");
    expect(consoleLines[consoleLines.length - 1]).toContain("second ***31");
  });

  it("L1: the console transport receives the redacted text", () => {
    realLog.info(`[Main] console-only check ${EMAIL} ${PHONE}`);
    const last = consoleLines[consoleLines.length - 1];
    expect(last).toContain("console-only check j***@example.com ***42");
  });

  it("L1: a renderer-relayed line (log:renderer → log.info('[Renderer] ...')) is redacted", () => {
    // Same call shape as handlers/systemHandlers.ts `log:renderer`; the real
    // listener is exercised in handlers/__tests__/rendererLogRelay-3819.test.ts.
    realLog.info(`[Renderer] [Contacts] opened ${EMAIL} / ${PHONE}`);
    const text = fileText();
    expect(text).toContain("[Renderer] [Contacts] opened j***@example.com / ***42");
  });
});
