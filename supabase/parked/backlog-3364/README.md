# Parked: BACKLOG-3364 personal-organization backfill

`backfill_personal_organizations.sql` is **parked, not a migration.** It has been
run only inside rolled-back transactions on the test stack
(`supabase/tests/backlog-3364/`, control `b-backfill-skips-invites-and-reruns-clean`).
It has not been run on any real database.

## What it does

For every licensed user who holds no organization membership, it calls
`public._ensure_personal_organization_for(user_id)`, which migration
`20260915160637_backlog_3364_personal_organizations.sql` creates. It:

- skips any user with an **unclaimed invite** row for their email, expired or not,
  and reports how many it skipped;
- is one `DO` statement, so it is atomic on its own;
- writes nothing on a second run.

## Why it is not in `supabase/migrations/`

A file in `migrations/` is a claim that it belongs in every database, and
`supabase db reset` runs every file there (see `supabase/parked/backlog-3130/README.md`).
This one runs only when a decision has been made, and possibly never.

## What it waits on

The founder decision on how existing solo users get a plan on record
(BACKLOG-3227 decision list, item 7): **all at once**, or **at their next sign-in
on the updated app**. If the answer is "at next sign-in", this file is not needed
and can be deleted.

## Rules before it is ever run

1. **Never before the desktop release that understands personal organizations.**
   An older build that meets a personal organization shows actions that then fail.
2. **Move it into `supabase/migrations/` under a fresh 14-digit stamp**, reviewed
   against the schema as it stands then. Do not move this file back as-is.
3. **Run the cohort query read-only on production first, and record the counts**
   on BACKLOG-3364:

```sql
SELECT count(*) AS cohort,
       count(*) FILTER (WHERE EXISTS (
         SELECT 1 FROM public.organization_members i
         WHERE i.user_id IS NULL
           AND lower(trim(i.invited_email)) = lower(trim(COALESCE(
                 NULLIF(TRIM(au.email), ''),
                 NULLIF(TRIM(au.raw_user_meta_data->>'email'), ''),
                 au.raw_user_meta_data->>'mail',
                 au.raw_user_meta_data->>'preferred_username')))
       )) AS would_skip_unclaimed_invite
FROM public.licenses l
JOIN auth.users au ON au.id = l.user_id
WHERE NOT EXISTS (SELECT 1 FROM public.organization_members m WHERE m.user_id = l.user_id);
```

4. Production changes need the founder's explicit word at the time.
