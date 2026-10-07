-- handle_new_user_invitation_link() no longer exists (preconditions.sql proved it
-- existed before the 3538 file ran).
DO $$ BEGIN
  PERFORM pg_temp.check('k13 handle_new_user_invitation_link() dropped',
    to_regprocedure('public.handle_new_user_invitation_link()') IS NULL);
END $$;
