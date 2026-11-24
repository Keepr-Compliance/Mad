#!/usr/bin/env python3
"""BACKLOG-4263 call shape: a call that must roll back ends in its result RAISE; a call that commits by design does not.

A test call is sent as ONE transaction and rolls back only because its last statement raises. If that RAISE is
removed, or a statement follows it, or a COMMIT sits in the middle, the call commits. This module checks the text:

  rolled_back(text)  -> problems: exactly one final result block (a DO whose body ends in an unconditional
                        RAISE EXCEPTION '<MARKER> ...'); it is the LAST top-level statement; nothing but whitespace or
                        comments after it; no top-level transaction control anywhere.
  commits(text)      -> problems: no top-level transaction control, and the last statement is NOT such a result block
                        (an apply wrapper or a rollback file that ended in a result RAISE would never commit).
  fragment(text)     -> problems: no top-level transaction control (a piece that run.sh puts into a call).

Top level = outside dollar-quoted bodies, string literals and comments. The split is this file's own (quote, dollar
and comment aware); where pglast is importable it is cross-checked against pglast's statement split.

`python3 call_shape.py rolled_back|commits|fragment <file>...` prints the problems; exit 1 when there is one.
"""
import re
import sys

TXN = re.compile(r'(?is)^(COMMIT|END|ROLLBACK|ABORT|BEGIN|START\s+TRANSACTION|SAVEPOINT|RELEASE|PREPARE\s+TRANSACTION)\b')


def _comment_end(text, i):
    """index just past the block comment opening at i. PostgreSQL nests block comments: /* a /* b */ c */ is ONE comment."""
    depth, n = 0, len(text)
    while i < n:
        if text.startswith('/*', i):
            depth += 1
            i += 2
        elif text.startswith('*/', i):
            depth -= 1
            i += 2
            if depth == 0:
                return i
        else:
            i += 1
    return n


def _code_words(text):
    """the words and semicolons of text with comments, string literals, quoted names and dollar-quoted texts blanked"""
    out, i, n = [], 0, len(text)
    while i < n:
        if text.startswith('--', i):
            j = text.find('\n', i)
            i = n if j < 0 else j
            out.append(' ')
            continue
        if text.startswith('/*', i):
            i = _comment_end(text, i)
            out.append(' ')
            continue
        c = text[i]
        if c in "'\"":
            j = i + 1
            while True:
                j = text.find(c, j)
                if j < 0 or text[j + 1:j + 2] != c:
                    break
                j += 2
            i = n if j < 0 else j + 1
            out.append(' ')
            continue
        if c == '$' and (i == 0 or not (text[i - 1].isalnum() or text[i - 1] == '_')):
            m = re.match(r'\$([A-Za-z_][A-Za-z0-9_]*)?\$', text[i:])
            if m:
                j = text.find(m.group(0), i + len(m.group(0)))
                i = n if j < 0 else j + len(m.group(0))
                out.append(' ')
                continue
        out.append(c)
        i += 1
    return re.findall(r'[A-Za-z_][A-Za-z0-9_]*|;', ''.join(out))


def exit_paths(body):
    """ways a DO body can end without raising, other than by an error: RETURN anywhere; EXIT or CONTINUE outside a
    loop or with a label (a labelled EXIT leaves a block); an EXCEPTION handler on the outermost block (it catches the
    final RAISE). EXIT/CONTINUE inside a loop and handlers of nested blocks only end that loop or that block."""
    w = [x.upper() for x in _code_words(body)]
    stack, bad = [], []
    i = 0
    while i < len(w):
        x, nxt = w[i], (w[i + 1] if i + 1 < len(w) else '')
        prev = w[i - 1] if i else ''
        if x == 'BEGIN':
            stack.append('B')
        elif x == 'CASE':
            stack.append('C')
        elif x == 'LOOP':
            stack.append('L')
        elif x == 'END':
            if nxt == 'IF':
                i += 1
            elif nxt in ('LOOP', 'CASE'):
                want = nxt[0]
                if want in stack:
                    del stack[len(stack) - 1 - stack[::-1].index(want)]
                i += 1
            elif stack:
                stack.pop()
        elif x == 'RETURN':
            bad.append('RETURN')
        elif x in ('EXIT', 'CONTINUE'):
            if 'L' not in stack:
                bad.append(x + ' outside a loop')
            elif nxt not in ('WHEN', ';'):
                bad.append('%s %s (a labelled %s)' % (x, nxt, x))
        elif x == 'EXCEPTION' and prev != 'RAISE' and stack == ['B']:
            bad.append('an EXCEPTION handler on the outermost block')
        i += 1
    return bad


