/**
 * BACKLOG-3284 — the guard's own control suite. See ../install.js for the design.
 *
 * These are POSITIVE controls: they PASS while the guard is healthy and go RED the
 * moment it is weakened or removed. The red-by-design cases live in
 * ../__fixtures__/*.fixture.js and are driven as a subprocess by
 * netGuard.redproof.test.js — a test file that is itself red cannot be tracked.
 *
 * Never assert on the error MESSAGE. Under jsdom the marker becomes "Network Error";
 * under @jest-environment node / undici it becomes "fetch failed". Assert on
 * err.code and on the record.
 *
 * Hosts: example.invalid (RFC 6761, guaranteed NXDOMAIN) and 192.0.2.1 (TEST-NET-1,
 * unroutable). If the guard were broken mid-test the worst available outcome is a
 * failed DNS lookup.
 */
const net = require('net');
const http = require('http');

const consume = () => global.__KEEPR_NET_CONSUME__() || [];

describe('net guard — installed and intercepting', () => {
  test('the guard is installed on net.Socket.prototype.connect', () => {
    expect(net.Socket.prototype.connect.__keeprNetGuard).toBe(true);
    expect(typeof global.__KEEPR_NET_CONSUME__).toBe('function');
  });

  test('http.request is blocked synchronously, with the guard code and a record', () => {
    let err = null;
    try { http.request('http://example.invalid/x').end(); } catch (e) { err = e; }
    const recorded = consume();
    expect(err && err.code).toBe('KEEPR_NET_GUARD_BLOCKED');
    expect(recorded.map((r) => `${r.host}:${r.port}`)).toEqual(['example.invalid:80']);
  });

  test("net.connect's ARRAY argument form is parsed (regression: guard failed OPEN)", () => {
    let err = null;
    try { net.connect({ host: '192.0.2.1', port: 443 }); } catch (e) { err = e; }
    const recorded = consume();
    expect(err && err.code).toBe('KEEPR_NET_GUARD_BLOCKED');
    expect(recorded.map((r) => `${r.host}:${r.port}`)).toEqual(['192.0.2.1:443']);
  });

  test('an address this host owns is allowed — a local server round-trips', async () => {
    const server = http.createServer((_req, res) => res.end('ok'));
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const { port } = server.address();
    const body = await new Promise((res, rej) => {
      const r = http.request({ host: '127.0.0.1', port, path: '/' }, (resp) => {
        let d = ''; resp.on('data', (c) => (d += c)); resp.on('end', () => res(d));
      });
      r.on('error', rej); r.end();
    });
    server.close();
    expect(body).toBe('ok');
    expect(consume()).toEqual([]);
  });

  test('consume clears the durable record too, so the backstop does not re-report', () => {
    try { http.request('http://example.invalid/y').end(); } catch (_) { /* expected */ }
    expect(consume().length).toBe(1);
    expect(consume()).toEqual([]);
  });
});

// Explicit CommonJS module: keeps top-level names out of the global TypeScript
// declaration space (tsconfig.test.json includes tests/**). See ../install.js.
module.exports = {};
