/**
 * encryption + keyDerivation — crypto correctness guards.
 *
 * The Android companion encrypts every SMS/contact payload with AES-256-GCM
 * (node-forge, pure JS — Hermes has no crypto.subtle) using a key derived from
 * the QR-pairing secret. These tests pin the three properties the transport
 * depends on:
 *   1. round-trip identity  — decrypt(encrypt(x)) === x for real payloads;
 *   2. tamper detection     — any mutation of ciphertext/tag/iv fails the GCM
 *                             auth tag (throws), so a corrupted/forged payload
 *                             can never decrypt to attacker-chosen plaintext;
 *   3. key separation       — the auth token and the encryption key derived
 *                             from the same secret are DIFFERENT values, so a
 *                             leak of one does not reveal the other.
 *
 *   4. large-payload safety — a multi-MB batch (tens of thousands of messages)
 *                             encrypts AND round-trips without throwing, and
 *                             the phone's ciphertext still decrypts with the
 *                             desktop's Node-crypto AES-256-GCM (BACKLOG-2205).
 */

// eslint-disable-next-line @typescript-eslint/no-var-requires
import * as nodeCrypto from 'crypto';
import { encrypt, decrypt } from '../encryption';
import { deriveTransportKeys } from '../keyDerivation';
import type { EncryptedPayload } from '../../types/sync';

// A deterministic 32-byte AES key (0x00..0x1f) for the encryption tests.
const KEY_32 = new Uint8Array(Array.from({ length: 32 }, (_, i) => i));

describe('encryption (AES-256-GCM, node-forge)', () => {
  describe('round-trip identity', () => {
    const payloads = [
      'hello world',
      '',
      JSON.stringify({ messages: [{ sender: '+15551234567', body: 'hi' }] }),
      'unicode: café ☕ 日本語 🔐',
      'line1\nline2\ttabbed',
    ];

    it.each(payloads)('decrypt(encrypt(%j)) === input', async (plaintext) => {
      const enc = await encrypt(plaintext, KEY_32);
      const out = await decrypt(enc, KEY_32);
      expect(out).toBe(plaintext);
    });

    it('produces a random IV — same plaintext encrypts to different ciphertext', async () => {
      const a = await encrypt('same message', KEY_32);
      const b = await encrypt('same message', KEY_32);
      // IV (and therefore ciphertext) must differ; both still decrypt correctly.
      expect(a.iv).not.toBe(b.iv);
      expect(a.encrypted).not.toBe(b.encrypted);
      expect(await decrypt(a, KEY_32)).toBe('same message');
      expect(await decrypt(b, KEY_32)).toBe('same message');
    });
  });

  // BACKLOG-2205 — Fix encryption throw on large payloads.
  //
  // The byte<->forge-string helper used to be
  //   String.fromCharCode.apply(null, [...arr])
  // which passes every byte as a separate argument. Past the JS engine's
  // argument-count limit (~128K bytes of ciphertext on Hermes) this threw
  // `RangeError: Maximum call stack size exceeded` inside decrypt(), dropping
  // the whole SMS/contact batch. These tests pin that large batches now
  // encrypt, round-trip, and stay decryptable by the desktop.
  describe('large payloads (BACKLOG-2205)', () => {
    // GCM is a stream cipher, so ciphertext length == plaintext length. The old
    // threshold was ~128K bytes of ciphertext; straddle it plus a multi-MB case.
    const boundarySizes = [
      100_000, // below the old limit — passed before the fix
      131_072, // 2^17, right at the old arg-count limit — threw before the fix
      262_144, // 256 KB — comfortably past the limit
    ];

    it.each(boundarySizes)(
      'encrypts + round-trips a %d-byte payload without throwing',
      async (n) => {
        const data = 'A'.repeat(n);
        const enc = await encrypt(data, KEY_32);
        const out = await decrypt(enc, KEY_32);
        expect(out).toBe(data);
      }
    );

    it('round-trips a realistic multi-MB batch (40k messages)', async () => {
      const messages = Array.from({ length: 40_000 }, (_, i) => ({
        id: `msg-${i}`,
        sender: `+1555${String(i).padStart(7, '0')}`,
        body: `Message number ${i} — the quick brown fox jumps over the lazy dog. café ☕`,
        timestamp: 1_700_000_000_000 + i,
      }));
      const data = JSON.stringify({ deviceId: 'dev-1', messages });
      // Sanity: this must exceed the old ~128K-byte failure threshold.
      expect(data.length).toBeGreaterThan(2_000_000);

      const enc = await encrypt(data, KEY_32);
      const out = await decrypt(enc, KEY_32);
      expect(out).toBe(data);
    });

    // Wire/crypto compatibility guard: the phone (node-forge) and the desktop
    // (electron/services/localSyncEncryption.ts — Node's built-in crypto) must
    // interoperate. Decrypt a LARGE phone-encrypted payload with the exact
    // Node-crypto AES-256-GCM the desktop uses to prove the fix did not change
    // the wire format.
    it('desktop Node-crypto decrypts a large phone-encrypted payload (compat)', async () => {
      const data = 'Z'.repeat(300_000);
      const enc = await encrypt(data, KEY_32);

      const decipher = nodeCrypto.createDecipheriv(
        'aes-256-gcm',
        Buffer.from(KEY_32),
        Buffer.from(enc.iv, 'hex'),
        { authTagLength: 16 }
      );
      decipher.setAuthTag(Buffer.from(enc.tag, 'hex'));
      const out = Buffer.concat([
        decipher.update(Buffer.from(enc.encrypted, 'hex')),
        decipher.final(),
      ]).toString('utf8');

      expect(out).toBe(data);
    });
  });

  describe('tamper detection (GCM auth tag)', () => {
    /** Flip the first hex nibble of a hex string (guaranteed to mutate it). */
    const flipFirstNibble = (hex: string): string => {
      const first = hex[0];
      const flipped = first === '0' ? '1' : '0';
      return flipped + hex.slice(1);
    };

    it('throws when the ciphertext is tampered', async () => {
      const enc = await encrypt('sensitive payload', KEY_32);
      const tampered: EncryptedPayload = {
        ...enc,
        encrypted: flipFirstNibble(enc.encrypted),
      };
      await expect(decrypt(tampered, KEY_32)).rejects.toThrow(
        /authentication tag mismatch/i
      );
    });

    it('throws when the auth tag is tampered', async () => {
      const enc = await encrypt('sensitive payload', KEY_32);
      const tampered: EncryptedPayload = {
        ...enc,
        tag: flipFirstNibble(enc.tag),
      };
      await expect(decrypt(tampered, KEY_32)).rejects.toThrow(
        /authentication tag mismatch/i
      );
    });

    it('throws when the IV is tampered', async () => {
      const enc = await encrypt('sensitive payload', KEY_32);
      const tampered: EncryptedPayload = {
        ...enc,
        iv: flipFirstNibble(enc.iv),
      };
      await expect(decrypt(tampered, KEY_32)).rejects.toThrow();
    });

    it('throws when decrypting with the wrong key', async () => {
      const enc = await encrypt('sensitive payload', KEY_32);
      const wrongKey = new Uint8Array(KEY_32);
      wrongKey[0] ^= 0xff; // differ by one byte
      await expect(decrypt(enc, wrongKey)).rejects.toThrow(
        /authentication tag mismatch/i
      );
    });
  });

  describe('key length validation', () => {
    it('rejects an encryption key that is not 32 bytes', async () => {
      const shortKey = new Uint8Array(16);
      await expect(encrypt('x', shortKey)).rejects.toThrow(/Invalid key length/);
    });
  });
});