def statements(text):
    """[(statement text, trailing text after it)]: top-level statements, comments removed."""
    out, cur, i, n = [], [], 0, len(text)
    while i < n:
        if text.startswith('--', i):
            j = text.find('\n', i)
            i = n if j < 0 else j
            continue
        if text.startswith('/*', i):
            i = _comment_end(text, i)
            cur.append(' ')
            continue
        c = text[i]
        if c == "'":
            j = i + 1
            while True:
                j = text.find("'", j)
                if j < 0 or text[j + 1:j + 2] != "'":
                    break
                j += 2
            j = n - 1 if j < 0 else j
            cur.append(text[i:j + 1])
            i = j + 1
            continue
        if c == '"':
            j = text.find('"', i + 1)
            j = n - 1 if j < 0 else j
            cur.append(text[i:j + 1])
            i = j + 1
            continue
        if c == '$' and (i == 0 or not (text[i - 1].isalnum() or text[i - 1] == '_')):
            m = re.match(r'\$([A-Za-z_][A-Za-z0-9_]*)?\$', text[i:])
            if m:
                tag = m.group(0)
                j = text.find(tag, i + len(tag))
                j = n - len(tag) if j < 0 else j
                cur.append(text[i:j + len(tag)])
                i = j + len(tag)
                continue
        if c == ';':
            st = ''.join(cur).strip()
            if st:
                out.append(st)
            cur = []
            i += 1
            continue
        cur.append(c)
        i += 1
    tail = ''.join(cur).strip()
    if tail:
        out.append(tail)
    return out


def result_block(st):
    """True when st is a DO block whose body's last statement is an unconditional RAISE EXCEPTION '<MARKER> ...'."""
    m = re.match(r'(?is)^DO\s+(\$[A-Za-z_0-9]*\$)(.*)\1\s*$', st)
    if not m:
        return False
    body = statements(m.group(2))
    if len(body) < 2 or not re.match(r'(?is)^END$', body[-1].strip()):
        return False
    last = re.sub(r'(?is)^(DECLARE\b.*?\bBEGIN|BEGIN)\s+', '', body[-2].strip())
    return bool(re.match(r"(?is)^RAISE\s+EXCEPTION\s+'[A-Z][A-Z0-9_]*\b[^']*'", last)) and not exit_paths(m.group(2))


def result_block_exits(st):
    """for a statement shaped like a result block, the exit paths that keep it from being one ([] otherwise)"""
    m = re.match(r'(?is)^DO\s+(\$[A-Za-z_0-9]*\$)(.*)\1\s*$', st)
    return exit_paths(m.group(2)) if m else []


def _tail_ok(text):
    """nothing but whitespace or comments after the last semicolon"""
    st = statements(text)
    return not st or text.rstrip().endswith(';') or not statements(text[text.rfind(';') + 1:])


def txn_control(text):
    return ['top-level transaction control: ' + ' '.join(s.split())[:40] for s in statements(text) if TXN.match(s)]


PG_TXN = {'BEGIN_P', 'START', 'COMMIT', 'END_P', 'ROLLBACK', 'ABORT_P', 'SAVEPOINT', 'RELEASE'}
REQUIRE_PGLAST = False   # sweep --require-pglast: a missing pglast is then a problem, not a skipped check


def pglast_problems(text, n_here):
    """None when pglast cannot be imported (and it is not required). Otherwise the problems PostgreSQL's own scanner
    finds: a split that fails, a statement count that differs from this file's split, and any statement whose first
    token starts a transaction-control statement (TransactionStmt); where the whole text parses, any TransactionStmt."""
    try:
        from pglast import parser
        import pglast
    except Exception:
        return ['pglast is required (--require-pglast) and cannot be imported'] if REQUIRE_PGLAST else None
    try:
        parts = parser.split(text, with_parser=False)
    except Exception as e:
        return ['pglast could not split the text: %s' % str(e)[:120]]
    bad = []
    if len(parts) != n_here:
        bad.append('statement split differs from pglast (%d here, %d pglast)' % (n_here, len(parts)))
    for p in parts:
        toks = [x.name for x in parser.scan(p) if x.name not in ('C_COMMENT', 'SQL_COMMENT')]
        if toks and (toks[0] in PG_TXN or toks[:2] == ['PREPARE', 'TRANSACTION']):
            bad.append('pglast: transaction control: ' + ' '.join(p.split())[:40])
    try:
        kinds = [type(s.stmt).__name__ for s in pglast.parse_sql(re.sub(r'__[A-Z][A-Z0-9_]*__', 'x4263', text))]
    except Exception:
        kinds = []   # a fragment or a placeholder that does not parse on its own: the scan above still ran
    if 'TransactionStmt' in kinds and not any(b.startswith('pglast: transaction') for b in bad):
        bad.append('pglast: a TransactionStmt')
    return bad


