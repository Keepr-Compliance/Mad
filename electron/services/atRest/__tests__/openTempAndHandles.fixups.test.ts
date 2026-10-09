/**
 * @jest-environment node
 */
/**
 * BACKLOG-3816 S2 fix-ups: decryptToFile closes every handle it opens, and the
 * open-copy name keeps the stored extension and never produces a Windows device name.
 */
import crypto from "crypto";
import fs from "fs";
import os from "os";
import path from "path";
import { Readable } from "stream";

import { createFileCrypto, type KeyResolver } from "../fileCrypto";
import { safeOpenName } from "../openTemp";

const KEY = crypto.randomBytes(32);
const KEY_ID = crypto.randomBytes(16).toString("hex");
const resolver: KeyResolver = {
  currentKey: async () => ({ keyId: KEY_ID, key: KEY }),
  keyFor: async () => KEY,
};
const files = createFileCrypto(resolver, { chunkSize: 64 });
const PLAIN = crypto.randomBytes(300);

let dir: string;
let enc: string;
let plain: string;
const opened: fs.promises.FileHandle[] = [];
const realOpen = fs.promises.open.bind(fs.promises);

beforeEach(async () => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "s2-fix-")));
  enc = path.join(dir, "enc.bin");
  plain = path.join(dir, "plain.bin");
  await files.encryptStreamToFile(Readable.from([PLAIN]), enc);
  fs.writeFileSync(plain, PLAIN);
  opened.length = 0;
  jest.spyOn(fs.promises, "open").mockImplementation((async (...args: Parameters<typeof realOpen>) => {
    const h = await realOpen(...args);
    opened.push(h);
    return h;
  }) as never);
});
afterEach(() => {
  jest.restoreAllMocks();
  fs.rmSync(dir, { recursive: true, force: true });
});

const openFds = () => opened.filter((h) => h.fd !== -1).length;

describe("H: decryptToFile closes every handle on every path", () => {
  for (const [label, src] of [["encrypted", () => enc], ["plaintext", () => plain]] as const) {
    it(`${label}: destination directory cannot be created (mkdir throws)`, async () => {
      const blocker = path.join(dir, "blocker");
      fs.writeFileSync(blocker, "x");
      await expect(files.decryptToFile(src(), path.join(blocker, "sub", "out.bin"))).rejects.toThrow();
      expect(openFds()).toBe(0);
    });

    it(`${label}: a write throws mid-copy`, async () => {
      (fs.promises.open as jest.Mock).mockImplementation((async (...args: unknown[]) => {
        const h = await realOpen(...(args as Parameters<typeof realOpen>));
        opened.push(h);
        if (args[1] === "wx") h.write = (async () => { throw new Error("disk full"); }) as never;
        return h;
      }) as never);
      await expect(files.decryptToFile(src(), path.join(dir, "out", "o.bin"))).rejects.toThrow("disk full");
      expect(openFds()).toBe(0);
      expect(fs.existsSync(path.join(dir, "out", "o.bin"))).toBe(false);
      expect(fs.readdirSync(path.join(dir, "out"))).toEqual([]);
    });
  }

  it("control: success leaves no handle open", async () => {
    await files.decryptToFile(enc, path.join(dir, "ok", "o.bin"));
    expect(fs.readFileSync(path.join(dir, "ok", "o.bin")).equals(PLAIN)).toBe(true);
    expect(openFds()).toBe(0);
    expect(opened.length).toBeGreaterThanOrEqual(2);
  });
});

describe("N: safeOpenName", () => {
  it("keeps the STORED extension and takes only the stem from the database name", () => {
    expect(safeOpenName("invoice.pdf", "x", ".png")).toBe("invoice.png");
    expect(safeOpenName("invoice", "x", ".pdf")).toBe("invoice.pdf");
    expect(safeOpenName("a.b.c", "x", ".jpg")).toBe("a.b.jpg");
    expect(safeOpenName("report.exe", "x", "")).toBe("report");
  });

  it("sanitises separators, control characters and leading dots", () => {
    expect(safeOpenName("../../etc/pass\u0001wd.txt", "f", ".txt")).toBe("pass_wd.txt");
    expect(safeOpenName("a<b>:c.jpg", "f", ".jpg")).toBe("a_b__c.jpg");
    expect(safeOpenName("...hidden.jpg", "f", ".jpg")).toBe("hidden.jpg");
  });

  const RESERVED = ["CON", "PRN", "AUX", "NUL", "COM1", "COM9", "LPT1", "LPT9", "con", "Nul"];
  for (const r of RESERVED) {
    it(`reserved device name ${r}, bare and with an extension`, () => {
      expect(safeOpenName(r, "f", ".txt")).toBe(`_${r}.txt`);
      expect(safeOpenName(`${r}.txt`, "f", ".txt")).toBe(`_${r}.txt`);
      expect(safeOpenName(r, "f")).toBe(`_${r}`);
      expect(safeOpenName(`${r}.pdf`, "f")).toBe(`_${r}.pdf`);
    });
  }

  it("does not touch names that merely start with a device name", () => {
    expect(safeOpenName("CONTRACT.pdf", "f", ".pdf")).toBe("CONTRACT.pdf");
    expect(safeOpenName("COM10", "f", ".txt")).toBe("COM10.txt");
    expect(safeOpenName("LPT0", "f", ".txt")).toBe("LPT0.txt");
  });

  it("strips trailing dots and spaces (Windows drops them silently)", () => {
    expect(safeOpenName("report. . ", "f", ".pdf")).toBe("report.pdf");
    expect(safeOpenName("report.pdf. ", "f")).toBe("report.pdf");
    expect(safeOpenName("NUL. ", "f", ".pdf")).toBe("_NUL.pdf");
    expect(safeOpenName(" . . ", "fallback.txt", ".txt")).toBe("fallback.txt");
  });

  it("falls back, and bounds length including the forced extension", () => {
    expect(safeOpenName(null, "", ".pdf")).toBe("attachment.pdf");
    const out = safeOpenName("x".repeat(400) + ".jpg", "f", ".jpeg");
    expect(out.length).toBeLessThanOrEqual(150);
    expect(out.endsWith(".jpeg")).toBe(true);
  });
});
