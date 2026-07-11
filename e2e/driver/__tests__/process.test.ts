/**
 * Unit tests for the E2E launch process helpers (BACKLOG-1886).
 *
 * These NEVER launch the Keepr app or attach to any live process — they exercise port selection,
 * fail-fast, teardown-signal mapping, and real termination against INERT children this test spawns
 * itself (a bare `node` loop). So the founder's dev instance on :9222 is never disturbed.
 *
 * Runs locally via `npm test` (CI `testMatch` scopes to src/**+electron/**; `e2e/tsconfig.json`
 * excludes `__tests__` so `qa:e2e:typecheck` — node-only types — skips this file).
 */
import { type ChildProcess, spawn } from 'node:child_process';
import net from 'node:net';
import {
  getFreePort,
  isPortFree,
  killTargetForPid,
  planTeardownSignals,
  resolveCdpPort,
  terminateChildTree,
} from '../process';

/** Bind an inert listener on an ephemeral port and resolve the port number. */
function listenEphemeral(): Promise<{ server: net.Server; port: number }> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, port: (server.address() as net.AddressInfo).port });
    });
  });
}

function closeServer(server: net.Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

function waitExit(child: ChildProcess, ms = 8000): Promise<void> {
  return new Promise((resolve, reject) => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve();
    const t = setTimeout(() => reject(new Error('child did not exit in time')), ms);
    child.once('exit', () => {
      clearTimeout(t);
      resolve();
    });
  });
}

/**
 * Spawn a detached inert node child that prints "ready" once its signal handlers are installed,
 * and resolve only after that — so a signal can never race the child's startup.
 */
function spawnReady(code: string): Promise<ChildProcess> {
  const child = spawn(process.execPath, ['-e', `${code}; process.stdout.write('ready\\n')`], {
    detached: true,
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  return new Promise((resolve, reject) => {
    const onData = (d: Buffer): void => {
      if (d.toString().includes('ready')) {
        child.stdout?.off('data', onData);
        resolve(child);
      }
    };
    child.stdout?.on('data', onData);
    child.once('error', reject);
  });
}

describe('getFreePort', () => {
  it('returns a usable, currently-free port', async () => {
    const port = await getFreePort();
    expect(port).toBeGreaterThan(0);
    expect(await isPortFree(port)).toBe(true);
  });
});

describe('isPortFree', () => {
  it('reports false while a listener holds the port, true after it closes', async () => {
    const { server, port } = await listenEphemeral();
    expect(await isPortFree(port)).toBe(false);
    await closeServer(server);
    expect(await isPortFree(port)).toBe(true);
  });
});

describe('resolveCdpPort — fail-fast', () => {
  it('returns an ephemeral free port when none is requested', async () => {
    const port = await resolveCdpPort();
    expect(port).toBeGreaterThan(0);
    expect(await isPortFree(port)).toBe(true);
  });

  it('returns the requested port when it is free', async () => {
    const free = await getFreePort();
    expect(await resolveCdpPort(free)).toBe(free);
  });

  it('THROWS when the requested port is already in use (never hijacks a foreign process)', async () => {
    const { server, port } = await listenEphemeral();
    await expect(resolveCdpPort(port)).rejects.toThrow(/already in use/);
    await closeServer(server);
  });
});

describe('planTeardownSignals / killTargetForPid — pure mapping', () => {
  it('escalates to SIGKILL only when the child did not exit within the grace window', () => {
    expect(planTeardownSignals(true)).toEqual(['SIGTERM']);
    expect(planTeardownSignals(false)).toEqual(['SIGTERM', 'SIGKILL']);
  });

  it('targets the process group for a detached child, the bare pid otherwise', () => {
    expect(killTargetForPid(4321, true)).toBe(-4321);
    expect(killTargetForPid(4321, false)).toBe(4321);
  });
});

describe('terminateChildTree — real inert children (no app launch)', () => {
  it('SIGTERMs a well-behaved detached child', async () => {
    const child = await spawnReady('setInterval(() => {}, 1000)');
    const exited = waitExit(child);
    await terminateChildTree(child, { graceMs: 3000 });
    await exited;
    expect(child.signalCode).toBe('SIGTERM');
  });

  it('escalates to SIGKILL for a child that ignores SIGTERM', async () => {
    const child = await spawnReady("process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)");
    const exited = waitExit(child);
    await terminateChildTree(child, { graceMs: 300 });
    await exited;
    expect(child.signalCode).toBe('SIGKILL');
  });

  it('is a no-op for an undefined child', async () => {
    await expect(terminateChildTree(undefined)).resolves.toBeUndefined();
  });
});
