#!/usr/bin/env node
// Fails when a plain int/ or hotfix/ branch carries portal changes. BACKLOG-3205.
//
// WHY
//
// broker-portal/vercel.json and admin-portal/vercel.json no longer deploy plain
// int/** or hotfix/** branches. Portal work on an integration or hotfix branch
// opts in by name: int-portal/<name>, hotfix-portal/<name>. A branch the config
// denies gets no Vercel deployment AND no commit status for the portal it
// changes, so without this check the only symptom of a mis-named branch is
// silence.
//
// WHAT COUNTS AS A PORTAL CHANGE
//
// A path under broker-portal/, admin-portal/, packages/design-system/ or
// packages/ui/. The two packages are imported by the portals and by nothing in
// src/ or electron/. packages/shared/ is NOT included: tsconfig.json maps
// @keepr/shared for the desktop type-check, so a desktop sprint that edits a
// shared type would go red. Root package.json / package-lock.json are not
// included either: they change in desktop dependency bumps.
//
// WHICH CHANGES (the range)
//
//   push          files changed on the branch since its merge-base with
//                 origin/develop, INTERSECTED with the files changed since its
//                 merge-base with origin/main. That is the branch's own work
//                 whichever trunk it was cut from: a develop sync brings in no
//                 file of its own, a hotfix cut from develop is not charged
//                 with develop's lead over main, and a branch cut from main is
//                 not charged with main's lead over develop.
//   pull_request  files changed on the head since its merge-base with the base
//                 (base.sha...head.sha, from the event, not refs/pull/N/merge).
//                 A PR whose head is develop or main is a trunk sync and is not
//                 checked; the push check covers the resulting merge.
//
// A git failure is never read as "no files changed". Missing commits, a failed
// fetch or a missing merge-base exit 2.
//
// Inputs (environment, set by .github/workflows/portal-branch-name.yml):
//   EVENT_NAME   push | pull_request
//   REF_NAME     pushed branch name (push)
//   PR_BASE_REF, PR_HEAD_REF, PR_BASE_SHA, PR_HEAD_SHA (pull_request)
//
// Exit codes:  0 = OK or not applicable   1 = FINDINGS   2 = infrastructure

import { spawnSync } from 'node:child_process';

const PORTAL_PATH = /^(broker-portal|admin-portal|packages\/design-system|packages\/ui)\//;
const PORTAL_PATH_TEXT = 'broker-portal/, admin-portal/, packages/design-system/ or packages/ui/';
const TRUNKS = ['develop', 'main'];
const MAX_LISTED = 10;

function git(args) {
  const r = spawnSync('git', args, { encoding: 'utf8' });
  return { ok: r.status === 0, out: (r.stdout || '').trim(), err: (r.stderr || '').trim() };
}

function infra(message) {
  console.error(`::error title=Portal Branch Name::infrastructure: ${message}`);
  console.error('check-portal-branch-name: exit 2 (infrastructure, not a finding). Re-run the job; if it repeats, the checkout or fetch is broken.');
  process.exit(2);
}

function hasCommit(rev) {
  return git(['cat-file', '-e', `${rev}^{commit}`]).ok;
}

function fetch(refs) {
  const r = git(['fetch', '--no-tags', 'origin', ...refs]);
  if (!r.ok) infra(`git fetch origin ${refs.join(' ')} failed: ${r.err.split('\n')[0]}`);
}

function changedSince(base, head) {
  const mb = git(['merge-base', base, head]);
  if (!mb.ok || !mb.out) infra(`no merge-base between ${base} and ${head}`);
  const diff = git(['diff', '--name-only', '--no-renames', mb.out, head]);
  if (!diff.ok) infra(`git diff ${mb.out} ${head} failed: ${diff.err.split('\n')[0]}`);
  return diff.out ? diff.out.split('\n') : [];
}

function classify(branch) {
  if (branch.startsWith('int/')) return { kind: 'int', optIn: `int-portal/${branch.slice('int/'.length)}` };
  if (branch.startsWith('hotfix/')) return { kind: 'hotfix', optIn: `hotfix-portal/${branch.slice('hotfix/'.length)}` };
  return null;
}

const env = process.env;
const event = env.EVENT_NAME;

