-- R02: after rollback-3684-b.sql then rollback-3684-a.sql the three functions are gone and
-- auto_provision_it_admin is the 20261016054316 body.
SELECT pg_temp.check('R02 accept_invitation gone', NOT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'accept_invitation'), NULL);
SELECT pg_temp.check('R02 caller_has_pending_invite gone', NOT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'caller_has_pending_invite'), NULL);
SELECT pg_temp.check('R02 _invite_bind_tenant gone', NOT EXISTS (SELECT 1 FROM pg_proc WHERE proname = '_invite_bind_tenant'), NULL);
SELECT pg_temp.check('R02 auto_provision_it_admin md5 = 0ca68b8c',
  (SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.auto_provision_it_admin(text,text,text)'::regprocedure) = '0ca68b8cee9820322274e1f1a4817b0a', NULL);
