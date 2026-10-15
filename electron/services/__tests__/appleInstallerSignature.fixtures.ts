/**
 * BACKLOG-3806 fixtures: what SIGCHECK_SCRIPT prints.
 *
 * Source of each field:
 * - Subject: the signer certificate of AppleMobileDeviceSupport64.msi, extracted
 *   with 7-Zip from Apple's iTunes64Setup.exe downloaded 2026-10-08
 *   (MSI sha256 b4ce042947e9d72c0d7eb2d0d719408d45c932694ee0920680db0dc638d79adb).
 *   `openssl pkcs7 -print_certs` on the MSI's signature prints
 *   "C=US, ST=California, L=Cupertino, O=Apple Inc., CN=Apple Inc."; below it
 *   is written in the reversed order .NET's X509Certificate.Subject uses, with
 *   "S=" for the state. That Windows rendering is UNVERIFIED until the PC check
 *   in BACKLOG-3806's handoff replaces it with real output.
 * - Thumbprint: SHA-1 of that same certificate (openssl x509 -fingerprint -sha1).
 * - Status values: names of System.Management.Automation.SignatureStatus.
 */

export const APPLE_SUBJECT_WINDOWS =
  "CN=Apple Inc., O=Apple Inc., L=Cupertino, S=California, C=US";

export const APPLE_THUMBPRINT = "5ABF5D5265D74C9EAD19246DFAB611AA5DCFE791";

export const VALID_APPLE = {
  Status: "Valid",
  StatusMessage: "Signature verified.",
  Subject: APPLE_SUBJECT_WINDOWS,
  Thumbprint: APPLE_THUMBPRINT,
};

/** A file whose bytes changed after Apple signed it. */
export const HASH_MISMATCH_APPLE = {
  Status: "HashMismatch",
  StatusMessage:
    "The contents of file might have been changed by an unauthorized user or process, because the hash of the file does not match the hash stored in the digital signature.",
  Subject: APPLE_SUBJECT_WINDOWS,
  Thumbprint: APPLE_THUMBPRINT,
};

/** An Apple-looking certificate that does not chain to a trusted root. */
export const NOT_TRUSTED_APPLE = {
  Status: "NotTrusted",
  StatusMessage:
    "A certificate chain processed, but terminated in a root certificate which is not trusted by the trust provider.",
  Subject: APPLE_SUBJECT_WINDOWS,
  Thumbprint: "0000000000000000000000000000000000000000",
};

/** No signature at all: SignerCertificate is null. */
export const NOT_SIGNED = {
  Status: "NotSigned",
  StatusMessage: "The file is not digitally signed.",
  Subject: null,
  Thumbprint: null,
};

/** Validly signed, by someone else. */
export const VALID_OTHER_SIGNER = {
  Status: "Valid",
  StatusMessage: "Signature verified.",
  Subject: "CN=Contoso Ltd, O=Contoso Ltd, L=Redmond, S=Washington, C=US",
  Thumbprint: "1111111111111111111111111111111111111111",
};
