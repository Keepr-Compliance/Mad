-- BACKLOG-3851 PR-2f rollback of M4a (20261017230000_backlog_3851_invite_name_columns.sql).
-- Drops organization_members.invited_first_name / invited_last_name and their CHECKs.
-- REFUSES while M4 is in force (its functions read the columns; run rollback-m4.sql first)
-- or while any row carries an invited name (the names would be lost).
-- Valid only BEFORE the PR-2f portal release ships (or together with a portal rollback):
-- once that portal is live it selects and inserts these columns, so removing them makes the
-- Users page, every invite and every resend fail. Its own guard also refuses once any
-- invitation carries a name.
-- Run in one transaction (BEGIN; \i rollback-m4a.sql; COMMIT;).

DO $pre$
DECLARE
  v_n integer;
BEGIN
  IF (SELECT md5(prosrc) FROM pg_proc WHERE oid = to_regprocedure('public.accept_invitation(text,text)'))
       = '37ce05772d72d25439d5ef2bdd5a2d08'
     OR (SELECT md5(prosrc) FROM pg_proc WHERE oid = to_regprocedure('public.guard_invite_acceptance()'))
       = '3219e9d919260b2c5ac537efb3a57581'
     OR (SELECT md5(prosrc) FROM pg_proc WHERE oid = to_regprocedure('public.public_validate_invitation_token(text)'))
       = 'b5131a4dc978a10275b553123ea58e77' THEN
    RAISE EXCEPTION '3851 rollback-m4a: M4 is in force; run rollback-m4.sql first';
  END IF;

  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema = 'public' AND table_name = 'organization_members'
                AND column_name = 'invited_first_name') THEN
    EXECUTE 'SELECT count(*) FROM public.organization_members
              WHERE invited_first_name IS NOT NULL OR invited_last_name IS NOT NULL' INTO v_n;
    IF v_n > 0 THEN
      RAISE EXCEPTION '3851 rollback-m4a: % row(s) carry an invited name', v_n;
    END IF;
  END IF;
END $pre$;

ALTER TABLE public.organization_members
  DROP CONSTRAINT IF EXISTS organization_members_invited_first_name_length,
  DROP CONSTRAINT IF EXISTS organization_members_invited_last_name_length,
  DROP COLUMN IF EXISTS invited_first_name,
  DROP COLUMN IF EXISTS invited_last_name;