def rolled_back(text):
    st = statements(text)
    bad = txn_control(text)
    finals = [i for i, s in enumerate(st) if result_block(s)]
    if len(finals) != 1:
        bad.append('%d result blocks (want exactly 1)' % len(finals))
    elif finals[0] != len(st) - 1:
        bad.append('the result block is not the last statement (%d statement(s) follow it)' % (len(st) - 1 - finals[0]))
    if len(finals) == 0 and st and result_block_exits(st[-1]):
        bad.append('the last block can end without raising: ' + ', '.join(result_block_exits(st[-1])))
    if not _tail_ok(text):
        bad.append('text follows the last statement')
    bad += pglast_problems(text, len(st)) or []
    return bad


def commits(text):
    st = statements(text)
    bad = txn_control(text)
    if st and result_block(st[-1]):
        bad.append('ends in a result RAISE: it would never commit')
    bad += pglast_problems(text, len(st)) or []
    return bad


def fragment(text):
    return txn_control(text) + (pglast_problems(text, len(statements(text))) or [])


KINDS = {'rolled_back': rolled_back, 'commits': commits, 'fragment': fragment}


def folder(here, classes):
    """problems for one folder: every .sql file in it is declared in classes {file: kind}, and has that kind's shape"""
    import os
    files = sorted(f for f in os.listdir(here) if f.endswith('.sql'))
    probs = ['%s: not declared (rolled_back, commits or fragment)' % f for f in files if f not in classes]
    probs += ['%s: declared but missing' % f for f in classes if f not in files]
    for f, k in sorted(classes.items()):
        if f in files:
            probs += ['%s (%s): %s' % (f, k, x) for x in KINDS[k](open(os.path.join(here, f), encoding='utf-8').read().replace('\r\n', '\n'))]
    return probs


GEN_ROW = re.compile(r'^\| `([\w.-]+\.(?:sql|tpl))` \| (rolled_back|commits|fragment) \|', re.M)


def readme_classes(path):
    """{file: class} from the 'Call classes' table of a README"""
    return {m.group(1): m.group(2) for m in GEN_ROW.finditer(open(path, encoding='utf-8').read())}


def gen_check(here, classes):
    """for a gen.py check: print the result, return True when the folder is clean. The classes passed in must equal
    the README's 'Call classes' table, so a class is never changed in the code alone."""
    import os
    probs = folder(here, classes)
    table = readme_classes(os.path.join(here, 'README.md'))
    if table != classes:
        probs.append('README.md call classes differ from the check\'s: %s' % sorted(
            set(table.items()) ^ set(classes.items())))
    for x in probs:
        print('CALL SHAPE ' + x)
    print('call shape: %d files (%s): %d problem(s)' % (len(classes), ', '.join('%d %s' % (list(classes.values()).count(k), k)
          for k in ('rolled_back', 'commits', 'fragment') if k in classes.values()), len(probs)))
    return not probs


def check_files(kind, paths, read=None):
    """{path: [problems]} for the files; read(path) -> text (default: the file on disk, line endings normalized)"""
    read = read or (lambda p: open(p, encoding='utf-8').read().replace('\r\n', '\n'))
    return {p: KINDS[kind](read(p)) for p in paths}


WRITE = re.compile(r'(?is)^(INSERT|UPDATE|DELETE|CREATE|DROP|ALTER|GRANT|REVOKE|TRUNCATE|COMMENT|DO)\b|\bpublic\.__[A-Z]+_FN__\(|'
                   r'\bpublic\.cloud_\w+\(|pg_stat_statements_reset\(')
CLASS_ROW = re.compile(r'^\| `([\w.-]+\.sql)` \| (rolled_back|commits|fragment) \| (none|\d+) \|', re.M)


def first_write(text):
    """(line, statement) of the first top-level statement that writes or may write (a DO block counts), or None"""
    for st in statements(text):
        if WRITE.search(st):
            k = text.find(st[:40])
            return text.count('\n', 0, k) + 1, st
    return None


