/**
 * Which round of the email pre-cache is downloading — ONE definition.
 *
 * This file has NO imports on purpose, for the reason `importPhase.ts` has
 * none: it is the leaf both the producer (`emailPrecacheProgress`,
 * `emailSyncService`) and the renderer (`emailPrecacheStageDisplay`,
 * `EmailSettings`) derive from, so the declared union cannot drift from the one
 * the producer emits. Six copies of the macOS import's phase union existed
 * before BACKLOG-2832, three of them missing a member the producer had always
 * emitted; this is the shape that prevents the second instance of that.
 *
 * WHY A SEPARATE FIELD AND NOT MORE MEMBERS ON `EmailPrecachePhase`
 * ----------------------------------------------------------------
 * `phase` names the STAGE OF THE RUN — repairing, fetching, swapping, done —
 * and that is the granularity every consumer switches on, including the
 * renderer's "settle the bar on `done`" rule. A round is not a fourth kind of
 * stage; it is detail inside `fetching`. Replacing `"fetching"` with three
 * members would also have been a breaking change for two hand-written copies of
 * that union (`window-api-transactions.ts`, `EmailSettings.tsx`) and for every
 * assertion that pins the phase sequence — churn bought with no extra
 * correctness, since the exhaustiveness that matters is over THIS union and it
 * is enforced below.
 *
 * DELIBERATELY NOT IN THE `./index.ts` BARREL, same as `importPhase.ts`:
 * `src/types/index.ts` re-exports that barrel, which is the one path by which
 * the runtime `const` below could ride into the renderer bundle. Renderer
 * consumers use `import type`, which erases at compile time.
 */

/**
 * Every round the fetch phase can report.
 *
 * The two `-folders` / `-labels` members are the provider-wide walks
 * (`searchAllFolders` / `searchAllLabels`), which is why the copy for them says
 * "folders" rather than naming a mailbox: they sweep sent items, archives and
 * every custom folder or label, not one place the user can point at.
 *
 * NOT a member: the backfill round (`emailSyncService`, the
 * `[cacheSinceDate .. oldestCached)` sweep). It reports no progress of its own
 * yet, so giving it a stage here would declare a state nothing emits.
 */
export type EmailPrecacheStage =
  | "outlook-inbox"
  | "outlook-folders"
  | "gmail-messages"
  | "gmail-labels";

/**
 * Every stage, once, as data — for iteration and for the compile-time coverage
 * check below. Order is the order the rounds actually run.
 */
export const EMAIL_PRECACHE_STAGES = [
  "outlook-inbox",
  "outlook-folders",
  "gmail-messages",
  "gmail-labels",
] as const;

/**
 * Compile-time proof that `EMAIL_PRECACHE_STAGES` lists every member of the
 * union and nothing else.
 *
 * `Tuple extends readonly Union[]` rejects an EXTRA member; the `Exclude` arm
 * rejects a MISSING one. Add a fifth stage to the union without adding it here
 * and `tsc` fails on this line with the missing name in the error text.
 *
 * It lives in the shipped module rather than only in a test so that
 * `npm run type-check` catches it — that config does not cover test files.
 */
type AssertTupleCoversUnion<
  Union extends string,
  Tuple extends readonly Union[],
> = Exclude<Union, Tuple[number]> extends never
  ? true
  : { readonly missingFromEmailPrecacheStages: Exclude<Union, Tuple[number]> };

const _EMAIL_PRECACHE_STAGES_COVER_THE_UNION: AssertTupleCoversUnion<
  EmailPrecacheStage,
  typeof EMAIL_PRECACHE_STAGES
> = true;
void _EMAIL_PRECACHE_STAGES_COVER_THE_UNION;
