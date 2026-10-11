/**
 * BACKLOG-3816: the before-sync / before-decrypt sweep must not delete a parse copy a
 * finished sync is still persisting from (isRunning goes false before persistence ends).
 * Real directories under os.tmpdir().
 */
jest.mock("../logService", () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import fs from "fs";
import os from "os";
import path from "path";
import { BackupDecryptionService, IOS_PARSE_COPY_PREFIX } from "../backupDecryptionService";

describe("BACKLOG-3816: sweepParseCopies skips a copy still in use", () => {
  let root: string;
  let svc: BackupDecryptionService;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "keepr-3816-inuse-"));
    svc = new BackupDecryptionService({ tmpRoot: () => root });
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  const makeCopy = (dir: string) => {
    fs.mkdirSync(path.join(dir, "ab"), { recursive: true });
    fs.writeFileSync(path.join(dir, "ab", "sms.db"), "plaintext");
  };

  it("keeps sync A's copy through sync B's sweep, then removes it when A's persistence ends", async () => {
    const copyA = svc.newParseCopyDir(); // sync A: handed out, "finished", persisting
    makeCopy(copyA);
    const crashLeftover = path.join(root, `${IOS_PARSE_COPY_PREFIX}crash`);
    makeCopy(crashLeftover);

    const removed = await svc.sweepParseCopies(); // sync B / processExistingBackup starts

    expect(removed).toBe(1);
    expect(fs.existsSync(path.join(copyA, "ab", "sms.db"))).toBe(true); // A can still read it
    expect(fs.existsSync(crashLeftover)).toBe(false); // genuinely stale copies still go

    expect(await svc.cleanup(copyA)).toBe(true); // A's persistence finally
    expect(fs.existsSync(copyA)).toBe(false);
  });

  it("a copy whose removal failed is sweepable afterwards (not protected forever)", async () => {
    const copy = svc.newParseCopyDir();
    makeCopy(copy);
    const rm = jest.spyOn(fs.promises, "rm").mockRejectedValueOnce(new Error("EBUSY"));
    expect(await svc.cleanup(copy)).toBe(false);
    rm.mockRestore();
    expect(fs.existsSync(copy)).toBe(true);
    expect(await svc.sweepParseCopies()).toBe(1);
    expect(fs.existsSync(copy)).toBe(false);
  });

  it("the quit sweep still removes an in-use copy", () => {
    const copy = svc.newParseCopyDir();
    makeCopy(copy);
    expect(svc.sweepParseCopiesSync()).toEqual({ removed: 1, failed: 0 });
    expect(fs.existsSync(copy)).toBe(false);
  });
});
