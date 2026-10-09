/**
 * @jest-environment node
 */
/**
 * BACKLOG-3816 S0 — KEPRENC v1 container.
 *
 * Controls in this file:
 *   F1  tampered byte / truncated final chunk / swapped chunks / flipped header
 *       → refused, and no plaintext of the damaged chunk is emitted.
 *   F2  every Range read equals the same slice of the plaintext (swept, not sampled).
 *   M3  encryptFileInPlace verifies the encrypted copy BEFORE it replaces the source.
 */
import crypto from "crypto";
import fs from "fs";
import os from "os";
import path from "path";
import { Readable } from "stream";

import {
  AtRestFormatError,
  AtRestIntegrityError,
  HEADER_BYTES,
  TAG_BYTES,
  KENC_TMP_SUFFIX,
  createFileCrypto,
  layoutFor,
  type KeyResolver,
} from "../fileCrypto";

const KEY = crypto.randomBytes(32);
const KEY_ID = crypto.randomBytes(16).toString("hex");
const CHUNK = 64; // small chunks so multi-chunk paths are exercised with small fixtures

function resolver(overrides: Partial<KeyResolver> = {}): KeyResolver {
  return {
    currentKey: async () => ({ keyId: KEY_ID, key: KEY }),
    keyFor: async (id) => {
      if (id !== KEY_ID) throw new Error("unknown key");
      return KEY;
    },
    ...overrides,
  };
}

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "keepr-atrest-fc-"));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

async function collect(stream: Readable): Promise<{ data: Buffer; error: Error | null }> {
  const parts: Buffer[] = [];
  try {
    for await (const piece of stream) parts.push(piece as Buffer);
    return { data: Buffer.concat(parts), error: null };
  } catch (error) {
    return { data: Buffer.concat(parts), error: error as Error };
  }
}

async function encryptBytes(plaintext: Buffer, name = "f.bin", chunkSize = CHUNK): Promise<string> {
  const fc = createFileCrypto(resolver(), { chunkSize });
  const dest = path.join(dir, name);
  await fc.encryptStreamToFile(Readable.from([plaintext]), dest);
  return dest;
}

describe("KEPRENC round trip", () => {
  const sizes = [0, 1, CHUNK - 1, CHUNK, CHUNK + 1, 2 * CHUNK, 2 * CHUNK + 1, 5 * CHUNK + 17];

  it.each(sizes)("round-trips %i bytes with the size derivable from the file", async (n) => {
    const plaintext = crypto.randomBytes(n);
    const file = await encryptBytes(plaintext);
    const fc = createFileCrypto(resolver());
    expect(await fc.isEncrypted(file)).toBe(true);
    expect(await fc.readAllDecrypted(file)).toEqual(plaintext);
    expect(await fc.statPlaintext(file)).toEqual({ encrypted: true, size: n });
    const chunks = Math.max(1, Math.ceil(n / CHUNK));
    expect(fs.statSync(file).size).toBe(HEADER_BYTES + n + chunks * TAG_BYTES);
    // The ciphertext does not contain the plaintext.
    if (n >= 16) expect(fs.readFileSync(file).includes(plaintext.subarray(0, 16))).toBe(false);
  });

  it("splits input arriving in uneven pieces into the same file layout", async () => {
    const plaintext = crypto.randomBytes(3 * CHUNK + 5);
    const pieces = [plaintext.subarray(0, 7), plaintext.subarray(7, 150), plaintext.subarray(150)];
    const fc = createFileCrypto(resolver(), { chunkSize: CHUNK });
    const dest = path.join(dir, "pieces.bin");
    const result = await fc.encryptStreamToFile(Readable.from(pieces), dest);
    expect(result.plaintextSize).toBe(plaintext.length);
    expect(result.sha256).toBe(crypto.createHash("sha256").update(plaintext).digest("hex"));
    expect(await fc.readAllDecrypted(dest)).toEqual(plaintext);
  });

  it("the empty file still carries a final-chunk tag", async () => {
    const file = await encryptBytes(Buffer.alloc(0));
    expect(fs.statSync(file).size).toBe(HEADER_BYTES + TAG_BYTES);
    // Cut the tag: the file is now malformed, not "empty".
    fs.truncateSync(file, HEADER_BYTES);
    await expect(createFileCrypto(resolver()).readAllDecrypted(file)).rejects.toBeInstanceOf(AtRestFormatError);
  });

  it("passes plaintext files through, flagged encrypted:false", async () => {
    const file = path.join(dir, "plain.txt");
    fs.writeFileSync(file, "hello plaintext");
    const fc = createFileCrypto(resolver());
    expect(await fc.isEncrypted(file)).toBe(false);
    const opened = await fc.openDecryptStream(file, { start: 6, end: 10 });
    expect(opened.encrypted).toBe(false);
    expect((await collect(opened.stream)).data.toString()).toBe("plain");
    expect(await fc.statPlaintext(file)).toEqual({ encrypted: false, size: 15 });
  });

  it("leaves no temp file behind and refuses a key it does not hold", async () => {
    const file = await encryptBytes(crypto.randomBytes(100));
    expect(fs.readdirSync(dir).filter((f) => f.endsWith(KENC_TMP_SUFFIX))).toEqual([]);
    const other = createFileCrypto(resolver({ keyFor: async () => crypto.randomBytes(32) }));
    await expect(other.readAllDecrypted(file)).rejects.toBeInstanceOf(AtRestIntegrityError);
  });

  it("layoutFor rejects impossible sizes", () => {
    expect(() => layoutFor(HEADER_BYTES + 15, CHUNK)).toThrow(AtRestFormatError);
    // one full chunk + a 10-byte tail (shorter than a tag)
    expect(() => layoutFor(HEADER_BYTES + CHUNK + TAG_BYTES + 10, CHUNK)).toThrow(AtRestFormatError);
    expect(layoutFor(HEADER_BYTES + TAG_BYTES, CHUNK)).toEqual({ chunkCount: 1, plaintextSize: 0 });
  });
});