def concurrency_checks(folder, readme_text, recorded):
    """[(name, ok, detail)] for a two-session folder. The README's class table declares each .sql file: rolled_back
    (its call must end in its result RAISE), commits (by design; must not end in a result RAISE) or fragment (a piece run.sh
    puts into a call), with the line of its first write ('none' for a file that writes nothing). recorded: every call text
    the offline run sent; each must have the guard as its first statement, so the guard precedes every write."""
    import os
    table = {m.group(1): (m.group(2), m.group(3)) for m in CLASS_ROW.finditer(readme_text)}
    files = sorted(f for f in os.listdir(folder) if f.endswith('.sql'))
    out = [('call classes: every .sql file is in the README table and every table row is a file',
            set(table) == set(files) and len(table) > 5, 'missing %s; extra %s' % (sorted(set(files) - set(table)), sorted(set(table) - set(files))))]
    shape_bad, write_bad = [], []
    for f in files:
        if f not in table:
            continue
        kind, fw = table[f]
        t = open(os.path.join(folder, f), encoding='utf-8').read().replace('\r\n', '\n')
        shape_bad += ['%s (%s): %s' % (f, kind, x) for x in KINDS[kind](t)]
        got = first_write(t)
        got_s = 'none' if got is None else str(got[0])
        if kind != 'fragment' and got_s != fw:
            write_bad.append('%s: first write at %s, table says %s' % (f, got_s, fw))
    out.append(('call classes: each file has its class\'s shape (rolled_back: one final result RAISE, last, nothing after;'
                ' commits: no final result RAISE; all: no top-level transaction control)', not shape_bad, '; '.join(shape_bad)[:600]))
    out.append(('call classes: each file\'s first write is at the line the table gives', not write_bad, '; '.join(write_bad)[:600]))
    # the guard is the first statement of every call that was sent, so it precedes every write in it
    first = [statements(x)[0] if statements(x) else '' for x in recorded]
    nog = [i for i, st in enumerate(first) if not st.startswith('DO $guard')]
    out.append(('call classes: the guard is the first statement of every one of %d calls sent offline' % len(recorded),
                len(recorded) > 3 and not nog, 'calls without the guard first: %s' % nog[:5]))
    # every file that writes reached a call in the offline run (so the guard-first assertion covers it)
    unseen = []
    for f in files:
        if f in table and table[f][0] != 'fragment' and table[f][1] != 'none':
            st = first_write(open(os.path.join(folder, f), encoding='utf-8').read())[1]
            sig = st.split('__')[0][:60]
            if len(sig) < 12 or not any(sig in x for x in recorded):
                unseen.append(f)
    out.append(('call classes: every file that writes was sent in the offline run, guard first', not unseen, 'not seen: %s' % unseen))
    # read, not run: every place run.sh can send a call, including paths this offline run never takes
    rel = '/'.join(os.path.normpath(os.path.abspath(folder)).split(os.sep)[-2:])
    names, bad = transport_sites(open(os.path.join(folder, 'run.sh'), encoding='utf-8').read(), transport_rules(rel))
    out.append(('call sites: every $K call in run.sh sends a file built guard first (%d files, read from the script)' % len(names),
                not bad, '; '.join(bad)[:600]))
    return out


MENTION = re.compile(r'\$\{?K\}?(?![A-Za-z0-9_])')
INVOKE = re.compile(r'(?:^|[\s(;&|])"?\$K"?\s+"\$tmp/([A-Za-z0-9_.$-]+)"')
FUNC = re.compile(r'^\s*([A-Za-z_]\w*)\(\)\s*\{')


