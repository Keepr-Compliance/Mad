/**
 * LAN address policy (Android Companion) — BACKLOG-2956.
 *
 * ## Why this module exists
 *
 * The companion talks to the desktop over **plain HTTP**, which Android blocks
 * by default from API 28. `plugins/withLanCleartext.js` unblocks it — but only
 * as a blanket `android:usesCleartextTraffic="true"`, because Android's
 * network-security-config has **no CIDR syntax** and the desktop's LAN address
 * is not known at build time. The policy we actually want — *cleartext to the
 * local network and nowhere else* — cannot be written at the OS layer, so it is
 * enforced here instead, in the app, before a request is issued.
 *
 * ## The risk this closes
 *
 * The desktop's address arrives from a **QR code**, i.e. from outside the app.
 * With cleartext permitted app-wide and no check, a QR code naming a public
 * host would make the phone POST SMS bodies and contacts, unencrypted, to
 * whoever printed it. Restricting the destination to private ranges means the
 * blanket manifest flag cannot be turned outward.
 *
 * ## Ranges permitted (and only these)
 *
 *   10.0.0.0/8       RFC 1918 private
 *   172.16.0.0/12    RFC 1918 private
 *   192.168.0.0/16   RFC 1918 private
 *   169.254.0.0/16   RFC 3927 link-local (Wi-Fi Direct / ad-hoc)
 *   127.0.0.0/8      loopback (emulator + on-device testing)
 *
 * ## Known limitation — recorded, not overlooked
 *
 * The desktop picks its address with `getLocalNetworkIP()`
 * (`electron/services/localSyncService.ts`), which returns the FIRST
 * non-internal IPv4 with no range filter. A desktop whose first such address is
 * CGNAT (100.64.0.0/10 — Tailscale and some ISPs) or a real public IPv4 will be
 * REFUSED here where it was previously attempted. That is a deliberate
 * trade-off: such a setup cannot have worked dependably anyway, and the failure
 * is now explicit and explained rather than a silent cleartext leak. If a real
 * user hits it, the fix is to filter/choose the interface desktop-side, not to
 * widen this list.
 */

/** A permitted range, kept as a predicate over the four parsed octets. */
interface LanRange {
  readonly label: string;
  readonly matches: (octets: readonly number[]) => boolean;
}

const PERMITTED_RANGES: readonly LanRange[] = [
  { label: '10.0.0.0/8', matches: (o) => o[0] === 10 },
  { label: '172.16.0.0/12', matches: (o) => o[0] === 172 && o[1] >= 16 && o[1] <= 31 },
  { label: '192.168.0.0/16', matches: (o) => o[0] === 192 && o[1] === 168 },
  { label: '169.254.0.0/16', matches: (o) => o[0] === 169 && o[1] === 254 },
  { label: '127.0.0.0/8', matches: (o) => o[0] === 127 },
];

/**
 * Parse a dotted-quad IPv4 literal into its four octets.
 *
 * Deliberately strict. `Number()` on "192.168.01.1" or " 192.168.0.1" would
 * succeed and let a non-canonical form through, and Android/Java may resolve
 * such a form to a DIFFERENT address than this check reasoned about — so the
 * digits are validated by shape first, then by range.
 *
 * @returns the four octets, or null if `value` is not a canonical IPv4 literal.
 */
function parseIPv4(value: string): number[] | null {
  const parts = value.split('.');
  if (parts.length !== 4) return null;

  const octets: number[] = [];
  for (const part of parts) {
    // Canonical decimal only: 1-3 digits, no sign, no whitespace, no leading
    // zero (which some resolvers read as OCTAL).
    if (!/^(0|[1-9][0-9]{0,2})$/.test(part)) return null;
    const n = Number(part);
    if (n > 255) return null;
    octets.push(n);
  }
  return octets;
}

/**
 * Is `address` an IPv4 literal inside one of the permitted private ranges?
 *
 * Anything that is not a canonical IPv4 literal is REFUSED — including
 * hostnames and IPv6. That is intentional: the desktop always advertises a
 * dotted-quad, so a non-literal here means the payload did not come from a
 * Keepr desktop, and a hostname could resolve anywhere.
 */
export function isPrivateLanIPv4(address: string): boolean {
  const octets = parseIPv4(address.trim());
  if (!octets) return false;
  return PERMITTED_RANGES.some((range) => range.matches(octets));
}

/** The range labels, for messages and tests. Order matches PERMITTED_RANGES. */
export const PERMITTED_RANGE_LABELS: readonly string[] =
  PERMITTED_RANGES.map((r) => r.label);

export interface LanAddressRejection {
  title: string;
  body: string;
}

/**
 * The user-facing refusal for an out-of-range desktop address.
 *
 * Deliberately NOT the reachability copy ("make sure you're on the same Wi-Fi
 * network"): this failure has nothing to do with Wi-Fi, and rendering a known
 * specific cause as a wrong generic message is the defect class of
 * BACKLOG-2913. Retrying changes nothing, so no retry is offered.
 */
export function lanAddressRejectionMessage(address: string): LanAddressRejection {
  return {
    title: 'Not a Local Network Address',
    body:
      `This QR code points at ${address}, which is not on a local network. ` +
      'Keepr only syncs to a computer on your own Wi-Fi or wired network. ' +
      'Scan the QR code shown in the Keepr desktop app on your own computer.',
  };
}
