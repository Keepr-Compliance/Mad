import re,sys
import os
root=os.path.join(os.path.dirname(os.path.abspath(__file__)),'..','..','..')+'/'
t=open(root+'supabase/migrations/20261114110000_backlog_4244_mcp_data_tools.sql').read()
def unit(name):
    s='CREATE OR REPLACE FUNCTION public.%s('%name
    i=t.index(s); e=t.index('$fn$;',t.index('AS $fn$',i)+7)+5
    rest=t[e:].lstrip('\n').split('\n')
    acl=[]
    for l in rest:
        if l.startswith(('REVOKE','GRANT')): acl.append(l)
        else: break
    return t[i:e]+'\n'+'\n'.join(acl)+'\n'
def rep(u,old,new,n=1):
    c=u.count(old); assert c==n,(old,c); return u.replace(old,new)
P=" AND NOT EXISTS (SELECT 1 FROM public.cloud_deal_checklists cl WHERE cl.id = t.cloud_checklist_id AND cl.removed_at IS NOT NULL)"
out=[]
u=unit('_mcp_r_list_deals')
u=rep(u,'AS $fn$\n','AS $fn$\n/*BODY:4263*/\n')
u=rep(u,'AND dl.is_confirmed /*CONF:list*/','AND dl.is_confirmed /*CONF:list*/ AND dl.removed_at IS NULL /*LIVE:list_deals*/')
u=rep(u,'WHERE c.owner_user_id = v_uid /*OWN:list_copy*/)','WHERE c.owner_user_id = v_uid /*OWN:list_copy*/ AND c.removed_at IS NULL /*LIVE:list_copy*/)')
u=rep(u,'AND t.removed_at IS NULL /*LIVE:list_todos*/','AND t.removed_at IS NULL /*LIVE:list_todos*/'+P+' /*LIVE:list_todos_parent*/')
u=rep(u,'/*OWN:list_open*/ AND t.removed_at IS NULL','/*OWN:list_open*/ AND t.removed_at IS NULL'+P+' /*LIVE:list_open_parent*/')
out.append(u)
u=unit('_mcp_r_get_deal')
u=rep(u,'AS $fn$\n','AS $fn$\n/*BODY:4263*/\n')
u=rep(u,'AND x.is_confirmed /*CONF:get_deal*/;','AND x.is_confirmed /*CONF:get_deal*/ AND x.removed_at IS NULL /*LIVE:get_deal*/;')
out.append(u)
u=unit('_mcp_r_deal_checklists')
u=rep(u,'AS $fn$\n','AS $fn$\n/*BODY:4263*/\n')
u=rep(u,'AND x.is_confirmed /*CONF:cl*/)','AND x.is_confirmed /*CONF:cl*/ AND x.removed_at IS NULL /*LIVE:cl_deal*/)')
u=rep(u,'AND t.removed_at IS NULL /*LIVE:cl_total*/','AND t.removed_at IS NULL /*LIVE:cl_total*/'+P+' /*LIVE:cl_total_parent*/')
u=rep(u,'/*OWN:cl_open*/ AND t.removed_at IS NULL','/*OWN:cl_open*/ AND t.removed_at IS NULL'+P+' /*LIVE:cl_open_parent*/')
out.append(u)
hdr='''
-- ============================================================================ replaced: MCP readers (owner mcp_reader)
-- Removed deals are skipped everywhere; an item counts as removed when it, its checklist or its deal is.
-- The install numbering (saved_from) keeps removed deals, so it does not shift.
GRANT CREATE ON SCHEMA public TO mcp_reader;
SET ROLE mcp_reader;

'''
tail='''
RESET ROLE;
REVOKE CREATE ON SCHEMA public FROM mcp_reader;
'''
open(sys.argv[1],'w').write(hdr+'\n'.join(out)+tail)