def transport_sites(text, rules):
    """(sent file names, problems) for a run.sh, read as text, not run. Every mention of the transport $K is either an
    invocation `$K "$tmp/<file>"` or one of rules['non_calls'] (exact lines: refusals and tests of $K). A `$1`/`$2`
    file inside a function is resolved through that function's calls. Every file sent is produced by a guarded
    helper (rules['producer'], with {N} for the name), a pinned hand-built line (rules['hand_built']) or a composer
    output (rules['compose_outputs']), and no other line writes it. The helpers' own lines (rules['helpers']) are
    pinned exactly, so the guard stays first in what they build. A new raw call site anywhere, run or not, is red."""
    lines = text.replace('\r\n', '\n').split('\n')
    code = [re.sub(r'(^|\s)#(\s.*)?$', r'\1', x).rstrip() for x in lines]
    stripped = [x.strip() for x in code]
    bad, sent, func = [], [], None
    for no, x in enumerate(code, 1):
        m = FUNC.match(x)
        if m:
            func = m.group(1)
        mentions = len(MENTION.findall(x))
        names = INVOKE.findall(x)
        if mentions > len(names) and x.strip() not in rules['non_calls']:
            bad.append('run.sh:%d: a mention of $K that is neither an invocation of a guarded file nor a pinned non-call: %s' % (no, x.strip()[:90]))
        for nm in names:
            if re.fullmatch(r'\$[1-9]', nm) and func:
                k = int(nm[1])
                calls = [c.split()[k] for c in stripped if re.match(r'%s\s' % re.escape(func), c) and len(c.split()) > k]
                if not calls:
                    bad.append('run.sh:%d: %s inside %s() is never given a file' % (no, nm, func))
                sent += [(no, c) for c in calls]
            elif '$' in nm:
                bad.append('run.sh:%d: a sent file name that is not fixed: %s' % (no, nm))
            else:
                sent.append((no, nm))
        if func and (x.strip() == '}' or (m and x.rstrip().endswith('}'))):
            func = None
    for want in rules['non_calls'] + rules['helpers'] + rules['hand_built']:
        if want not in stripped:
            bad.append('pinned line not in run.sh: %s' % want[:90])
    for no, nm in sent:
        e = re.escape(nm)
        produced = nm in rules.get('compose_outputs', []) or any(re.search(rules['producer'].replace('{N}', e) + r'(?=[\s;]|$)', c) for c in stripped) \
            or any(re.search(r'>\s*"\$tmp/%s"' % e, h) for h in rules['hand_built'])
        if not produced:
            bad.append('run.sh:%d: %s is sent but built by no guarded helper' % (no, nm))
        for c in stripped:
            if re.search(r'>\s*"\$tmp/%s"' % e, c) and c not in rules['hand_built']:
                bad.append('%s is written outside the guarded helpers: %s' % (nm, c[:90]))
    names = sorted(set(n for _, n in sent))
    if len(names) < 5:
        bad.append('only %d sent files found: the scan is not reading this run.sh' % len(names))
    return names, sorted(set(bad))


def transport_rules(folder_rel):
    import json
    import os
    return json.load(open(os.path.join(os.path.dirname(os.path.abspath(__file__)), 'call_sites.json'), encoding='utf-8'))[folder_rel]


def selftest():
    """the shared cases (call_shape_cases.json, read by the jest pin too): each one's verdict is as written there"""
    import json
    import os
    cases = json.load(open(os.path.join(os.path.dirname(os.path.abspath(__file__)), 'call_shape_cases.json'), encoding='utf-8'))
    wrong = 0
    for c in cases:
        probs = KINDS[c['kind']](c['text'])
        good = (not probs) == c['ok']
        wrong += not good
        print('%s %s (%s): %s' % ('ok  ' if good else 'FAIL', c['name'], c['kind'], '; '.join(probs) or 'no problem'))
    print('call shape selftest: %d cases, %d wrong' % (len(cases), wrong))
    return 1 if wrong or len(cases) < 30 else 0


SITE_FOLDERS = ('backlog-4263-sync2-s1/concurrency', 'backlog-4263-sync2-erase/concurrency', 'backlog-4263-sync2-n/two-session')


def sites(rel):
    """the static call-site pin for one folder, printed; True when clean"""
    import os
    here = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', rel)
    names, bad = transport_sites(open(os.path.join(here, 'run.sh'), encoding='utf-8').read(), transport_rules(rel))
    for x in bad:
        print('CALL SITES %s: %s' % (rel, x))
    print('call sites %s: %d files sent, %d problem(s)' % (rel, len(names), len(bad)))
    return not bad


if __name__ == '__main__':
    if sys.argv[1:2] == ['selftest']:
        REQUIRE_PGLAST = '--require-pglast' in sys.argv   # the pglast gate: a missing pglast is then a failure
        sys.exit(selftest())
    if sys.argv[1:2] == ['sites']:
        sys.exit(0 if all([sites(f) for f in (sys.argv[2:] and [x for x in sys.argv[2:] if not x.startswith('--')] or SITE_FOLDERS)]) else 1)
    kind, files = sys.argv[1], sys.argv[2:]
    res = check_files(kind, files)
    bad = 0
    for p, probs in res.items():
        for x in probs:
            bad += 1
            print('CALL SHAPE %s (%s): %s' % (p, kind, x))
    print('call shape: %d file(s) as %s, %d problem(s)' % (len(files), kind, bad))
    sys.exit(1 if bad else 0)
