-- E05: support_ticket_backlog_links still works for staff through admin-portal's three operations.
DO $$ DECLARE m text; BEGIN
  m := pg_temp.as_user('u_i', $q$insert into public.support_ticket_backlog_links (id, ticket_id, backlog_item_id, link_type, created_by) values ('{lnk2}', '{tk}', '{bl2}', 'fix', '{u_i}')$q$);
  PERFORM pg_temp.check('e05 staff inserts a link', m = 'OK rows=1', m);
  m := pg_temp.as_user('u_i', $q$select (select count(*) from public.support_ticket_backlog_links where id in ('{lnk}','{lnk2}'))$q$);
  PERFORM pg_temp.check('e05 staff reads links', m = 'OK 1' OR m = 'OK 2', m);
  m := pg_temp.as_user('u_i', $q$delete from public.support_ticket_backlog_links where id = '{lnk}'$q$);
  PERFORM pg_temp.check('e05 staff deletes a link', m = 'OK rows=1', m);
  m := pg_temp.as_user('u_a', $q$insert into public.support_ticket_backlog_links (ticket_id, backlog_item_id, link_type, created_by) values ('{tk}', '{bl}', 'fix', '{u_a}')$q$);
  PERFORM pg_temp.check('e05 brokerage admin insert refused', m LIKE 'ERR 42501%', m);
  m := pg_temp.as_role('anon', NULL, $q$insert into public.support_ticket_backlog_links (ticket_id, backlog_item_id, link_type) values ('{tk}', '{bl}', 'fix')$q$);
  PERFORM pg_temp.check('e05 anon insert refused', m LIKE 'ERR 42501%', m);
  m := pg_temp.as_role('anon', NULL, $q$delete from public.support_ticket_backlog_links$q$);
  PERFORM pg_temp.check('e05 anon delete refused (grant, not just RLS)', m LIKE 'ERR 42501%', m);
  m := pg_temp.as_user('u_i', $q$update public.support_ticket_backlog_links set link_type = 'fix' where id = '{lnk2}'$q$);
  PERFORM pg_temp.check('e05 update not granted to signed-in (unused by admin-portal)', m LIKE 'ERR 42501%', m);
END $$;
