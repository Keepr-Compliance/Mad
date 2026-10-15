-- E02: every table whose policy calls a helper shows each actor exactly what it showed before
-- the change, and no signed-out read errors. Exception by design: signed-out access to
-- support_ticket_backlog_links is a permission error once its anon grant is gone. Tables anon
-- holds no grant on (checklist_*) error identically before and after.
SELECT pg_temp.vis_capture('post');
DO $$ DECLARE r record; n int := 0; BEGIN
  FOR r IN SELECT a.actor, a.tbl, a.msg pre, b.msg post FROM t3946_vis a JOIN t3946_vis b USING (actor, tbl)
            WHERE a.phase = 'pre' AND b.phase = 'post' ORDER BY a.tbl, a.actor LOOP
    n := n + 1;
    IF r.actor = 'anon' AND r.tbl = 'support_ticket_backlog_links' THEN
      PERFORM pg_temp.check('e02 anon support_ticket_backlog_links read: 0 rows or 42501', r.post IN ('OK 0') OR r.post LIKE 'ERR 42501%', r.pre || ' -> ' || r.post);
    ELSIF r.actor = 'anon' THEN
      PERFORM pg_temp.check('e02 anon ' || r.tbl || ' unchanged, no error', r.post = r.pre AND (r.post NOT LIKE 'ERR%' OR r.pre LIKE '%permission denied for table%'), r.pre || ' -> ' || r.post);
    ELSE
      PERFORM pg_temp.check('e02 ' || r.actor || ' ' || r.tbl || ' unchanged', r.post = r.pre, r.pre || ' -> ' || r.post);
    END IF;
  END LOOP;
  PERFORM pg_temp.check('e02 fingerprint pairs = 130', n = 130, n::text);
  -- sanity: the fingerprint can see something (else "unchanged" is vacuous)
  PERFORM pg_temp.check('e02 staff sees admin_roles rows', (SELECT msg FROM t3946_vis WHERE phase='post' AND actor='u_i' AND tbl='admin_roles') NOT IN ('OK 0') AND (SELECT msg FROM t3946_vis WHERE phase='post' AND actor='u_i' AND tbl='admin_roles') LIKE 'OK %',
    (SELECT msg FROM t3946_vis WHERE phase='post' AND actor='u_i' AND tbl='admin_roles'));
  PERFORM pg_temp.check('e02 agent sees own org roster', (SELECT msg FROM t3946_vis WHERE phase='post' AND actor='u_g' AND tbl='organization_members') NOT IN ('OK 0') AND (SELECT msg FROM t3946_vis WHERE phase='post' AND actor='u_g' AND tbl='organization_members') LIKE 'OK %',
    (SELECT msg FROM t3946_vis WHERE phase='post' AND actor='u_g' AND tbl='organization_members'));
END $$;
