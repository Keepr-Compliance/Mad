import type { ChildProcess } from 'node:child_process';
import net from 'node:net';

/**
 * Port selection + process-teardown helpers for the E2E launch layer (BACKLOG-1886).
 *
 * Node-only (no Playwright import) so it is unit-testable in jest WITHOUT launching the app or
 * attaching to any live process. See PR #1868 SR review I-2 / S-2 for the hazards these fix:
 *   - the CDP port must default to a FREE ephemeral port and fail-fast if a requested port is
 *     already open, so `connectOverCDP` can never hijack a foreign process (e.g. a dev Electron
 *     instance the founder machine routinely runs on 9222);
 *   - teardown must SIGTERM then SIGKILL-fallback the spawned PID tree ONLY (never a name pattern),
 *     so it can never kill an unrelated Electron process.
 */

/** Get a free ephemeral TCP port by binding :0 on loopback and reading the assigned port. */
export function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      if (addr && typeof addr === 'object') {
        const { port } = addr;
        srv.close(() => resolve(port));
      } else {
        srv.close(() => reject(new Error('[keepr-e2e] Could not determine a free port.')));
      }
    });
  });
}

/** True when nothing is currently accepting connections on 127.0.0.1:port. */
export function isPortFree(port: number, timeoutMs = 1000): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host: '127.0.0.1' });
    const done = (free: boolean): void => {
      socket.destroy();
      resolve(free);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => done(false)); // something answered -> occupied
    socket.once('timeout', () => done(true)); // no listener accepted in time -> treat as free
    socket.once('error', () => done(true)); // ECONNREFUSED -> free
  });
}

/**
 * Resolve the CDP port for a launch. Fail-fast so a CDP attach can NEVER hijack a foreign process.
 *   - explicit `requestedPort`: assert it is free, else THROW with an actionable message.
 *   - omitted: return a free ephemeral port.
 */
export async function resolveCdpPort(requestedPort?: number): Promise<number> {
  if (requestedPort !== undefined) {
    if (!(await isPortFree(requestedPort))) {
      throw new Error(
        `[keepr-e2e] Requested CDP port ${requestedPort} is already in use — refusing to launch. ` +
          `Attaching would HIJACK the process already listening there (e.g. a dev Electron instance ` +
          `on 9222). Choose a free port, or omit cdpPort to use an ephemeral one.`,
      );
    }
    return requestedPort;
  }
  return getFreePort();
}

/**
 * Wait until 127.0.0.1:port accepts a connection or the deadline passes.
 * MUST only be called AFTER the port was verified free pre-spawn (see resolveCdpPort), so a
 * successful connect here is unambiguously OUR spawned child — never a pre-existing listener.
 */
export function waitForChildPort(port: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve) => {
    const tick = (): void => {
      const socket = net.connect(port, '127.0.0.1');
      socket.once('connect', () => {
        socket.destroy();
        resolve(true);
      });
      socket.once('error', () => {
        socket.destroy();
        if (Date.now() > deadline) resolve(false);
        else setTimeout(tick, 300);
      });
    };
    tick();
  });
}

/** Signals to send given whether the child exited within the grace window. Pure. */
export function planTeardownSignals(exitedWithinGrace: boolean): Array<'SIGTERM' | 'SIGKILL'> {
  return exitedWithinGrace ? ['SIGTERM'] : ['SIGTERM', 'SIGKILL'];
}

/**
 * Kill target for a pid. A child spawned `detached` leads its own process group, so signal the
 * whole group via the NEGATED pid (Electron helpers die with it); otherwise the bare pid. Pure.
 */
export function killTargetForPid(pid: number, detached: boolean): number {
  return detached ? -pid : pid;
}

/** Resolve true once the child has exited, or false after graceMs. */
function waitForExit(child: ChildProcess, graceMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    let settled = false;
    const finish = (exited: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(exited);
    };
    const timer = setTimeout(() => finish(false), graceMs);
    child.once('exit', () => finish(true));
  });
}

export interface TerminateOptions {
  /** Grace period (ms) to wait for a clean SIGTERM exit before escalating to SIGKILL. */
  graceMs?: number;
  /** Whether the child was spawned detached (its own process group). Default true. */
  detached?: boolean;
}

/**
 * Terminate a spawned child (and, when detached, its whole process group): SIGTERM, wait up to
 * graceMs, then SIGKILL fallback. Targets ONLY the spawned PID tree — never a name pattern — so it
 * can never kill an unrelated Electron process. Idempotent / safe to call more than once.
 */
export async function terminateChildTree(
  child: ChildProcess | undefined,
  { graceMs = 5000, detached = true }: TerminateOptions = {},
): Promise<void> {
  if (!child || child.pid === undefined) return;
  const pid = child.pid;
  const target = killTargetForPid(pid, detached);
  const send = (sig: NodeJS.Signals): void => {
    try {
      process.kill(target, sig);
    } catch {
      // Group already gone / not a group leader -> fall back to the bare pid.
      try {
        process.kill(pid, sig);
      } catch {
        /* already dead */
      }
    }
  };
  send('SIGTERM');
  const exited = await waitForExit(child, graceMs);
  if (!exited) send('SIGKILL');
}
