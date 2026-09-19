/**
 * Database-time accounting for the pre-cache timing instrument (BACKLOG-2960).
 *
 * WHY THIS EXISTS
 * ---------------
 * `emailPrecacheTiming` reports wall-clock for a re-cache run, and the founder's
 * acceptance bound for the promise-conversion is stated against it. Four force
 * re-caches of unchanged code on the founder's machine measured 56,553 / 43,363 /
 * 39,326 / 42,478 ms — a 40% spread, 9.5% even with the first-after-launch run
 * excluded (pm_comments `ac7a6f40`). That run is dominated by fetching mail over
 * the network, and the conversion changes the data layer, not the network. So
 * wall-clock alone is the wrong quantity: the noise is all in the part the
 * conversion does not touch, and more samples measure the network more precisely
 * rather than the database at all.
 *
 * This module accumulates the OTHER number — time spent inside the database —
 * so the bound can be stated against the part the conversion actually changes.
 *
 * WHERE IT MEASURES, AND WHY NOT IN THE CONDUITS
 * ----------------------------------------------
 * Not in `dbGet`/`dbAll`/`dbRun`/`dbExec`/`dbTransaction`. Those five are not the
 * whole data-layer surface of the pre-cache path: the batch email INSERT
 * (`emailSyncService` ~line 666), the force-staging create and the staging→live
 * swap all take `getRawDatabase()` and drive `db.prepare(...)` / `db.transaction(...)`
 * directly, bypassing every conduit. Conduit-level timing would omit the heaviest
 * database work on exactly the path being measured.
 *
 * So the measurement sits one level lower, on the driver handle itself, installed
 * from `setDb()` — the single point where the live handle is published. Every
 * caller reaches the same instrumented object, whether it goes through a conduit
 * or takes the raw handle, and SQL added to this path later is counted without
 * anyone remembering to instrument it.
 *
 * THIS MODULE IMPORTS NOTHING
 * ---------------------------
 * Same rule, and the same reason, as `emailPrecacheTiming`: no `electron`, no
 * `logService`, no Sentry. It is unit-testable without a driver or a running app,
 * and BACKLOG-2961's module-level Electron coupling count does not grow because
 * of a timing line. It also means suites that `jest.mock` `dbConnection` still get
 * the real accumulator rather than an automocked `undefined`.
 */

/**
 * Monotonically increasing total of measured database time, in milliseconds.
 *
 * Never reset. Callers take a snapshot before a span and subtract it after, which
 * is what makes a long-lived process-wide counter usable for one run's figure.
 *
 * Fractional on purpose — see `now()`.
 */
let totalDbMs = 0;

/**
 * Re-entrancy depth. A transaction's callback runs statements of its own; timing
 * both the transaction and the statements inside it would count the same
 * microseconds twice. Only the outermost call contributes.
 */
let depth = 0;

/**
 * Handles already instrumented, so a second `setDb()` of the same handle does not
 * stack a wrapper on a wrapper.
 */
const instrumented = new WeakSet<object>();

/**
 * `performance.now()`, not `Date.now()`.
 *
 * A single-row prepared INSERT is well under a millisecond; `Date.now()` has
 * millisecond granularity, so the individual calls that make up a re-cache would
 * each round toward zero. The accumulator is kept fractional and rounded once, at
 * the point the line is formatted.
 */
function now(): number {
  return performance.now();
}

/**
 * Read the running total. Snapshot before a span, subtract after.
 */
export function readDbTimeMs(): number {
  return totalDbMs;
}

/**
 * Run `fn`, charging its elapsed time to the accumulator when it is the outermost
 * measured call.
 *
 * `finally`, so a statement that throws and a transaction that rolls back are
 * charged and unwind the depth the same way a successful one does.
 */
function timed<T>(fn: () => T): T {
  if (depth > 0) {
    return fn();
  }
  const startedAt = now();
  depth = 1;
  try {
    return fn();
  } finally {
    depth = 0;
    totalDbMs += now() - startedAt;
  }
}

/**
 * Give `wrapper` the own properties of the function it replaces — every own key,
 * not only the enumerable ones.
 *
 * A `jest.fn()` carries its whole configuration surface —
 * `mockReturnValue`, `mock.calls`, `mockImplementation` — and suites that hand
 * `setDb()` a mock database keep configuring and asserting on those methods
 * after the handle is instrumented. Replacing a method outright would strip them
 * and break the double instead of timing it.
 */
/**
 * Function intrinsics that belong to the wrapper itself and must not be copied:
 * they are non-writable, and `prototype`/`caller`/`arguments` are meaningless to
 * carry across.
 */
const INTRINSIC_FUNCTION_PROPS = new Set([
  "length",
  "name",
  "prototype",
  "caller",
  "arguments",
]);

function preserveProps(
  original: (...args: unknown[]) => unknown,
  wrapper: (...args: unknown[]) => unknown,
): (...args: unknown[]) => unknown {
  // Descriptors, not `Object.keys`: jest marks a mock with a NON-enumerable
  // `_isMockFunction`, and an enumerable-only copy loses it — the wrapper then
  // reads as a plain function and `toHaveBeenCalledWith` rejects it.
  for (const key of Reflect.ownKeys(original)) {
    if (typeof key === "string" && INTRINSIC_FUNCTION_PROPS.has(key)) {
      continue;
    }
    const descriptor = Object.getOwnPropertyDescriptor(original, key);
    if (descriptor === undefined) {
      continue;
    }
    try {
      Object.defineProperty(wrapper, key, descriptor);
    } catch {
      // A property that refuses to be redefined is not worth failing a timing
      // instrument over; the wrapper simply does not carry it.
    }
  }
  return wrapper;
}

