-- D04 (3940): support_ticket_backlog_links is internal support staff only.
DO $$ DECLARE m text; BEGIN
  m := pg_temp.as_user('u_ps', $q$insert into public.support_ticket_backlog_links (ticket_id, backlog_item_id, link_type) values ('{tk}', '{bl2}', 'fix')$q$);
  PERFORM pg_temp.check('d04 brokerage admin insert refused', pg_temp.refused(m), m);
  m := pg_temp.as_user('u_a', $q$delete from public.support_ticket_backlog_links where id = '{lnk}'$q$);
  PERFORM pg_temp.check('d04 brokerage admin delete refused', pg_temp.refused(m), m);
  m := pg_temp.as_user('u_a', $q$update public.support_ticket_backlog_links set link_type = 'related' where id = '{lnk}'$q$);
  PERFORM pg_temp.check('d04 brokerage admin update refused', pg_temp.refused(m), m);
  m := pg_temp.as_user('u_g', $q$select (select count(*) from public.support_ticket_backlog_links)$q$);
  PERFORM pg_temp.check('d04 non-internal read: 0 rows', m = 'OK 0', m);
  m := pg_temp.as_role('anon', NULL, $q$select (select count(*) from public.support_ticket_backlog_links)$q$);
  PERFORM pg_temp.check('d04 anon read: 0 rows, no error', m = 'OK 0', m);
  m := pg_temp.as_role('anon', NULL, $q$insert into public.support_ticket_backlog_links (ticket_id, backlog_item_id, link_type) values ('{tk}', '{bl2}', 'fix')$q$);
  PERFORM pg_temp.check('d04 anon insert refused', pg_temp.refused(m), m);
  -- positives: internal staff with no org membership (admin-portal createBacklogLink / removeBacklogLink / reads)
  m := pg_temp.as_user('u_i', $q$insert into public.support_ticket_backlog_links (ticket_id, backlog_item_id, link_type, created_by) values ('{tk}', '{bl2}', 'fix', '{u_i}')$q$);
  PERFORM pg_temp.check('d04 internal insert lands', m = 'OK rows=1', m);
  m := pg_temp.as_user('u_i', $q$delete from public.support_ticket_backlog_links where id = '{lnk}'$q$);
  PERFORM pg_temp.check('d04 internal delete lands', m = 'OK rows=1', m);
  m := pg_temp.as_user('u_i', $q$select (select count(*) from public.support_ticket_backlog_links)$q$);
  PERFORM pg_temp.check('d04 internal reads links', m = 'OK 1', m);
END $$;
