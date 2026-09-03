/**
 * BACKLOG-3051 — a source-text floor under the two Kotlin constants that no CI
 * stage reads.
 *
 * ## WHAT THIS TEST GUARDS, AND WHAT IT DOES NOT
 *
 * It guards the **literal text of two constant declarations**. It does NOT
 * exercise the query, the provider, the cursor, or any behaviour whatsoever.
 * Nothing here runs a line of Kotlin. Do not read a green run of this file as
 * evidence that the MMS read works, that the sort is applied, or that the
 * selection matches rows — it cannot see any of that.
 *
 * Behavioural coverage of `KeeprMmsModule.kt` needs a compiler (the Gradle step
 * added alongside this file) and, for the provider semantics, a device. This
 * test is the cheap floor beneath both, not a substitute for either.
 *
 * ## DECLARATION IS NOT USE
 *
 * The first version of this file asserted only that the two constants were
 * DECLARED with the right values, and called the magnitude-agnostic selection
 * "covered". It was not. SR review of PR #2475 wrote the mutation that proves
 * it: rewrite `buildSelection` to a naive milliseconds-only compare,
 *
 *     return Pair("$COL_DATE >= ?", arrayOf(minDateMs.toString()))
 *
 * leaving both `const val` lines untouched. `MILLIS_MAGNITUDE_THRESHOLD` goes
 * from 3 occurrences in the file to 1 - declared, and dead. Measured: jest
 * 3 passed / 3 total, and `./gradlew :keepr-mms:compileDebugKotlin`
 * BUILD SUCCESSFUL, exit 0. Both layers walked straight past the defect that
 * returns ZERO messages forever while looking healthy (BACKLOG-1448).
 *
 * An unused `const val` in a companion object is not even a Kotlin warning, so
 * the compiler was never going to catch it. Hence the last test below, which
 * asserts the constant's USE inside `buildSelection` rather than its
 * declaration.
 *
 * ## WHY IT EXISTS
 *
 * `mmsReader.ts` calls `list(minDate, indexFrom, maxCount)`. There is no
 * `sortOrder` parameter — the sort lives entirely in Kotlin. So the JS suite has
 * nothing to observe, and before this file the following mutation was invisible
 * to every gate in CI:
 *
 *     const val SORT_OLDEST_FIRST = "date ASC"   ->   "date DESC"
 *
 * `content://mms` defaults to `date DESC`. Under that mutation a bounded page
 * returns the NEWEST n rows rather than a contiguous prefix, the caller advances
 * its cursor past them, and every older message below is stranded forever
 * (BACKLOG-2199). Jest, tsc and eslint all stayed green.
 *
 * ## WHY THE REGEXES ARE ANCHORED
 *
 * Load-bearing, not style. The module's own KDoc contains the strings `date
 * DESC` and `date ASC` in prose:
 *
 *     - **Default sort is `date DESC`.** Left alone, a bounded read returns the
 *       NEWEST n rows ... We force `date ASC`.
 *
 * So `expect(source).toContain('date ASC')` stays GREEN through the exact
 * mutation this file exists to catch — the comment satisfies it. The assertions
 * below match a whole DECLARATION LINE, and separately assert that the constant
 * is declared exactly once, so a second shadowing declaration cannot hide a
 * changed value either.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

const SOURCE_PATH = path.resolve(
  __dirname,
  '../android/src/main/java/expo/modules/keeprmms/KeeprMmsModule.kt'
);

/** Normalised so a CRLF checkout cannot defeat the `$` anchors below. */
function readSource(): string {
  return fs.readFileSync(SOURCE_PATH, 'utf8').replace(/\r\n/g, '\n');
}

/**
 * The body of `buildSelection`, from its signature to its closing brace.
 *
 * Scoped deliberately. The function's own KDoc sits directly above it and spells
 * the two-branch predicate out in prose, so assertions run against the whole
 * file would be satisfied by the COMMENT describing the logic rather than the
 * logic - the same way `toContain('date ASC')` is satisfied by the class KDoc.
 * Slicing from `private fun` excludes every comment above it.
 */