/** The subset of the driver handle this module replaces. */
interface TimeableDatabase {
  prepare?: unknown;
  exec?: unknown;
  transaction?: unknown;
}

/** The subset of a prepared statement this module replaces. */
type StatementMethod = "run" | "get" | "all";
const STATEMENT_METHODS: readonly StatementMethod[] = ["run", "get", "all"];

/**
 * `iterate` is deliberately NOT wrapped. It returns a lazy iterator, so timing the
 * call would measure the setup and none of the row reads — a number that looks
 * like a measurement and is not one. No non-test caller exists in `electron/`
 * (checked with `grep -rn "\.iterate(" electron --include="*.ts"`); if one is
 * added, its rows are simply outside the figure, and closing that gap means timing
 * the iterator's `next`, not this call.
 */

/**
 * Statements already wrapped. A real driver hands back a fresh statement per
 * `prepare`, but a test double commonly returns one shared object every time;
 * without this, each `prepare` would add another layer to the same three
 * methods and the stack would grow for the life of the process.
 */
const instrumentedStatements = new WeakSet<object>();

function instrumentStatement(statement: unknown): unknown {
  if (
    statement === null ||
    (typeof statement !== "object" && typeof statement !== "function")
  ) {
    return statement;
  }
  const handle = statement as object;
  if (instrumentedStatements.has(handle)) {
    return statement;
  }
  instrumentedStatements.add(handle);

  const target = statement as Record<string, unknown>;
  for (const method of STATEMENT_METHODS) {
    const original = target[method];
    if (typeof original !== "function") {
      continue;
    }
    const fn = original as (...args: unknown[]) => unknown;
    target[method] = preserveProps(fn, (...args: unknown[]): unknown =>
      timed(() => fn.apply(target, args)),
    );
  }
  return statement;
}

/**
 * Does reading `prop` off `handle` twice yield the same function?
 *
 * A real better-sqlite3 handle and a plain object (including a `jest.fn()` mock)
 * both do. A Proxy whose `get` trap SYNTHESISES a function per read does not —
 * and such a handle must not be instrumented in place: it typically has no `set`
 * trap, so assigning the wrapper writes through to the object behind the proxy,
 * while reads keep returning the trap's own function. The two then call each
 * other. `transactionEligibilitySql.boundStatus-3103` hands `setDb` exactly that
 * kind of recording proxy, and the symptom is a stack overflow on the first
 * query rather than anything that looks like a timing bug.
 *
 * Reads only — this runs BEFORE any assignment, because the first write is
 * already unrecoverable: restoring the original afterwards re-installs the
 * trap's function onto the underlying object and the cycle persists.
 */
function readsStable(handle: Record<string, unknown>, prop: string): boolean {
  const first = handle[prop];
  if (typeof first !== "function") {
    return true; // absent or not a function: nothing to wrap, nothing to break
  }
  return first === handle[prop];
}

/**
 * Install database-time accounting on a driver handle.
 *
 * Idempotent, and tolerant of partial handles: each method is replaced only where
 * one is actually present, so the stand-in objects some suites hand to `setDb()`
 * pass through untouched rather than throwing inside an instrument.
 */
export function instrumentDatabaseTiming<T>(database: T): T {
  if (
    database === null ||
    (typeof database !== "object" && typeof database !== "function")
  ) {
    return database;
  }
  const handle = database as unknown as object;
  if (instrumented.has(handle)) {
    return database;
  }
  instrumented.add(handle);

  const target = database as unknown as TimeableDatabase &
    Record<string, unknown>;

  // Bail out whole, before writing anything, on a handle that indirects its
  // methods. Instrumenting such a handle is worse than not instrumenting it.
  for (const prop of ["prepare", "exec", "transaction"]) {
    if (!readsStable(target, prop)) {
      return database;
    }
  }

  if (typeof target.prepare === "function") {
    const originalPrepare = target.prepare as (...a: unknown[]) => unknown;
    target.prepare = preserveProps(originalPrepare, (...args: unknown[]) => {
      // Compiling the statement is database work too, so it is inside the span.
      const statement = timed(() => originalPrepare.apply(target, args));
      return instrumentStatement(statement);
    });
  }

  if (typeof target.exec === "function") {
    const originalExec = target.exec as (...a: unknown[]) => unknown;
    target.exec = preserveProps(originalExec, (...args: unknown[]) =>
      timed(() => originalExec.apply(target, args)),
    );
  }

  if (typeof target.transaction === "function") {
    const originalTransaction = target.transaction as (
      ...a: unknown[]
    ) => unknown;
    target.transaction = preserveProps(originalTransaction, (
      ...args: unknown[]
    ): unknown => {
      const wrapped = originalTransaction.apply(target, args);
      if (typeof wrapped !== "function") {
        return wrapped;
      }
      const runTransaction = wrapped as (...a: unknown[]) => unknown;
      const timedTransaction = (...callArgs: unknown[]): unknown =>
        timed(() => runTransaction.apply(target, callArgs));

      // better-sqlite3 hangs `.default`/`.deferred`/`.immediate`/`.exclusive` off
      // the returned function. Returning a bare closure would drop them; each is
      // re-attached in timed form so the accounting does not depend on which
      // spelling a caller picks.
      for (const variant of [
        "default",
        "deferred",
        "immediate",
        "exclusive",
      ] as const) {
        const variantFn = (runTransaction as unknown as Record<string, unknown>)[
          variant
        ];
        if (typeof variantFn === "function") {
          const call = variantFn as (...a: unknown[]) => unknown;
          (timedTransaction as unknown as Record<string, unknown>)[variant] = (
            ...callArgs: unknown[]
          ): unknown => timed(() => call.apply(runTransaction, callArgs));
        }
      }
      return timedTransaction;
    });
  }

  return database;
}
