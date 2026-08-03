/**
 * Shared typing for the "capture `ipcMain.handle` registrations into a Map" idiom
 * used across the electron handler unit tests.
 *
 * ## Why this exists (BACKLOG-2414)
 *
 * Until the test type gate landed, `electron/__tests__/**` was never loaded by `tsc`
 * at all (tsconfig.json excludes `**\/*.test.ts`). Once these suites are actually
 * type-checked, the idiom
 *
 *     let registeredHandlers: Map<string, Function>;
 *     const handler = registeredHandlers.get("some:channel");
 *     const result = await handler(mockEvent, arg);
 *
 * produces two errors per call site — TS18048 ("'handler' is possibly 'undefined'")
 * and TS2722 ("Cannot invoke an object which is possibly 'undefined'") — because
 * `Map<K, V>.get()` is typed `V | undefined`. That accounted for 759 of the errors
 * the gate first surfaced, spread over ~350 call sites in 8 suites.
 *
 * ## What this changes, and what it deliberately does not
 *
 * This is a TYPE-LEVEL change only. `createIpcHandlerRegistry()` returns a plain
 * `Map` — the runtime object, and therefore every test's behaviour, is unchanged.
 *
 * Typing `get()` as non-optional does not hide a real failure mode: a channel that
 * was never registered still yields `undefined` at runtime and still fails the test
 * the instant it is invoked ("handler is not a function"). The suites already relied
 * on that, which is why none of them null-check. The type now matches how the tests
 * are actually written, instead of forcing ~350 non-null assertions that would each
 * assert the same thing with less explanation.
 *
 * `RegisteredIpcHandler` is intentionally as loose as the `Function` type it replaces
 * (see the `any` justification on it) so that adopting this helper is a pure
 * substitution and cannot quietly change which arguments a suite is allowed to pass.
 * Tightening it to the real `(event: IpcMainInvokeEvent, ...) => Promise<T>` shape per
 * channel would be a genuine improvement, but it is a behavioural review of every
 * assertion in those suites — a separate piece of work, not a typing chore.
 */

/**
 * An IPC handler as captured from a mocked `ipcMain.handle(channel, handler)` call.
 *
 * `any` justification (CLAUDE.md requires one): this replaces the bare `Function`
 * type these suites used, which is strictly looser — `Function` permits any argument
 * list and yields `any`. Using `any` here preserves the existing checking level
 * exactly rather than silently narrowing what ~350 existing call sites may pass.
 * Handlers are registered by production code under test and invoked with a mock
 * `IpcMainInvokeEvent` plus channel-specific args that differ per channel.
 */
/* eslint-disable-next-line @typescript-eslint/no-explicit-any */
export type RegisteredIpcHandler = (...args: any[]) => any;

/**
 * A `Map` of channel -> handler whose `get()` returns a handler directly.
 *
 * Mirrors the subset of the `Map` API these suites use. Anything not listed here is
 * intentionally absent: if a suite needs more, widen this interface rather than
 * casting back to `Map`.
 */
export interface IpcHandlerRegistry {
  /** Non-optional by design — see the module comment. */
  get(channel: string): RegisteredIpcHandler;
  set(channel: string, handler: RegisteredIpcHandler): this;
  has(channel: string): boolean;
  delete(channel: string): boolean;
  clear(): void;
  readonly size: number;
  keys(): IterableIterator<string>;
  values(): IterableIterator<RegisteredIpcHandler>;
  entries(): IterableIterator<[string, RegisteredIpcHandler]>;
  forEach(
    callback: (
      handler: RegisteredIpcHandler,
      channel: string,
      registry: IpcHandlerRegistry,
    ) => void,
  ): void;
}

/**
 * Creates the handler registry used by the electron handler suites.
 *
 * Returns a real `Map`. The single cast below is the only place the non-optional
 * `get()` is asserted, so the reasoning lives in exactly one file instead of being
 * re-derived at every call site.
 */
export function createIpcHandlerRegistry(): IpcHandlerRegistry {
  return new Map<string, RegisteredIpcHandler>() as unknown as IpcHandlerRegistry;
}
