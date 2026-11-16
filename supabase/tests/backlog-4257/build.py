#!/usr/bin/env python3
"""BACKLOG-4257 PR A: the synthetic schema-2 payloads the controls feed the validator.

build() returns a dict of placeholder -> text for controls.sql:
  __FIXTURE__     the committed REAL 2.49 report (electron/services/learn/__tests__/fixtures/
                  pilotReport-real-4219.json .report), schema 1, as written by the desktop builder
  __REP2__        that report as schema 2 with a signals block (small, varied ints)
  __MAX2__        the largest legal schema 2: every int 10000000, longest strings, 10 + 10 mailboxes,
                  10 answer versions
  __OBJ_PATHS__ / __KEY_PATHS__ / __INT_PATHS__ / __BOOL_PATHS__   every object node, key, int leaf and
                  boolean leaf of rep2's signals block (paths from the report root)
  __MAX2_COMPACT__ / __MAX2_EST__   compact JSON length of max2, and compact + one byte per ':' and ','
                  (the client's jsonb-text estimate; no string in the payload holds either)
Value names are read from the migration's ARRAYs, so they are what the server checks; static.py checks
those against SIGNAL_VALUES in electron/services/learn/signalScoring.ts.
"""
import copy, json, os, re

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.abspath(os.path.join(HERE, '..', '..', '..'))
MIG = os.path.join(REPO, 'supabase/migrations/20261117120000_backlog_4257_learn_pilot_signals.sql')
FIXTURE = os.path.join(REPO, 'electron/services/learn/__tests__/fixtures/pilotReport-real-4219.json')
FAMILIES = ['anchor', 'stage', 'sender', 'filename', 'forms']
GATE = ['true_kept', 'true_lost', 'known_wrong_dropped', 'known_wrong_total', 'cleanup_no_dropped',
        'cleanup_no_total', 'cleanup_yes_lost', 'cleanup_yes_total', 'unmeasured']
MAXI = 10_000_000


def value_names():
    m = open(MIG).read()
    out = {}
    for f in FAMILIES:
        a = re.search(r"  v_%s CONSTANT TEXT\[\] := ARRAY\[([^\]]*)\];" % f, m)
        out[f] = re.findall(r"'([^']*)'", a.group(1))
    return out


def signals(num):
    """num(path) -> int; one signals_version-1 block."""
    names = value_names()
    def rate(p): return {'k': num(p + ['k']), 'n': num(p + ['n'])}
    return {
        'signals_version': 1,
        'terms_version': num(['terms_version']),
        'deal_linked_capped': False, 'detection_capped': True,
        'emails': {k: num(['emails', k]) for k in ['newsletter', 'real_estate_sample', 'deal_linked',
                   'content_positives', 'true_detection', 'gate', 'body_truncated']},
        'text_coverage': {g: {k: num(['tc', g, k]) for k in ['emails', 'with_attachments', 'with_attachment_text']}
                          for g in ['newsletter', 'content_positives', 'true_detection']},
        'baseline': {f: rate(['baseline', f]) for f in FAMILIES},
        'values': {f: {n: {'newsletter': rate([f, n, 'nl']), 'positives': rate([f, n, 'pos']),
                           'gate': {g: num([f, n, g]) for g in GATE}} for n in names[f]} for f in FAMILIES},
    }


def maxed(o):
    if isinstance(o, bool): return False
    if isinstance(o, int): return MAXI
    if isinstance(o, dict): return {k: maxed(v) for k, v in o.items()}
    if isinstance(o, list): return [maxed(v) for v in o]
    return o


def walk(o, path, objs, keys, ints, bools):
    if isinstance(o, dict):
        objs.append(path)
        for k, v in o.items():
            keys.append(path + [k])
            walk(v, path + [k], objs, keys, ints, bools)
    elif isinstance(o, bool):
        bools.append(path)
    elif isinstance(o, int):
        ints.append(path)


def build():
    fixture = json.load(open(FIXTURE))['report']
    rep2 = copy.deepcopy(fixture)
    rep2['schema'] = 2
    rep2['signals'] = signals(lambda p: (sum(map(ord, '.'.join(p))) % 97) + 1)
    base = maxed(copy.deepcopy(fixture))
    base['schema'] = 1
    base['sender_rules_version'] = MAXI
    base['app_version'] = '9999.9999.999999'
    base['sender_rules_source'] = 'download'
    base['answers_by_rule_version'] = [copy.deepcopy(base['answers_by_rule_version'][0]) for _ in range(10)]
    for blk in base['census'].values():
        mb = blk['mailboxes'][0]
        blk['mailboxes'] = [dict(copy.deepcopy(mb), provider='outlook') for _ in range(10)]
    max2 = dict(base, schema=2, signals=dict(maxed(signals(lambda p: 0)), signals_version=1))
    objs, keys, ints, bools = [], [], [], []
    walk(rep2['signals'], ['signals'], objs, keys, ints, bools)
    compact = json.dumps(max2, separators=(',', ':'))
    assert not any(c in s for s in re.findall(r'"([^"]*)"', compact) for c in ':,')
    est = len(compact) + compact.count(':') + compact.count(',')
    j = lambda o: json.dumps(o, separators=(',', ':'))
    return {
        '__FIXTURE__': j(fixture), '__REP2__': j(rep2), '__MAX2__': compact,
        '__OBJ_PATHS__': j(objs), '__KEY_PATHS__': j(keys), '__INT_PATHS__': j(ints), '__BOOL_PATHS__': j(bools),
        '__MAX2_COMPACT__': str(len(compact)), '__MAX2_EST__': str(est),
    }


if __name__ == '__main__':
    b = build()
    print({k: (len(v) if len(v) > 12 else v) for k, v in b.items()})
    print('paths: obj=%d key=%d int=%d bool=%d' % tuple(len(json.loads(b[k])) for k in
          ('__OBJ_PATHS__', '__KEY_PATHS__', '__INT_PATHS__', '__BOOL_PATHS__')))
