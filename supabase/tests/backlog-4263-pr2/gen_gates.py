#!/usr/bin/env python3
"""BACKLOG-4263: writes the 'install-scoped writers' section of the migration: the six child writers and
cloud_mark_deal_synced refuse install_removed for a removed install and not_found for a soft-removed deal;
cloud_tombstone refuses install_removed. Bodies are copied from 20261112190000 with exact-string inserts
(each must match once). Prints the traced md5 of each original body for the pre-check."""
import hashlib, os, sys
here = os.path.dirname(os.path.abspath(__file__))
S = open(os.path.join(here, '..', '..', 'migrations', '20261112190000_backlog_4236_cloud_autosave_schema.sql')).read()
def unit(name):
    s = 'CREATE OR REPLACE FUNCTION public.%s(' % name
    assert S.count(s) == 1
    i = S.index(s); b0 = S.index('AS $f$', i) + 6; b1 = S.index('$f$;', b0); e = b1 + 4
    acl = []
    for l in S[e:].lstrip('\n').split('\n'):
        if l.startswith(('REVOKE', 'GRANT')): acl.append(l)
        else: break
    return S[i:e] + '\n' + '\n'.join(acl) + '\n', hashlib.md5(S[b0:b1].encode()).hexdigest()
GATE = ("IF public._cloud_install_removed(v_uid, p_source_install_id) THEN                       /*GATE:install:%s*/\n"
        "    RETURN jsonb_build_object('ok', false, 'error', 'install_removed');\n  END IF;\n  ")
out = ['\n-- ============================================================================ replaced: install-scoped writers of the one-way path',
       '-- Each refuses install_removed when the install is in the owner\'s removed-install register and, except',
       '-- cloud_tombstone, answers not_found for a soft-removed deal (the runner then re-sends the header, and',
       '-- cloud_upsert_deal un-removes it). Bodies otherwise as in 20261112190000.']
md5s = {}
for name, tag in [('cloud_upsert_parties', 'parties'), ('cloud_upsert_checklists', 'checklists'), ('cloud_upsert_checklist_items', 'items'),
                  ('cloud_upsert_messages', 'messages'), ('cloud_upsert_files', 'files'), ('cloud_mark_deal_synced', 'mark_synced'), ('cloud_tombstone', 'tombstone')]:
    u, m = unit(name); md5s[name] = m
    def rep(a, b):
        global u
        assert u.count(a) == 1, (name, a)
        u = u.replace(a, b)
    rep('AS $f$\n', 'AS $f$\n/*BODY:4263*/\n')
    if name == 'cloud_tombstone':
        rep("PERFORM 1 FROM public.cloud_autosave_settings WHERE user_id = v_uid FOR SHARE;\n  ",
            "PERFORM 1 FROM public.cloud_autosave_settings WHERE user_id = v_uid FOR SHARE;\n  " + GATE % tag)
    else:
        rep("  SELECT d.id INTO v_deal FROM public.cloud_deals d\n", "  " + (GATE % tag) + "SELECT d.id INTO v_deal FROM public.cloud_deals d\n")
        rep("/*INSTALL:%s*/\n   FOR NO KEY UPDATE;" % tag, "/*INSTALL:%s*/\n     AND d.removed_at IS NULL                                                             /*GATE:live:%s*/\n   FOR NO KEY UPDATE;" % (tag, tag))
    out.append(u)
open(sys.argv[1], 'w').write('\n'.join(out))
for k, v in md5s.items(): print(k, v)
