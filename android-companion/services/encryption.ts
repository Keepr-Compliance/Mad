/**
 * Encryption Service (Android Companion)
 * AES-256-GCM encryption/decryption using node-forge.
 *
 * Hermes (React Native JS engine) doesn't have crypto.subtle,
 * so we use node-forge which is pure JS and works everywhere.
 */

import forge from 'node-forge';
import type { EncryptedPayload } from "../types/sync";

const KEY_LENGTH = 32;
const IV_LENGTH = 12;
const TAG_LENGTH = 16;

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.substring(i, i + 2), 16);
  }
  return bytes;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// Max bytes per String.fromCharCode.apply call. The whole-array form
// `String.fromCharCode.apply(null, [...arr])` passes every byte as a separate
// function argument, which exceeds the JS engine's argument-count limit
// (~128K on Hermes) and throws `RangeError: Maximum call stack size exceeded`
// on large sync batches — dropping the whole batch. We convert in fixed chunks
// so arbitrarily large payloads encrypt AND decrypt without throwing.
// (node-forge's own util.binary.raw.encode has the same unguarded apply bug,
// so we cannot delegate to it.) BACKLOG-2205.
const FORGE_CHUNK_SIZE = 8192;

function uint8ToForgeBytes(arr: Uint8Array): string {
  let result = "";
  for (let i = 0; i < arr.length; i += FORGE_CHUNK_SIZE) {
    const chunk = arr.subarray(i, i + FORGE_CHUNK_SIZE);
    result += String.fromCharCode.apply(null, Array.from(chunk));
  }
  return result;
}

function forgeBytesToUint8(str: string): Uint8Array {
  const arr = new Uint8Array(str.length);
  for (let i = 0; i < str.length; i++) {
    arr[i] = str.charCodeAt(i);
  }
  return arr;
}

/**
 * Encrypt a plaintext string using AES-256-GCM.
 */
export async function encrypt(
  data: string,
  encryptionKey: Uint8Array
): Promise<EncryptedPayload> {
  if (encryptionKey.length !== KEY_LENGTH) {
    throw new Error(
      `Invalid key length: expected ${KEY_LENGTH} bytes, got ${encryptionKey.length}`
    );
  }

  // Generate random IV
  const ivBytes = forge.random.getBytesSync(IV_LENGTH);
  const iv = forgeBytesToUint8(ivBytes);

  const cipher = forge.cipher.createCipher(
    'AES-GCM',
    uint8ToForgeBytes(encryptionKey)
  );

  cipher.start({
    iv: ivBytes,
    tagLength: TAG_LENGTH * 8, // bits
  });

  cipher.update(forge.util.createBuffer(forge.util.encodeUtf8(data)));
  cipher.finish();

  const encrypted = forgeBytesToUint8(cipher.output.bytes());
  const tag = forgeBytesToUint8(cipher.mode.tag.bytes());

  return {
    iv: bytesToHex(iv),
    encrypted: bytesToHex(encrypted),
    tag: bytesToHex(tag),
  };
}

/**
 * Decrypt an AES-256-GCM encrypted payload.
 */
export async function decrypt(
  payload: EncryptedPayload,
  encryptionKey: Uint8Array
): Promise<string> {
  if (encryptionKey.length !== KEY_LENGTH) {
    throw new Error(
      `Invalid key length: expected ${KEY_LENGTH} bytes, got ${encryptionKey.length}`
    );
  }

  const iv = hexToBytes(payload.iv);
  const encrypted = hexToBytes(payload.encrypted);
  const tag = hexToBytes(payload.tag);

  if (iv.length !== IV_LENGTH) {
    throw new Error(
      `Invalid IV length: expected ${IV_LENGTH} bytes, got ${iv.length}`
    );
  }

  const decipher = forge.cipher.createDecipher(
    'AES-GCM',
    uint8ToForgeBytes(encryptionKey)
  );

  decipher.start({
    iv: uint8ToForgeBytes(iv),
    tagLength: TAG_LENGTH * 8,
    tag: forge.util.createBuffer(uint8ToForgeBytes(tag)),
  });

  decipher.update(forge.util.createBuffer(uint8ToForgeBytes(encrypted)));
  const pass = decipher.finish();

  if (!pass) {
    throw new Error('Decryption failed: authentication tag mismatch');
  }

  return forge.util.decodeUtf8(decipher.output.bytes());
}