describe("F1 — damage is refused before its plaintext is emitted", () => {
  const plaintext = Buffer.from(
    Array.from({ length: 4 * CHUNK + 10 }, (_, i) => String.fromCharCode(65 + (i % 26))).join(""),
  );
  const stride = CHUNK + TAG_BYTES;

  async function streamAll(file: string) {
    const fc = createFileCrypto(resolver());
    const { stream } = await fc.openDecryptStream(file);
    return collect(stream);
  }

  it("a single flipped ciphertext byte in chunk 2: chunks 0-1 emitted, nothing of chunk 2", async () => {
    const file = await encryptBytes(plaintext);
    const buf = fs.readFileSync(file);
    buf[HEADER_BYTES + 2 * stride + 3] ^= 0x01;
    fs.writeFileSync(file, buf);

    const { data, error } = await streamAll(file);
    expect(error).toBeInstanceOf(AtRestIntegrityError);
    expect(data).toEqual(plaintext.subarray(0, 2 * CHUNK));
    await expect(createFileCrypto(resolver()).readAllDecrypted(file)).rejects.toBeInstanceOf(AtRestIntegrityError);
  });

  it("a single-chunk file with a flipped byte emits zero bytes", async () => {
    const small = Buffer.from("secret customer text");
    const file = await encryptBytes(small);
    const buf = fs.readFileSync(file);
    buf[HEADER_BYTES + 1] ^= 0x80;
    fs.writeFileSync(file, buf);
    const { data, error } = await streamAll(file);
    expect(error).toBeInstanceOf(AtRestIntegrityError);
    expect(data.length).toBe(0);
  });

  it("truncation at a chunk boundary (final chunk dropped) is refused", async () => {
    const file = await encryptBytes(plaintext);
    // 5 chunks: drop the final one entirely, leaving 4 full chunks that look complete.
    fs.truncateSync(file, HEADER_BYTES + 4 * stride);
    const { data, error } = await streamAll(file);
    expect(error).toBeInstanceOf(AtRestIntegrityError);
    expect(data).toEqual(plaintext.subarray(0, 3 * CHUNK));
    await expect(createFileCrypto(resolver()).readAllDecrypted(file)).rejects.toBeInstanceOf(AtRestIntegrityError);
  });

  it("truncation inside the final chunk is refused", async () => {
    const file = await encryptBytes(plaintext);
    fs.truncateSync(file, fs.statSync(file).size - 3);
    await expect(createFileCrypto(resolver()).readAllDecrypted(file)).rejects.toBeInstanceOf(AtRestIntegrityError);
  });

  it("two swapped chunks are refused at the first swapped chunk", async () => {
    const file = await encryptBytes(plaintext);
    const buf = fs.readFileSync(file);
    const c1 = Buffer.from(buf.subarray(HEADER_BYTES + stride, HEADER_BYTES + 2 * stride));
    const c2 = Buffer.from(buf.subarray(HEADER_BYTES + 2 * stride, HEADER_BYTES + 3 * stride));
    c2.copy(buf, HEADER_BYTES + stride);
    c1.copy(buf, HEADER_BYTES + 2 * stride);
    fs.writeFileSync(file, buf);
    const { data, error } = await streamAll(file);
    expect(error).toBeInstanceOf(AtRestIntegrityError);
    expect(data).toEqual(plaintext.subarray(0, CHUNK));
  });

  it("a flipped salt byte in the header fails every chunk", async () => {
    const file = await encryptBytes(plaintext);
    const buf = fs.readFileSync(file);
    buf[30] ^= 0x01;
    fs.writeFileSync(file, buf);
    const { data, error } = await streamAll(file);
    expect(error).toBeInstanceOf(AtRestIntegrityError);
    expect(data.length).toBe(0);
  });

  it("a header claiming an oversized chunk is refused before any read", async () => {
    const file = await encryptBytes(plaintext);
    const buf = fs.readFileSync(file);
    buf.writeUInt32BE(0x7fffffff, 44);
    fs.writeFileSync(file, buf);
    await expect(createFileCrypto(resolver()).openDecryptStream(file)).rejects.toBeInstanceOf(AtRestFormatError);
  });

  it("decryptToFile writes nothing at the destination when a chunk fails", async () => {
    const file = await encryptBytes(plaintext);
    const buf = fs.readFileSync(file);
    buf[buf.length - 1] ^= 0x01;
    fs.writeFileSync(file, buf);
    const dest = path.join(dir, "out", "plain.bin");
    await expect(createFileCrypto(resolver()).decryptToFile(file, dest)).rejects.toBeInstanceOf(AtRestIntegrityError);
    expect(fs.existsSync(dest)).toBe(false);
    expect(fs.readdirSync(path.dirname(dest))).toEqual([]);
  });
});

