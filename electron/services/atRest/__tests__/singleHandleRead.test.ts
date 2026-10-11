/**
 * @jest-environment node
 */
/**
 * BACKLOG-3816 S2 — every reader decides "encrypted or plaintext" and reads the
 * bytes through ONE file handle.
 *
 * The migration replaces a plaintext attachment with its encrypted version by
 * rename. A reader that checks the header through one open and reads the body
 * through a second open by path can see the old file's header and the new file's
 * bytes — and hand ciphertext to a preview or an export.
 *
 * Control SW: the swap is forced at the worst moment — immediately after the
 * reader's first read (the magic probe) on the file, the other version is
 * renamed over the path. Output must be the correct plaintext, never ciphertext.
 * Both directions are covered (plaintext → ciphertext, ciphertext → plaintext).
 *
 * POSIX only: renaming over a file another handle holds open is not portable to
 * Windows, so the swap cannot be staged there. The single-handle property itself
 * is platform independent.
 */
import crypto from "crypto";
import fs from "fs";
import os from "os";
import path from "path";
import { Readable } from "stream";

import { createFileCrypto, MAGIC, type FileCrypto, type KeyResolver } from "../fileCrypto";

const KEY = crypto.randomBytes(32);
const KEY_ID = crypto.randomBytes(16).toString("hex");
const resolver: KeyResolver = {
  currentKey: async () => ({ keyId: KEY_ID, key: KEY }),
  keyFor: async (id) => {
    if (id !== KEY_ID) throw new Error("unknown key");
    return KEY;
  },
};
const files: FileCrypto = createFileCrypto(resolver, { chunkSize: 64 });
const PLAIN = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), crypto.randomBytes(400)]);

const itPosix = process.platform === "win32" ? it.skip : it;

let dir: string;
let target: string;
let plainCopy: string;
let encCopy: string;

beforeEach(async () => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "s2-swap-")));
  target = path.join(dir, "file.jpg");
  plainCopy = path.join(dir, "plain.src");
  encCopy = path.join(dir, "enc.src");
  fs.writeFileSync(plainCopy, PLAIN);
  await files.encryptStreamToFile(Readable.from([PLAIN]), encCopy);
});

afterEach(() => {
  jest.restoreAllMocks();
  fs.rmSync(dir, { recursive: true, force: true });
});

/** After the first read on any handle opened for `target`, rename `replacement` over it. */
function swapAfterFirstRead(replacement: string): { swapped: () => boolean } {
  let swapped = false;
  const realOpen = fs.promises.open.bind(fs.promises);
  jest.spyOn(fs.promises, "open").mockImplementation((async (...args: Parameters<typeof fs.promises.open>) => {
    const handle = await realOpen(...args);
    if (String(args[0]) === target && !swapped) {
      const realRead = handle.read.bind(handle) as (...a: unknown[]) => Promise<unknown>;
      (handle as unknown as { read: unknown }).read = async (...a: unknown[]) => {
        const result = await realRead(...a);
        if (!swapped) {
          swapped = true;
          fs.renameSync(replacement, target);
        }
        return result;
      };
    }
    return handle;
  }) as typeof fs.promises.open);
  return { swapped: () => swapped };
}

async function drain(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const parts: Buffer[] = [];
  for await (const p of stream) parts.push(Buffer.from(p as Buffer));
  return Buffer.concat(parts);
}

const readers: Array<[string, () => Promise<Buffer>]> = [
  ["readAllDecrypted", () => files.readAllDecrypted(target)],
  ["openDecryptStream", async () => drain((await files.openDecryptStream(target)).stream)],
  ["openDecryptStream (range)", async () => drain((await files.openDecryptStream(target, { start: 10, end: 199 })).stream)],
  [
    "decryptToFile",
    async () => {
      const out = path.join(dir, "out.bin");
      await files.decryptToFile(target, out);
      return fs.readFileSync(out);
    },
  ],
];

describe("SW: a swap between the header check and the read never yields ciphertext", () => {
  for (const [name, read] of readers) {
    const expected = name.includes("range") ? PLAIN.subarray(10, 200) : PLAIN;

    itPosix(`${name}: plaintext at the check, encrypted version renamed in → plaintext`, async () => {
      fs.copyFileSync(plainCopy, target);
      const swap = swapAfterFirstRead(encCopy);
      const out = await read();
      expect(swap.swapped()).toBe(true);
      expect(fs.readFileSync(target).subarray(0, MAGIC.length).equals(MAGIC)).toBe(true); // the swap happened
      expect(out.includes(MAGIC)).toBe(false);
      expect(out.equals(expected)).toBe(true);
    });

    itPosix(`${name}: ciphertext at the check, plaintext renamed in → plaintext`, async () => {
      fs.copyFileSync(encCopy, target);
      const swap = swapAfterFirstRead(plainCopy);
      const out = await read();
      expect(swap.swapped()).toBe(true);
      expect(out.equals(expected)).toBe(true);
    });
  }

  itPosix("statPlaintext: size comes from the file that was checked", async () => {
    fs.copyFileSync(encCopy, target);
    swapAfterFirstRead(plainCopy);
    const st = await files.statPlaintext(target);
    expect(st).toEqual({ encrypted: true, size: PLAIN.length });
  });
});
