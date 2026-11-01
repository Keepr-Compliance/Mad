/**
 * BACKLOG-3968 PR-4a — the hold on sending checklist TEXT links to the cloud.
 *
 * The cloud copy `public.snapshot_submission_checklists` accepts only the
 * link kinds 'attachment' and 'email' and raises on any other: one text link
 * in the payload would fail the whole submit. The cloud migration that teaches
 * it 'text' is BACKLOG-3968 PR-5.
 *
 * While this is `true`:
 *   - the snapshot payload never carries a text link (or a text member);
 *   - the submit pre-flight lists every text link as not included, so the
 *     agent is told before anything is sent and nothing is lost silently.
 *
 * RELEASE CONDITION: flip to `false` only in the PR that cites the PRODUCTION
 * apply of PR-5's Supabase migration. Every reader imports this constant;
 * none restates the value (checklistTextLinkHold-3968.test.ts holds that).
 */
export const TEXT_LINKS_HELD_UNTIL_CLOUD_MIGRATION: boolean = true;