function buildSelectionBody(source: string): string {
  const start = source.indexOf('  private fun buildSelection(');
  if (start === -1) {
    throw new Error('buildSelection() not found in KeeprMmsModule.kt');
  }
  const end = source.indexOf('\n  }\n', start);
  if (end === -1) {
    throw new Error('could not find the end of buildSelection() in KeeprMmsModule.kt');
  }
  return source.slice(start, end);
}

/** Every `const val <name>` declaration line, whatever its value. */
function declarationsOf(name: string, source: string): string[] {
  const re = new RegExp(String.raw`^[ \t]*const val ${name}\b.*$`, 'gm');
  return source.match(re) ?? [];
}

describe('KeeprMmsModule.kt source invariants (BACKLOG-3051)', () => {
  it('reads the Kotlin source it claims to guard', () => {
    // Without this, a moved or renamed .kt file would surface as an ENOENT
    // stack inside an unrelated assertion. Naming the real problem here keeps
    // a path regression from being read as a constant regression.
    expect(fs.existsSync(SOURCE_PATH)).toBe(true);
    expect(readSource().length).toBeGreaterThan(0);
  });

  it('declares SORT_OLDEST_FIRST exactly once, as "date ASC"', () => {
    const source = readSource();

    expect(declarationsOf('SORT_OLDEST_FIRST', source)).toHaveLength(1);
    expect(source).toMatch(/^[ \t]*const val SORT_OLDEST_FIRST = "date ASC"$/m);
  });

  it('declares MILLIS_MAGNITUDE_THRESHOLD exactly once, as 100000000000L', () => {
    const source = readSource();

    // 1e11 separates a seconds-magnitude `date` from a milliseconds one. Move it
    // and `buildSelection` stops being unit-agnostic: a ms cursor against
    // seconds rows matches nothing, and the read returns zero rows forever while
    // looking healthy (the BACKLOG-1448 shape).
    expect(declarationsOf('MILLIS_MAGNITUDE_THRESHOLD', source)).toHaveLength(1);
    expect(source).toMatch(
      /^[ \t]*const val MILLIS_MAGNITUDE_THRESHOLD = 100000000000L$/m
    );
  });

  it('keeps buildSelection magnitude-agnostic: both branches, and a seconds floor', () => {
    const body = buildSelectionBody(readSource());

    // Invariant #2 of BACKLOG-3051, and the one the declaration assertions above
    // cannot reach. Three claims:
    //
    //   1. the second-magnitude branch exists
    //   2. the millisecond-magnitude branch exists
    //   3. the seconds floor is DERIVED from the millisecond cursor
    //
    // Why three and not one. The obvious minimal form - "MILLIS_MAGNITUDE_
    // THRESHOLD appears at least once outside its declaration" - is a count, and
    // a count cannot see the worst of these mutations. Measured, as occurrences
    // OUTSIDE the const val line:
    //
    //   naive ms-only compare                    -> 0   a count catches this
    //   second-magnitude branch deleted          -> 1   a count sees nothing
    //   millisecond-magnitude branch deleted     -> 1   a count sees nothing
    //   both branches bound to the ms cursor     -> 2   a count sees nothing
    //
    // The last one is the dangerous shape: both branches still there, the
    // constant still referenced twice, and second-magnitude rows filtered by a
    // millisecond floor - so the read matches nothing and returns zero rows
    // forever while looking healthy. Only claim 3 catches it.
    //
    // All four go red against the three claims together; which single claim
    // fires first for each is not asserted here, because jest stops at the first
    // failing expect and that ordering was never measured.
    expect(body).toContain('$COL_DATE < $MILLIS_MAGNITUDE_THRESHOLD');
    expect(body).toContain('$COL_DATE >= $MILLIS_MAGNITUDE_THRESHOLD');
    expect(body).toMatch(/minDateMs \/ 1000L?\b/);
  });
});
