-- C8: who can read a submitted checklist copy (the same readers as
-- submission_attachments: the submitter, and the organization's brokers and
-- admins). S_fin's tree: 1 header, 1 item, 2 links, 2 members.
--   submitter (u_t1_agent), T1 broker, T1 admin      : all rows, each table
--   T1 it_admin, second T1 agent, E broker           : rows:0, each table
-- Mutants: m10a..m10d (that table's SELECT admits any member of the org).

DO $c8$
DECLARE
  t   record;
  who record;
BEGIN
  FOR t IN SELECT * FROM (VALUES ('public.submission_checklists', 1),
                                 ('public.submission_checklist_items', 1),
                                 ('public.submission_checklist_links', 2),
                                 ('public.submission_checklist_link_members', 2)) v(tbl, full_count) LOOP
    PERFORM pg_temp.check(pg_temp.n(format('SELECT count(*) FROM %s WHERE submission_id = %L', t.tbl, pg_temp.id('s_fin'))) = t.full_count,
                          'owner: S_fin holds ' || t.full_count || ' row(s) in ' || t.tbl);
    FOR who IN SELECT * FROM (VALUES ('submitter', 'u_t1_agent', t.full_count),
                                     ('T1 broker', 'u_t1_broker', t.full_count),
                                     ('T1 admin', 'u_t1_admin', t.full_count),
                                     ('T1 it_admin', 'u_t1_itadmin', 0),
                                     ('second T1 agent', 'u_t1_agent2', 0),
                                     ('E broker', 'u_e_broker', 0)) v(label, uid, want) LOOP
      PERFORM pg_temp.act_as(pg_temp.id(who.uid));
      PERFORM pg_temp.expect(format('C8 %s reads %s', who.label, t.tbl),
        format('SELECT 1 FROM %s WHERE submission_id = %L', t.tbl, pg_temp.id('s_fin')), 'rows:' || who.want);
      PERFORM pg_temp.act_owner();
    END LOOP;
  END LOOP;
END
$c8$;
