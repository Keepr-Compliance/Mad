#!/usr/bin/env python3
"""BACKLOG-4186 PR C: capture-pr-c.py JSON -> admin-portal/__tests__/sender-rules-4186/fixtures-pr-c.ts.
Usage: python3 fixtures-pr-c.py capture.json > fixtures-pr-c.ts (replaces the two fixture org ids/names only)."""
import json, sys
d = json.load(open(sys.argv[1]))
A = '"00000000-0000-4186-8000-000000000321"'; B = '"00000000-0000-4186-8000-000000000322"'
def js(v):
    t = json.dumps(v, indent=1, sort_keys=True)
    t = t.replace(A, 'ORG_A').replace(B, 'ORG_B').replace('P4186C Org A', 'Test Org A').replace('P4186C Org B', 'Test Org B')
    assert '4186-8000' not in t and 'P4186C' not in t
    return t
out = ['''/**
 * BACKLOG-4186 PR C fixtures, TRANSCRIBED from the real producers, not invented.
 *
 * Source: supabase/tests/backlog-4186/capture-pr-c.py (capture-pr-c.sql), run with kt-sql on
 * keepr-test 2026-11-10, one transaction ending in RAISE (nothing persisted). Changed from the
 * captured output, nothing else: the two fixture org ids are replaced by ORG_A / ORG_B (fixtures.ts)
 * and their names by "Test Org A/B". Errors are PostgREST's shape {code, message, details, hint}
 * (GET STACKED DIAGNOSTICS, re-keyed as in fixtures.ts).
 *
 * Captured sequence (owner): canary v2 to A -> release v3 (ends the test) -> pin B AT v3 -> canary
 * v4 to A -> STATE_MIXED -> revert_all (v5) -> STATE_REVERTED.
 */

import type { SenderRuleSet } from '@/lib/sender-rules/types';

import { ORG_A, ORG_B } from './fixtures';
''']
def add(name, doc, v, typ=''):
    out.append('/** %s */\nexport const %s%s = %s;\n' % (doc, name, typ, js(v)))
add('ACCESS', 'report_my_access(\'sender-rules\') per fixture user (owner, viewer grant, editor grant, no grant).', {k: v['data'] for k, v in d['access'].items()})
add('READ_REFUSED', 'sender_rule_set_admin_state() as an analytics user with NO grant: the read refusal.', d['read_none']['error'])
add('WRITE_REFUSED', 'sender_rule_set_publish(...) as the viewer (and revert_all as the editor: identical).', d['write_viewer']['error'])
assert d['write_viewer']['error'] == d['write_editor']['error']
assert d['read_viewer'] == d['read_editor']
add('STATE_READ_BY_VIEWER', 'sender_rule_set_admin_state() as the viewer (the editor read the same).', d['read_viewer']['data'])
add('STATE_MIXED', 'Org A tests canary v4 (newer than released v3); org B is pinned AT released v3.', d['state_mixed']['data'])
add('CONTENT_V3', 'sender_rule_set_admin_content(3): the released content in STATE_MIXED.', d['content_released']['data'], ': SenderRuleSet')
add('CONTENT_V2_SAME_RULES', 'sender_rule_set_admin_content(2): canary v2, the same rules as released v3 (only `version` differs).', d['content_canary_1']['data'], ': SenderRuleSet')
add('CONTENT_V4', 'sender_rule_set_admin_content(4): canary v4.', d['content_canary_2']['data'], ': SenderRuleSet')
add('ORG_LIST', 'admin_list_organizations() as the owner, the two fixture orgs only (B is a test org).', d['orgs'])
add('REVERT_RESULT', 'sender_rule_set_revert_all() as the owner: the new version.', d['revert_all']['data'])
add('STATE_REVERTED', 'sender_rule_set_admin_state() after revert_all.', d['state_reverted']['data'])
add('PUBLISH_RESULTS', 'sender_rule_set_publish / pin answers in the sequence.', {k: d[k]['data'] for k in ['canary_1', 'release_1', 'pin_b_at_released', 'canary_2']})
a=dict(d['content_canary_1']['data']); b=dict(d['content_released']['data']); a.pop('version'); b.pop('version'); assert a==b
print('\n'.join(out), end='')
