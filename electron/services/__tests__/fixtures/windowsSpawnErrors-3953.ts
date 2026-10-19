/**
 * BACKLOG-3953: Node child_process error shapes, transcribed — not invented.
 *
 * MEASURED on macOS, Node v22.21.1 (Electron 38 ships Node 22), 2026-10-16:
 *   emitted  spawn(<missing file>)  -> 'error' {"errno":-2,"code":"ENOENT",
 *            "syscall":"spawn <path>","path":"<path>","spawnargs":["-l"],
 *            "message":"spawn <path> ENOENT"}, then 'close'(-2, null), pid undefined
 *   emitted  spawn(<file without exec bit>) -> same shape with EACCES / -13, 'close'(-13)
 *   thrown   spawn(<exec bit, not a program>) -> {"errno":-8,"code":"ENOEXEC",
 *            "syscall":"spawn","message":"spawn ENOEXEC"} (instanceof Error)
 *
 * WINDOWS VALUES ARE FROM SOURCE, NOT RUN (no Windows machine here):
 *   - libuv src/win/error.c uv_translate_sys_error: ERROR_FILE_NOT_FOUND -> UV_ENOENT,
 *     ERROR_ACCESS_DENIED -> UV_EPERM, ERROR_ELEVATION_REQUIRED -> UV_EACCES, anything
 *     unmapped (ERROR_VIRUS_INFECTED 225, ERROR_VIRUS_DELETED 226) -> UV_UNKNOWN.
 *   - libuv include/uv/errno.h (UV__E* on Windows): UV_ENOENT -4058, UV_EPERM -4048,
 *     UV_EACCES -4092, UV_UNKNOWN -4094, UV_EMFILE -4066, UV_ENFILE -4065,
 *     UV_EAGAIN -4088.
 *   - Node lib/internal/child_process.js ChildProcess.prototype.spawn: EACCES, EAGAIN,
 *     EMFILE, ENFILE and ENOENT are emitted as 'error' (and 'close' follows with the
 *     errno as the code); every other code is thrown as ErrnoException(err, 'spawn').
 *   - STATUS_DLL_NOT_FOUND 0xC0000135 = 3221225781 / -1073741515 (signed). Which form
 *     Node reports is unverified, so tests use both.
 */

export const WIN_ERRNO = {
  ENOENT: -4058,
  EPERM: -4048,
  EACCES: -4092,
  UNKNOWN: -4094,
  EMFILE: -4066,
  ENFILE: -4065,
  EAGAIN: -4088,
} as const;

export type WinSpawnCode = keyof typeof WIN_ERRNO;

/** The shape Node THROWS from spawn() (EPERM, UNKNOWN, ...). */
export function thrownSpawnError(code: WinSpawnCode): NodeJS.ErrnoException {
  return Object.assign(new Error(`spawn ${code}`), {
    errno: WIN_ERRNO[code],
    code,
    syscall: "spawn",
  });
}

/** The shape Node EMITS as 'error' (ENOENT, EACCES, EMFILE, ENFILE, EAGAIN). */
export function emittedSpawnError(
  code: WinSpawnCode,
  file: string,
  args: string[] = [],
): NodeJS.ErrnoException & { spawnargs: string[] } {
  return Object.assign(new Error(`spawn ${file} ${code}`), {
    errno: WIN_ERRNO[code],
    code,
    syscall: `spawn ${file}`,
    path: file,
    spawnargs: args,
  });
}

export const DLL_NOT_FOUND_UNSIGNED = 3221225781;
export const DLL_NOT_FOUND_SIGNED = -1073741515;
