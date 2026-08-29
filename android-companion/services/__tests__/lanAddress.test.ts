/**
 * BACKLOG-2956 — the app permits cleartext HTTP app-wide (Android's
 * network-security-config has no CIDR syntax, so the OS cannot scope it to the
 * LAN). `lanAddress` is where that scoping actually happens, so these tests are
 * the only place the "private ranges only" requirement is enforced at all.
 *
 * Boundaries are SWEPT, not sampled: every range is probed at the octet either
 * side of each edge. One address per range cannot catch an off-by-one, and an
 * off-by-one here either bricks pairing for real users (too narrow) or lets SMS
 * bodies go to a public host in cleartext (too wide).
 */

import {
  isPrivateLanIPv4,
  lanAddressRejectionMessage,
  PERMITTED_RANGE_LABELS,
} from '../lanAddress';

describe('isPrivateLanIPv4 — permitted ranges', () => {
  it.each([
    // 10.0.0.0/8
    ['10.0.0.0', '10/8 first'],
    ['10.255.255.255', '10/8 last'],
    ['10.0.0.233', 'typical'],
    // 172.16.0.0/12
    ['172.16.0.0', '172.16/12 first'],
    ['172.31.255.255', '172.16/12 last'],
    ['172.20.5.1', 'mid'],
    // 192.168.0.0/16
    ['192.168.0.0', '192.168/16 first'],
    ['192.168.255.255', '192.168/16 last'],
    ['192.168.0.233', "the founder's desktop shape"],
    // 169.254.0.0/16 link-local
    ['169.254.0.0', 'link-local first'],
    ['169.254.255.255', 'link-local last'],
    // loopback
    ['127.0.0.1', 'loopback'],
    ['127.255.255.255', 'loopback last'],
  ])('permits %s (%s)', (address) => {
    expect(isPrivateLanIPv4(address)).toBe(true);
  });
});

describe('isPrivateLanIPv4 — refused, one octet outside each edge', () => {
  it.each([
    // Immediately below / above 10/8
    ['9.255.255.255', 'below 10/8'],
    ['11.0.0.0', 'above 10/8'],
    // 172.16/12 is NOT all of 172/8 — this is the classic off-by-one
    ['172.15.255.255', 'below 172.16/12'],
    ['172.32.0.0', 'above 172.16/12'],
    ['172.0.0.1', 'inside 172/8 but outside 172.16/12'],
    ['172.255.255.255', 'top of 172/8, outside 172.16/12'],
    // 192.168/16 is NOT all of 192/8
    ['192.167.255.255', 'below 192.168/16'],
    ['192.169.0.0', 'above 192.168/16'],
    ['192.0.2.1', 'TEST-NET-1, public-documentation space'],
    // 169.254/16 is NOT all of 169/8
    ['169.253.255.255', 'below link-local'],
    ['169.255.0.0', 'above link-local'],
    // Loopback edge
    ['126.255.255.255', 'below loopback'],
    ['128.0.0.0', 'above loopback'],
    // CGNAT — deliberately NOT permitted; see the module's limitation note
    ['100.64.0.0', 'CGNAT first'],
    ['100.100.100.100', 'CGNAT / Tailscale'],
    ['100.127.255.255', 'CGNAT last'],
    // Ordinary public addresses
    ['8.8.8.8', 'public resolver'],
    ['203.0.113.7', 'TEST-NET-3'],
    ['0.0.0.0', 'unspecified'],
    ['255.255.255.255', 'broadcast'],
  ])('refuses %s (%s)', (address) => {
    expect(isPrivateLanIPv4(address)).toBe(false);
  });
});

describe('isPrivateLanIPv4 — refuses anything that is not a canonical IPv4 literal', () => {
  it.each([
    // A hostname could resolve anywhere, including off-LAN.
    ['keepr.example.com', 'hostname'],
    ['localhost', 'hostname that looks safe'],
    // Leading zeros are read as OCTAL by some resolvers: 0300.0250.0.1 is
    // 192.168.0.1, and 010.0.0.1 is 8.0.0.1 — a check that accepted these
    // would be reasoning about a different address than the one dialled.
    ['010.0.0.1', 'octal-looking leading zero'],
    ['192.168.000.1', 'padded octet'],
    // Out-of-range / malformed octets.
    ['192.168.0.256', 'octet > 255'],
    ['192.168.0', 'three octets'],
    ['192.168.0.1.5', 'five octets'],
    ['192.168.0.-1', 'negative'],
    ['192.168.0.1a', 'trailing garbage'],
    ['', 'empty'],
    // Integer / hex forms that resolvers accept but this check must not.
    ['3232235777', 'bare integer form of 192.168.0.1'],
    ['0xC0.0xA8.0.1', 'hex octets'],
    // IPv6 — the desktop never advertises one.
    ['::1', 'IPv6 loopback'],
    ['fe80::1', 'IPv6 link-local'],
  ])('refuses %s (%s)', (address) => {
    expect(isPrivateLanIPv4(address)).toBe(false);
  });

  it('tolerates surrounding whitespace on an otherwise canonical literal', () => {
    expect(isPrivateLanIPv4('  192.168.0.233  ')).toBe(true);
  });
});

describe('the four ranges the security posture promises are the ones enforced', () => {
  it('permits exactly the documented ranges, plus loopback', () => {
    // Asserts the SET, not a count — a range silently dropped or a wider one
    // silently added both fail here.
    expect([...PERMITTED_RANGE_LABELS].sort()).toEqual(
      [
        '10.0.0.0/8',
        '127.0.0.0/8',
        '169.254.0.0/16',
        '172.16.0.0/12',
        '192.168.0.0/16',
      ].sort(),
    );
  });
});

describe('lanAddressRejectionMessage', () => {
  it('names the offending address and does NOT blame Wi-Fi', () => {
    const { title, body } = lanAddressRejectionMessage('8.8.8.8');
    expect(body).toContain('8.8.8.8');
    expect(title).toBe('Not a Local Network Address');
    // BACKLOG-2913 class: a known specific cause must not render as the
    // generic reachability message. "same Wi-Fi network" is that message's
    // signature phrase and must never appear here.
    expect(body).not.toMatch(/same Wi-Fi network/i);
  });
});
