/**
 * Are these two display names plausibly the SAME person? — RENDERER MIRROR.
 *
 * ===========================================================================
 * THIS IS A MIRROR. THE CANONICAL COPY IS `electron/utils/contactNameCompat.ts`
 * ===========================================================================
 * BACKLOG-2416: the main process gated phone-based dedup on name compatibility
 * while this layer's picker dedup (`contactPickerList.matchesSeen`) matched on
 * phone UNCONDITIONALLY, so two people sharing one office line were collapsed
 * to a single row here after the backend had correctly kept both.
 *
 * The rule cannot simply be imported: `tsconfig.electron.json` sets
 * `rootDir: "./electron"`, so nothing under `electron/` may import from `src/`
 * or `shared/` (the same constraint that makes `electron/types/license.ts` a
 * duplicate of `shared/types/license.ts`). Importing in the other direction is
 * worse — `contactHandlers.ts` pulls in `ipcMain`, which cannot exist in the
 * renderer bundle.
 *
 * What keeps the two copies honest is not this comment.
 * `tests/contactNameCompat.parity.test.ts` imports BOTH implementations and
 * asserts an identical verdict for every case in a shared table. Edit one
 * without the other and that test goes red.
 *
 * Read the canonical file for the reasoning behind each clause — in particular
 * why a lone non-exact token is NOT compatible (BACKLOG-2399).
 */

/** Lowercase, strip `.`/`,`, collapse whitespace. "" for a missing name. */
export function normalizeContactName(name: string | null | undefined): string {
  return (name || "")
    .toLowerCase()
    .replace(/[.,]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Could these two names belong to the same person?
 *
 * Empty can't contradict. Exact match collapses. A lone non-exact token is
 * never enough (BACKLOG-2399). Otherwise every aligned token pair up to the
 * shorter name's length must be prefix-compatible.
 */
export function namesAreCompatible(
  a: string | null | undefined,
  b: string | null | undefined,
): boolean {
  const na = normalizeContactName(a);
  const nb = normalizeContactName(b);
  if (!na || !nb) return true;
  if (na === nb) return true;

  const ta = na.split(" ");
  const tb = nb.split(" ");

  if (ta.length === 1 || tb.length === 1) return false;

  const len = Math.min(ta.length, tb.length);
  for (let i = 0; i < len; i++) {
    const x = ta[i];
    const y = tb[i];
    if (!x.startsWith(y) && !y.startsWith(x)) return false;
  }
  return true;
}
