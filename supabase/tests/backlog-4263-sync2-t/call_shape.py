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


def statements(text):
    """[(statement text, trailing text after it)]: top-level statements, comments removed."""
    out, cur, i, n = [], [], 0, len(text)
    while i < n:
        if text.startswith('--', i):
            j = text.find('\n', i)
            i = n if j < 0 else j
            continue
        if text.startswith('/*', i):
            j = text.find('*/', i + 2)
            i = n if j < 0 else j + 2
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
    return bool(re.match(r"(?is)^RAISE\s+EXCEPTION\s+'[A-Z][A-Z0-9_]*\b[^']*'", last))


def _tail_ok(text):
    """nothing but whitespace or comments after the last semicolon"""
    st = statements(text)
    return not st or text.rstrip().endswith(';') or re.sub(r'(?s)--[^\n]*|/\*.*?\*/', '', text[text.rfind(';') + 1:]).strip() == ''


def txn_control(text):
    return ['top-level transaction control: ' + ' '.join(s.split())[:40] for s in statements(text) if TXN.match(s)]


def pglast_count(text):
    try:
        from pglast import parser
    except Exception:
        return None
    try:
        return len(parser.split(text, with_parser=False))
    except Exception:
        return None


def rolled_back(text):
    st = statements(text)
    bad = txn_control(text)
    finals = [i for i, s in enumerate(st) if result_block(s)]
    if len(finals) != 1:
        bad.append('%d result blocks (want exactly 1)' % len(finals))
    elif finals[0] != len(st) - 1:
        bad.append('the result block is not the last statement (%d statement(s) follow it)' % (len(st) - 1 - finals[0]))
    if not _tail_ok(text):
        bad.append('text follows the last statement')
    n = pglast_count(text)
    if n is not None and n != len(st):
        bad.append('statement split differs from pglast (%d here, %d pglast)' % (len(st), n))
    return bad


def commits(text):
    st = statements(text)
    bad = txn_control(text)
    if st and result_block(st[-1]):
        bad.append('ends in a result RAISE: it would never commit')
    return bad


def fragment(text):
    return txn_control(text)


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


def gen_check(here, classes):
    """for a gen.py check: print the result, return True when the folder is clean"""
    probs = folder(here, classes)
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
    return out


if __name__ == '__main__':
    kind, files = sys.argv[1], sys.argv[2:]
    res = check_files(kind, files)
    bad = 0
    for p, probs in res.items():
        for x in probs:
            bad += 1
            print('CALL SHAPE %s (%s): %s' % (p, kind, x))
    print('call shape: %d file(s) as %s, %d problem(s)' % (len(files), kind, bad))
    sys.exit(1 if bad else 0)
