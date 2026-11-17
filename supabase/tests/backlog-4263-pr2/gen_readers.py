#!/usr/bin/env python3
"""BACKLOG-4263 PR-2: writes the 'replaced: MCP readers' section of the migration (argv[1]): the three readers
of 20261114110000 and _mcp_r_list_all_deals of 20261118100000, each with exact-string inserts (every one must
match once): removed deals skipped, items counted only when their checklist is live, and the install numbering
(saved_from) marked as the one read that keeps removed deals."""
import os, sys
root = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..', '..') + '/'
SRC = {n: open(root + 'supabase/migrations/' + f).read() for n, f in [
    ('4244', '20261114110000_backlog_4244_mcp_data_tools.sql'), ('4263', '20261118100000_backlog_4263_mcp_list_all_deals.sql')]}


def unit(src, name):
    t = SRC[src]
    s = 'CREATE OR REPLACE FUNCTION public.%s(' % name
    assert t.count(s) == 1, name
    i = t.index(s); e = t.index('$fn$;', t.index('AS $fn$', i) + 7) + 5
    acl = []
    for l in t[e:].lstrip('\n').split('\n'):
        if l.startswith(('REVOKE', 'GRANT')): acl.append(l)
        else: break
    return t[i:e] + '\n' + '\n'.join(acl) + '\n'


def rep(u, old, new, n=1):
    c = u.count(old); assert c == n, (old, c); return u.replace(old, new)


P = " AND NOT EXISTS (SELECT 1 FROM public.cloud_deal_checklists cl WHERE cl.id = t.cloud_checklist_id AND cl.removed_at IS NOT NULL)"
K = ' /*KEEP_REMOVED:install_numbering*/'
out = []
u = unit('4244', '_mcp_r_list_deals')
u = rep(u, 'AS $fn$\n', 'AS $fn$\n/*BODY:4263*/\n')
u = rep(u, 'WHERE x.owner_user_id = v_uid /*OWN:list_inst*/', 'WHERE x.owner_user_id = v_uid /*OWN:list_inst*/' + K)
u = rep(u, 'AND dl.is_confirmed /*CONF:list*/', 'AND dl.is_confirmed /*CONF:list*/ AND dl.removed_at IS NULL /*LIVE:list_deals*/')
u = rep(u, 'WHERE c.owner_user_id = v_uid /*OWN:list_copy*/)', 'WHERE c.owner_user_id = v_uid /*OWN:list_copy*/ AND c.removed_at IS NULL /*LIVE:list_copy*/)')
u = rep(u, 'AND t.removed_at IS NULL /*LIVE:list_todos*/', 'AND t.removed_at IS NULL /*LIVE:list_todos*/' + P + ' /*LIVE:list_todos_parent*/')
u = rep(u, '/*OWN:list_open*/ AND t.removed_at IS NULL', '/*OWN:list_open*/ AND t.removed_at IS NULL' + P + ' /*LIVE:list_open_parent*/')
out.append(u)
u = unit('4244', '_mcp_r_get_deal')
u = rep(u, 'AS $fn$\n', 'AS $fn$\n/*BODY:4263*/\n')
u = rep(u, 'AND x.is_confirmed /*CONF:get_deal*/;', 'AND x.is_confirmed /*CONF:get_deal*/ AND x.removed_at IS NULL /*LIVE:get_deal*/;')
u = rep(u, 'WHERE x.owner_user_id = v_uid /*OWN:get_inst*/', 'WHERE x.owner_user_id = v_uid /*OWN:get_inst*/' + K)
out.append(u)
u = unit('4244', '_mcp_r_deal_checklists')
u = rep(u, 'AS $fn$\n', 'AS $fn$\n/*BODY:4263*/\n')
u = rep(u, 'AND x.is_confirmed /*CONF:cl*/)', 'AND x.is_confirmed /*CONF:cl*/ AND x.removed_at IS NULL /*LIVE:cl_deal*/)')
u = rep(u, 'AND t.removed_at IS NULL /*LIVE:cl_total*/', 'AND t.removed_at IS NULL /*LIVE:cl_total*/' + P + ' /*LIVE:cl_total_parent*/')
u = rep(u, '/*OWN:cl_open*/ AND t.removed_at IS NULL', '/*OWN:cl_open*/ AND t.removed_at IS NULL' + P + ' /*LIVE:cl_open_parent*/')
out.append(u)
u = unit('4263', '_mcp_r_list_all_deals')
u = rep(u, 'AS $fn$\n', 'AS $fn$\n/*BODY:4263*/\n')
u = rep(u, 'WHERE x.owner_user_id = v_uid /*OWN:all_inst*/', 'WHERE x.owner_user_id = v_uid /*OWN:all_inst*/' + K)
u = rep(u, 'AND dl.is_confirmed /*CONF:all*/', 'AND dl.is_confirmed /*CONF:all*/ AND dl.removed_at IS NULL /*LIVE:all_deals*/')
out.append(u)
hdr = '''
-- ============================================================================ replaced: MCP readers (owner mcp_reader)
-- Removed deals are skipped everywhere; an item counts as removed when it, its checklist or its deal is.
-- The install numbering (saved_from) keeps removed deals, so it does not shift; that read is marked
-- KEEP_REMOVED. Output shapes are unchanged.
GRANT CREATE ON SCHEMA public TO mcp_reader;
SET ROLE mcp_reader;

'''
tail = '''
RESET ROLE;
REVOKE CREATE ON SCHEMA public FROM mcp_reader;
'''
open(sys.argv[1], 'w').write(hdr + '\n'.join(out) + tail)
