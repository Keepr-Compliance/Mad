/**
 * Test cipher for the support-access suites (BACKLOG-2393)
 *
 * A *real* AES-256-GCM cipher over a fixed key, not a stub that returns its
 * input. The claim under test is "a client's name is not readable off disk", so
 * a fake that pretends to encrypt would let that claim pass while the product
 * shipped plaintext — which is the exact defect being fixed.
 *
 * The only thing standing in for production is the key source: `keychainGate`
 * needs Electron and a real keychain, so tests inject a constant instead.
 */

import { randomBytes } from "crypto";
import { createAesGcmCipher, type SupportCipher } from "../supportCipher";

/** A cipher with a fresh random key. Two calls cannot read each other's data. */
export function makeTestCipher(): SupportCipher {
  const key = randomBytes(32);
  return createAesGcmCipher(async () => key);
}

/**
 * A cipher whose key provider throws, standing in for a machine that cannot
 * protect data at rest — locked keychain, safeStorage unavailable.
 */
export function makeUnavailableCipher(
  message = "secure storage unavailable",
): SupportCipher {
  return createAesGcmCipher(async () => {
    throw new Error(message);
  });
}
