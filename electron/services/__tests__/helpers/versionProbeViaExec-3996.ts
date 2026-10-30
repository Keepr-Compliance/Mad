/**
 * BACKLOG-3996: the `idevice_id --version` availability probe used to run through
 * `exec` (a shell). It is now `spawn(cmd, ["--version"])` under a time limit, with no
 * shell. Several suites configured the probe's answer through their `exec` mock; this
 * adapter keeps that configuration meaning the same thing.
 *
 * Use it as the `spawn` of a `child_process` mock:
 *
 *   spawn: (...args) => require("./helpers/versionProbeViaExec-3996").routeSpawn(args, mockSpawn, mockExec)
 *
 * A spawn of exactly `[cmd, ["--version"], ...]` is answered by calling the suite's exec
 * mock with the command line the old code ran (`"<cmd>" --version`), then emitting
 * 'close' with 0 (the callback got no error) or the error's numeric code (else 1). Every
 * other spawn goes to the suite's own spawn mock unchanged. So `mockExec` call counts
 * still count version probes, and nothing else.
 *
 * The fake carries `pid`, `exitCode` and `signalCode` (null while alive), as a real
 * ChildProcess does (SR R2).
 */
import { EventEmitter } from "events";

type ExecCallback = (err: (Error & { code?: unknown }) | null, ...rest: unknown[]) => void;

export function routeSpawn(args: unknown[], spawnMock: jest.Mock, execMock: jest.Mock): unknown {
  const [cmd, argv] = args as [string, unknown];
  const isVersionProbe = Array.isArray(argv) && argv.length === 1 && argv[0] === "--version";
  if (!isVersionProbe) return spawnMock(...args);

  const proc = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
    pid: number;
    exitCode: number | null;
    signalCode: string | null;
    kill: jest.Mock;
  };
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.pid = 7001;
  proc.exitCode = null;
  proc.signalCode = null;
  proc.kill = jest.fn(() => true);

  let answered = false;
  const cb: ExecCallback = (err) => {
    if (answered) return;
    answered = true;
    const code = err ? (typeof err.code === "number" && err.code !== 0 ? err.code : 1) : 0;
    // Native promise, not a timer: the caller attaches its handlers after spawn()
    // returns, and fake timers must not be needed to deliver the answer.
    void Promise.resolve().then(() => {
      proc.exitCode = code;
      proc.emit("exit", code, null);
      proc.emit("close", code, null);
    });
  };
  execMock(`"${cmd}" --version`, cb);
  return proc;
}
