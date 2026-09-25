-- C11 (C6): who reads a submission and everything the review page reads.
-- S_sub (T1, submitted; M4, A3) and S_fin's copy tree (1 header, 1 item,
-- 2 links, 2 members; A4/A5, M5).
--   readers: the submitter, broker, admin, it_admin -> every row
--   not readers: another T1 agent, E's broker, T2's broker -> nothing
--   anon: no rows and no function-permission error on the three tables whose
--   rules apply to every role
-- Wrong implementations this catches: it_admin missing from the helper; any
-- one of the seven read rules left on the old role list (each table is read
-- separately, so a single stale rule reds here).
DO $c11$
DECLARE
  who record;
  t   record;
  got bigint;
BEGIN
  FOR who IN SELECT * FROM (VALUES
      ('submitter', pg_temp.id('u_t1_agent'), true), ('broker', pg_temp.id('u_t1_broker'), true),
      ('admin', pg_temp.id('u_t1_admin'), true), ('it_admin', pg_temp.id('u_t1_itadmin'), true),
      ('other T1 agent', pg_temp.id('u_t1_agent2'), false), ('E broker', pg_temp.id('u_e_broker'), false),
      ('T2 broker', pg_temp.id('u_t2_broker'), false)) v(label, uid, reads) LOOP
    FOR t IN SELECT * FROM (VALUES
        ('transaction_submissions', format('SELECT count(*) FROM public.transaction_submissions WHERE id = %L', pg_temp.id('s_sub')), 1),
        ('submission_messages', format('SELECT count(*) FROM public.submission_messages WHERE submission_id = %L', pg_temp.id('s_sub')), 1),
        ('submission_attachments', format('SELECT count(*) FROM public.submission_attachments WHERE submission_id = %L', pg_temp.id('s_sub')), 1),
        ('submission_checklists', format('SELECT count(*) FROM public.submission_checklists WHERE submission_id = %L', pg_temp.id('s_fin')), 1),
        ('submission_checklist_items', format('SELECT count(*) FROM public.submission_checklist_items WHERE submission_id = %L', pg_temp.id('s_fin')), 1),
        ('submission_checklist_links', format('SELECT count(*) FROM public.submission_checklist_links WHERE submission_id = %L', pg_temp.id('s_fin')), 2),
        ('submission_checklist_link_members', format('SELECT count(*) FROM public.submission_checklist_link_members WHERE submission_id = %L', pg_temp.id('s_fin')), 2)
      ) v(tbl, q, want) LOOP
      PERFORM pg_temp.act_as(who.uid);
      got := pg_temp.n(t.q);
      PERFORM pg_temp.act_owner();
      PERFORM pg_temp.check(got = CASE WHEN who.reads THEN t.want ELSE 0 END,
                            format('C11 %s reads %s: got %s, want %s', who.label, t.tbl, got, CASE WHEN who.reads THEN t.want ELSE 0 END));
    END LOOP;
  END LOOP;

  PERFORM pg_temp.act_anon();
  PERFORM pg_temp.expect('C11 anon transaction_submissions', 'SELECT 1 FROM public.transaction_submissions', '~^(rows:0|42501:permission denied for table )');
  PERFORM pg_temp.expect('C11 anon submission_messages', 'SELECT 1 FROM public.submission_messages', '~^(rows:0|42501:permission denied for table )');
  PERFORM pg_temp.expect('C11 anon submission_attachments', 'SELECT 1 FROM public.submission_attachments', '~^(rows:0|42501:permission denied for table )');
  PERFORM pg_temp.act_owner();
END
$c11$;
