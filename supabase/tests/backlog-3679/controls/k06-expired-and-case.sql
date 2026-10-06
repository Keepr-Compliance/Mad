-- Expired invites are neither visible nor acceptable; email match ignores case and spaces.
DO $$ DECLARE m text; BEGIN
  m := pg_temp.as_user(pg_temp.ua(), 'invitee-3679@example.test',
    $q$select (select count(*) from public.organization_members where id='{inv_exp}')$q$);
  PERFORM pg_temp.check('k06 expired invite not visible', m = 'OK 0', m);
  m := pg_temp.as_user(pg_temp.ua(), 'invitee-3679@example.test',
    $q$update public.organization_members set user_id=auth.uid(), license_status='active', joined_at=now(), invitation_token=null where id='{inv_exp}'$q$);
  PERFORM pg_temp.check('k06 expired invite not acceptable', pg_temp.refused(m), m);
  -- an UPDATE with no WHERE needs no SELECT visibility, so the accept policy
  -- itself must exclude the expired row
  m := pg_temp.as_user(pg_temp.ua(), 'invitee-3679@example.test',
    $q$update public.organization_members set user_id=auth.uid(), license_status='active', joined_at=now(), invitation_token=null$q$, true);
  PERFORM pg_temp.check('k06 no-WHERE acceptance links only the unexpired invite', m = 'OK rows=1', m);
  PERFORM pg_temp.check('k06 expired invite still unclaimed',
    (SELECT user_id IS NULL FROM public.organization_members WHERE id=pg_temp.id('inv_exp')));
  UPDATE public.organization_members SET user_id=NULL, license_status='pending', joined_at=NULL, invitation_token='tok-3679-a'
   WHERE id=pg_temp.id('inv_a');
  m := pg_temp.as_user(pg_temp.ua(), '  Invitee-3679@Example.TEST ',
    $q$update public.organization_members set user_id=auth.uid(), license_status='active', joined_at=now(), invitation_token=null where id='{inv_a}'$q$);
  PERFORM pg_temp.check('k06 claim email differing in case/spaces still accepts', m = 'OK rows=1', m);
END $$;
