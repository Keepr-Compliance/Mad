/**
 * Key Derivation Service (Android Companion)
 * Derives separate auth token and encryption key from the shared pairing secret.
 *
 * Uses node-forge for HMAC-SHA256 (Hermes doesn't have crypto.subtle).
 */

import forge from 'node-forge';

function base64ToBytes(base64: string): Uint8Array {
  const binary = forge.util.decode64(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/**
 * Derive separate auth token and encryption key from the shared secret.
 *
 * - authToken:     HMAC-SHA256(secret, "auth")       -> hex string
 * - encryptionKey: HMAC-SHA256(secret, "encryption")  -> Uint8Array (32 bytes)
 */
export async function deriveTransportKeys(secretBase64: string): Promise<{
  authToken: string;
  encryptionKey: Uint8Array;
}> {
  const secretBytes = base64ToBytes(secretBase64);
  if (secretBytes.length < 16) {
    throw new Error(
      `Shared secret too short: expected at least 16 bytes, got ${secretBytes.length}`
    );
  }

  const secretBinary = forge.util.binary.raw.encode(secretBytes);

  // Derive auth token: HMAC-SHA256(secret, "auth") -> hex
  const authHmac = forge.hmac.create();
  authHmac.start('sha256', secretBinary);
  authHmac.update('auth');
  const authToken = authHmac.digest().toHex();

  // Derive encryption key: HMAC-SHA256(secret, "encryption") -> 32 bytes
  const encHmac = forge.hmac.create();
  encHmac.start('sha256', secretBinary);
  encHmac.update('encryption');
  const encBytes = encHmac.digest().bytes();
  const encryptionKey = new Uint8Array(encBytes.length);
  for (let i = 0; i < encBytes.length; i++) {
    encryptionKey[i] = encBytes.charCodeAt(i);
  }

  return { authToken, encryptionKey };
}
