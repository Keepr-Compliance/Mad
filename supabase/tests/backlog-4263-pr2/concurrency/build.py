#!/usr/bin/env python3
"""BACKLOG-4263 C14: writes the setup SQL for the commit-order proof into argv[1].

Usage: build.py <out.sql> <schema> <mode: pristine | seq_no_head>
The allocator is the text of public._cloud_todo_take_seq read from the migration in the working tree, with its
two object names moved into the scratch schema. The reader mirrors cloud_todo_pull's three feed lines; each line
is asserted present in the migration's cloud_todo_pull text, so the mirror cannot drift silently.
Mode seq_no_head is the plan's C14 mutant: numbers from a sequence with no head lock; the reader's head is the
highest committed number.
"""
import os, re, sys
here = os.path.dirname(os.path.abspath(__file__))
mig = open(os.path.join(here, '..', '..', '..', 'migrations', '20261118110000_backlog_4263_todo_server_core.sql')).read()
out, sch, mode = sys.argv[1:4]
assert re.fullmatch(r'p4263cc_[0-9a-f]{16}', sch)

def unit(name):
    s = 'CREATE OR REPLACE FUNCTION public.%s(' % name
    assert mig.count(s) == 1
    i = mig.index(s); e = mig.index('$f$;', mig.index('AS $f$', i) + 6) + 4
    return mig[i:e]

take = unit('_cloud_todo_take_seq')
pull = unit('cloud_todo_pull')
for line in ["SELECT h.last_seq, h.forgotten_through_seq INTO v_head, v_forgot FROM public.cloud_todo_feed_head h WHERE h.owner_user_id = v_uid;",
             "AND t.change_seq > v_after AND t.change_seq <= v_head",
             "'next_after', CASE WHEN v_n = v_lim THEN v_last ELSE greatest(v_head, v_after) END"]:
    assert line in pull, line
for a, n in [('public._cloud_todo_take_seq', 1), ('public.cloud_todo_feed_head', 4), ("'public.cloud_todo_seq'", 2)]:
    assert take.count(a) == n, (a, take.count(a))
# test hook, scratch copy only: a writer may sleep between taking its numbers and the head update
hook = "    FROM (SELECT nextval('public.cloud_todo_seq') AS x FROM generate_series(1, p_n)) s;\n"
assert take.count(hook) == 1, 'hook point'
take = take.replace(hook, hook + "  PERFORM pg_sleep(coalesce(nullif(current_setting('p4263.sleep', true), ''), '0')::float8);   -- test hook\n")
take = take.replace('public._cloud_todo_take_seq', sch + '._cloud_todo_take_seq').replace('public.cloud_todo_feed_head', sch + '.cloud_todo_feed_head') \
           .replace("'public.cloud_todo_seq'", "'" + sch + ".cloud_todo_seq'")
assert 'public.' not in take
if mode == 'sr7':
    # SR review mutant SR7: the allocator without its head row lock (exact replace, must match once)
    frag = 'WHERE h.owner_user_id = p_owner FOR UPDATE;   /*SEQ:lock*/'
    assert take.count(frag) == 1, 'SR7 fragment'
    take = take.replace(frag, 'WHERE h.owner_user_id = p_owner;   /*SEQ:lock*/')
    print('MUTATION APPLIED SR7 (allocator head lock removed)', file=sys.stderr)
    head = "SELECT x.last_seq INTO h FROM %s.cloud_todo_feed_head x WHERE x.owner_user_id = p_owner;" % sch
elif mode == 'seq_no_head':
    take = ("CREATE OR REPLACE FUNCTION %s._cloud_todo_take_seq(p_owner uuid, p_n integer) RETURNS bigint[]\n"
            "LANGUAGE sql VOLATILE SET search_path = '' AS $f$ SELECT array_agg(nextval('%s.cloud_todo_seq')) FROM generate_series(1, p_n) $f$") % (sch, sch)
    head = "SELECT coalesce(max(x.change_seq), 0) INTO h FROM %s.feed_rows x WHERE x.owner_user_id = p_owner;" % sch
else:
    assert mode == 'pristine'
    head = "SELECT x.last_seq INTO h FROM %s.cloud_todo_feed_head x WHERE x.owner_user_id = p_owner;" % sch
sql = """CREATE SCHEMA %(s)s;
CREATE SEQUENCE %(s)s.cloud_todo_seq AS bigint;
CREATE TABLE %(s)s.cloud_todo_feed_head (owner_user_id uuid PRIMARY KEY, last_seq bigint NOT NULL, forgotten_through_seq bigint NOT NULL);
CREATE TABLE %(s)s.feed_rows (owner_user_id uuid NOT NULL, tag text NOT NULL, change_seq bigint NOT NULL, UNIQUE (owner_user_id, change_seq));
%(take)s;
CREATE FUNCTION %(s)s.writer(p_owner uuid, p_tag text, p_sleep float8 DEFAULT 0) RETURNS bigint LANGUAGE plpgsql SET search_path = '' AS $w$
DECLARE v bigint;
BEGIN
  PERFORM set_config('p4263.sleep', p_sleep::text, true);
  v := (%(s)s._cloud_todo_take_seq(p_owner, 1))[1];
  PERFORM set_config('p4263.sleep', '0', true);
  INSERT INTO %(s)s.feed_rows (owner_user_id, tag, change_seq) VALUES (p_owner, p_tag, v);
  RETURN v;
END $w$;
CREATE FUNCTION %(s)s.reader(p_owner uuid, p_after bigint) RETURNS jsonb LANGUAGE plpgsql STABLE SET search_path = '' AS $r$
DECLARE h bigint; t jsonb;
BEGIN
  %(head)s
  h := coalesce(h, 0);
  SELECT coalesce(jsonb_agg(x.tag ORDER BY x.change_seq), '[]'::jsonb) INTO t FROM %(s)s.feed_rows x
   WHERE x.owner_user_id = p_owner AND x.change_seq > p_after AND x.change_seq <= h;
  RETURN jsonb_build_object('head', h, 'tags', t, 'next_after', greatest(h, p_after));
END $r$;
REVOKE ALL ON SCHEMA %(s)s FROM PUBLIC;
SELECT %(s)s.writer('__O__'::uuid, 'seed') AS seeded;
""" % {'s': sch, 'take': take, 'head': head}
fd = os.open(out, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
with os.fdopen(fd, 'w') as fh:
    fh.write(sql)