describe('keyDerivation (HMAC-SHA256 domain separation)', () => {
  // A base64-encoded 32-byte secret (all 0xAB) — well over the 16-byte minimum.
  const SECRET_B64 = Buffer.from(new Uint8Array(32).fill(0xab)).toString('base64');

  it('derives an authToken that is NOT equal to the encryptionKey', async () => {
    const { authToken, encryptionKey } = await deriveTransportKeys(SECRET_B64);
    // authToken is a hex string; encryptionKey is raw bytes — compare on hex.
    const encHex = Array.from(encryptionKey)
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
    expect(authToken).not.toBe(encHex);
  });

  it('produces a 32-byte encryption key and a 64-char (32-byte) hex auth token', async () => {
    const { authToken, encryptionKey } = await deriveTransportKeys(SECRET_B64);
    expect(encryptionKey.length).toBe(32);
    expect(authToken).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is deterministic — the same secret always derives the same keys', async () => {
    const a = await deriveTransportKeys(SECRET_B64);
    const b = await deriveTransportKeys(SECRET_B64);
    expect(a.authToken).toBe(b.authToken);
    expect(Array.from(a.encryptionKey)).toEqual(Array.from(b.encryptionKey));
  });

  it('derives a key that actually decrypts a payload it encrypted (end-to-end)', async () => {
    const { encryptionKey } = await deriveTransportKeys(SECRET_B64);
    const enc = await encrypt('paired-device payload', encryptionKey);
    expect(await decrypt(enc, encryptionKey)).toBe('paired-device payload');
  });

  it('rejects a shared secret shorter than 16 bytes', async () => {
    const shortSecret = Buffer.from(new Uint8Array(8)).toString('base64');
    await expect(deriveTransportKeys(shortSecret)).rejects.toThrow(
      /secret too short/i
    );
  });
});