if (event === 'push') {
  const branch = env.REF_NAME || '';
  const cls = classify(branch);
  if (!cls) {
    console.log(`check-portal-branch-name: not applicable — ${branch || '(no branch)'} is not a plain int/ or hotfix/ branch.`);
    process.exit(0);
  }

  fetch(TRUNKS);
  for (const t of TRUNKS) {
    if (!hasCommit(`origin/${t}`)) infra(`origin/${t} is not present after fetch`);
  }
  if (!hasCommit('HEAD')) infra('HEAD is not a commit');

  const sinceDevelop = new Set(changedSince('origin/develop', 'HEAD'));
  const own = changedSince('origin/main', 'HEAD').filter((f) => sinceDevelop.has(f));
  const hits = own.filter((f) => PORTAL_PATH.test(f));

  if (hits.length === 0) {
    console.log(`check-portal-branch-name: OK — ${branch} carries no portal change (${own.length} file(s) of its own).`);
    process.exit(0);
  }

  console.error(
    `::error title=Portal Branch Name::${branch} carries ${hits.length} change(s) under ${PORTAL_PATH_TEXT}. ` +
    `Plain ${cls.kind}/ branches get no Vercel deployment for the portal they change (BACKLOG-3205). ` +
    `Create ${cls.optIn} from this branch, move its open PRs to it, and keep ${branch}.`
  );
  console.error('\nCommands:');
  console.error(`  git push origin origin/${branch}:refs/heads/${cls.optIn}`);
  console.error(`  gh pr edit <number> --base ${cls.optIn}     # for each open PR into ${branch}`);
  console.error(`Do not delete ${branch}.`);
  console.error(`\nPushing this same commit to ${cls.optIn} creates no deployment, and an empty commit is skipped as`);
  console.error(`"Not affected". The next push to ${cls.optIn} whose newest commit changes portal code builds it.`);
  console.error(`\nPortal files on ${branch} (first ${Math.min(MAX_LISTED, hits.length)} of ${hits.length}):`);
  for (const f of hits.slice(0, MAX_LISTED)) console.error(`  ${f}`);
  process.exit(1);
}

if (event === 'pull_request') {
  const baseRef = env.PR_BASE_REF || '';
  const headRef = env.PR_HEAD_REF || '';
  const baseSha = env.PR_BASE_SHA || '';
  const headSha = env.PR_HEAD_SHA || '';

  if (TRUNKS.includes(headRef)) {
    console.log(`check-portal-branch-name: not applicable — ${headRef} -> ${baseRef} is a trunk sync; the push check covers the merge.`);
    process.exit(0);
  }
  const cls = classify(baseRef);
  if (!cls) {
    console.log(`check-portal-branch-name: not applicable — base ${baseRef || '(none)'} is not a plain int/ or hotfix/ branch.`);
    process.exit(0);
  }
  if (!baseSha || !headSha) infra('PR_BASE_SHA or PR_HEAD_SHA is empty');

  for (const sha of [baseSha, headSha]) {
    if (!hasCommit(sha)) {
      fetch([baseRef]);
      if (!hasCommit(sha)) {
        const r = git(['fetch', '--no-tags', 'origin', sha]);
        if (!r.ok || !hasCommit(sha)) infra(`event commit ${sha} is not present after fetch`);
      }
    }
  }

  const changed = changedSince(baseSha, headSha);
  const hits = changed.filter((f) => PORTAL_PATH.test(f));

  if (hits.length === 0) {
    console.log(`check-portal-branch-name: OK — this PR brings no portal change into ${baseRef} (${changed.length} file(s)).`);
    process.exit(0);
  }

  console.error(
    `::error title=Portal Branch Name::This PR brings ${hits.length} change(s) under ${PORTAL_PATH_TEXT} into ${baseRef}. ` +
    `Plain ${cls.kind}/ branches get no Vercel deployment for the portal they change (BACKLOG-3205). ` +
    `The base branch needs the opt-in name: ask the PM to create ${cls.optIn} from ${baseRef} and move this PR to it.`
  );
  console.error('\nCommands:');
  console.error(`  git push origin origin/${baseRef}:refs/heads/${cls.optIn}`);
  console.error(`  gh pr edit <number> --base ${cls.optIn}`);
  console.error(`Do not delete ${baseRef}.`);
  console.error(`\nMove this PR before it merges: its merge into ${cls.optIn} is then a push that changes portal code, which builds.`);
  console.error(`\nPortal files in this PR (first ${Math.min(MAX_LISTED, hits.length)} of ${hits.length}):`);
  for (const f of hits.slice(0, MAX_LISTED)) console.error(`  ${f}`);
  process.exit(1);
}

infra(`unsupported EVENT_NAME "${event || ''}"`);
