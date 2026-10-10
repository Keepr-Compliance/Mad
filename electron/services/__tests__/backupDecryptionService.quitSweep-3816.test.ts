/**
 * BACKLOG-3816: sweepParseCopiesSync (the app-quit removal) deletes only `ios-*`
 * directories directly under the parse-copy root, counts a removal that fails instead of
 * ignoring it, and never throws. Real directories under os.tmpdir().
 */
jest.mock("../logService", () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import fs from "fs";
import os from "os";
import path from "path";
import logService from "../logService";
import { BackupDecryptionService, IOS_PARSE_COPY_PREFIX } from "../backupDecryptionService";

describe("BACKLOG-3816: BackupDecryptionService.sweepParseCopiesSync", () => {
  let root: string;
  let svc: BackupDecryptionService;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "keepr-3816-sweep-"));
    svc = new BackupDecryptionService({ tmpRoot: () => root });
    jest.clearAllMocks();
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it("removes ios-* copies and nothing else", () => {
    const a = path.join(root, `${IOS_PARSE_COPY_PREFIX}aaa`);
    const b = path.join(root, `${IOS_PARSE_COPY_PREFIX}bbb`);
    const keep = path.join(root, "not-a-parse-copy");
    for (const d of [a, b, keep]) fs.mkdirSync(path.join(d, "ab"), { recursive: true });
    fs.writeFileSync(path.join(a, "ab", "sms.db"), "plaintext");
    expect(fs.existsSync(path.join(a, "ab", "sms.db"))).toBe(true);

    const out = svc.sweepParseCopiesSync();

    expect(out).toEqual({ removed: 2, failed: 0 });
    expect(fs.existsSync(a)).toBe(false);
    expect(fs.existsSync(b)).toBe(false);
    expect(fs.existsSync(keep)).toBe(true);
  });

  it("a missing root is zero, not an error", () => {
    const gone = new BackupDecryptionService({ tmpRoot: () => path.join(root, "nope") });
    expect(gone.sweepParseCopiesSync()).toEqual({ removed: 0, failed: 0 });
  });

  it("a removal that fails is counted and logged, and the sweep carries on", () => {
    fs.mkdirSync(path.join(root, `${IOS_PARSE_COPY_PREFIX}one`));
    fs.mkdirSync(path.join(root, `${IOS_PARSE_COPY_PREFIX}two`));
    const real = fs.rmSync;
    const spy = jest.spyOn(fs, "rmSync").mockImplementation(((p: fs.PathLike, o?: fs.RmOptions) => {
      if (String(p).endsWith("one")) throw Object.assign(new Error("EPERM: in use"), { code: "EPERM" });
      return real(p, o);
    }) as typeof fs.rmSync);
    try {
      const out = svc.sweepParseCopiesSync();
      expect(out).toEqual({ removed: 1, failed: 1 });
      expect(logService.warn).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
    }
    expect(fs.existsSync(path.join(root, `${IOS_PARSE_COPY_PREFIX}one`))).toBe(true);
  });
});