describe("F2 — Range reads equal the plaintext slice", () => {
  it("every (start, end) pair over a 3½-chunk file", async () => {
    const plaintext = crypto.randomBytes(3 * CHUNK + CHUNK / 2);
    const file = await encryptBytes(plaintext);
    const fc = createFileCrypto(resolver());
    const n = plaintext.length;
    // Sweep: every start, every end at and around each chunk boundary plus the tail.
    const ends = new Set<number>();
    for (let b = 0; b <= n; b += CHUNK) for (const d of [-2, -1, 0, 1]) ends.add(b + d);
    ends.add(n - 1);
    let checked = 0;
    for (let start = 0; start < n; start++) {
      for (const end of ends) {
        if (end < start || end >= n) continue;
        const opened = await fc.openDecryptStream(file, { start, end });
        const { data, error } = await collect(opened.stream);
        expect(error).toBeNull();
        if (!data.equals(plaintext.subarray(start, end + 1))) {
          throw new Error(`range ${start}-${end} mismatched`);
        }
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(1000);
  });

  it("decryptToFile produces the plaintext", async () => {
    const plaintext = crypto.randomBytes(2 * CHUNK + 3);
    const file = await encryptBytes(plaintext);
    const dest = path.join(dir, "out.bin");
    const result = await createFileCrypto(resolver()).decryptToFile(file, dest);
    expect(result).toEqual({ size: plaintext.length, encrypted: true });
    expect(fs.readFileSync(dest)).toEqual(plaintext);
  });

  it("an end past EOF is clamped; a start past EOF is a RangeError", async () => {
    const plaintext = crypto.randomBytes(100);
    const file = await encryptBytes(plaintext);
    const fc = createFileCrypto(resolver());
    const opened = await fc.openDecryptStream(file, { start: 90, end: 10_000 });
    expect(opened.end).toBe(99);
    expect((await collect(opened.stream)).data).toEqual(plaintext.subarray(90));
    await expect(fc.openDecryptStream(file, { start: 100 })).rejects.toBeInstanceOf(RangeError);
  });
});

describe("M3 — encryptFileInPlace verifies before it replaces the source", () => {
  it("encrypts in place and is idempotent", async () => {
    const file = path.join(dir, "att.jpg");
    const plaintext = crypto.randomBytes(5 * CHUNK + 1);
    fs.writeFileSync(file, plaintext);
    const fc = createFileCrypto(resolver(), { chunkSize: CHUNK });
    const first = await fc.encryptFileInPlace(file);
    expect(first.alreadyEncrypted).toBe(false);
    expect(first.sha256).toBe(crypto.createHash("sha256").update(plaintext).digest("hex"));
    const sealed = fs.readFileSync(file);
    const second = await fc.encryptFileInPlace(file);
    expect(second.alreadyEncrypted).toBe(true);
    expect(fs.readFileSync(file)).toEqual(sealed); // not double-encrypted
    expect(await fc.readAllDecrypted(file)).toEqual(plaintext);
  });

  it("when the round-trip check fails, the source is byte-identical and no temp remains", async () => {
    const file = path.join(dir, "att.jpg");
    const plaintext = crypto.randomBytes(3 * CHUNK);
    fs.writeFileSync(file, plaintext);
    // The verify step resolves the key from the header; hand it the wrong key so the
    // encrypted copy cannot be proven to decrypt to the source.
    const lying = createFileCrypto(resolver({ keyFor: async () => crypto.randomBytes(32) }), {
      chunkSize: CHUNK,
    });
    await expect(lying.encryptFileInPlace(file)).rejects.toBeInstanceOf(AtRestIntegrityError);
    expect(fs.readFileSync(file)).toEqual(plaintext);
    expect(fs.readdirSync(dir)).toEqual(["att.jpg"]);
  });
});

describe("F3 — every encryption draws a fresh salt (so a fresh per-file key)", () => {
  // A constant salt gives every file the same AES key with the same chunk-index
  // nonces: GCM keystream reuse across files. Same key + same plaintext must
  // therefore never produce the same salt or the same ciphertext.
  const SALT = [28, 44] as const;
  const plaintext = crypto.randomBytes(CHUNK * 2 + 9);
  const saltOf = (file: string) => fs.readFileSync(file).subarray(...SALT);
  const firstChunkOf = (file: string) => fs.readFileSync(file).subarray(HEADER_BYTES, HEADER_BYTES + CHUNK);

  function expectDistinct(a: string, b: string) {
    expect(saltOf(a).equals(saltOf(b))).toBe(false);
    expect(firstChunkOf(a).equals(firstChunkOf(b))).toBe(false);
  }

  it("encryptStreamToFile: two encryptions of the same plaintext differ in salt and ciphertext", async () => {
    const a = await encryptBytes(plaintext, "a.bin");
    const b = await encryptBytes(plaintext, "b.bin");
    expectDistinct(a, b);
  });

  it("encryptFileInPlace: two copies of the same plaintext differ in salt and ciphertext", async () => {
    const fc = createFileCrypto(resolver(), { chunkSize: CHUNK });
    const a = path.join(dir, "a.txt");
    const b = path.join(dir, "b.txt");
    fs.writeFileSync(a, plaintext);
    fs.writeFileSync(b, plaintext);
    await fc.encryptFileInPlace(a);
    await fc.encryptFileInPlace(b);
    expectDistinct(a, b);
  });

  it("re-encrypting a file in place (decrypt, then encrypt again) gets a fresh salt", async () => {
    const fc = createFileCrypto(resolver(), { chunkSize: CHUNK });
    const file = path.join(dir, "f.txt");
    fs.writeFileSync(file, plaintext);
    await fc.encryptFileInPlace(file);
    const first = path.join(dir, "first.bin");
    fs.copyFileSync(file, first);
    await fc.decryptToFile(file, file);
    expect(fs.readFileSync(file).equals(plaintext)).toBe(true);
    await fc.encryptFileInPlace(file);
    expectDistinct(first, file);
    expect((await fc.readAllDecrypted(file)).equals(plaintext)).toBe(true);
  });
});

describe("requireEncrypted — opt-in refusal of plaintext pass-through", () => {
  it("default: a plaintext file is passed through", async () => {
    const file = path.join(dir, "plain.txt");
    fs.writeFileSync(file, "still plaintext");
    const r = await createFileCrypto(resolver()).openDecryptStream(file);
    expect(r.encrypted).toBe(false);
    expect((await collect(r.stream)).data.toString()).toBe("still plaintext");
  });

  it("requireEncrypted: a plaintext file is refused with AtRestFormatError", async () => {
    const file = path.join(dir, "plain.txt");
    fs.writeFileSync(file, "still plaintext");
    await expect(
      createFileCrypto(resolver()).openDecryptStream(file, { requireEncrypted: true }),
    ).rejects.toBeInstanceOf(AtRestFormatError);
  });

  it("requireEncrypted: an encrypted file still opens", async () => {
    const file = await encryptBytes(Buffer.from("sealed text"));
    const r = await createFileCrypto(resolver()).openDecryptStream(file, { requireEncrypted: true });
    expect(r.encrypted).toBe(true);
    expect((await collect(r.stream)).data.toString()).toBe("sealed text");
  });
});
