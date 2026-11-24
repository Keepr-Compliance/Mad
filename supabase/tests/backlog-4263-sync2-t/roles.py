#!/usr/bin/env python3
"""BACKLOG-4263 role check: a statement that replaces, alters, grants or revokes on, comments on or drops an object must
run under the role that owns the object (the role in force when the object was created).

Owners: every migration up to LAST is read in version order; a CREATE (not a replace of an existing object) records
the role in force as the owner. Role in force: `SET [LOCAL] ROLE r` / `RESET ROLE` (and the same in `EXECUTE '...'`)
in order through each text; the session user is postgres. Inside a DO block or a function body the role starts as the
role in force at that statement and changes stay inside that body. Dynamic SQL is followed: `EXECUTE <literal or
dollar-quoted text>` and `format(<dollar-quoted text>, ...)` run with the role in force; a call of a pg_temp helper whose
body switches to role R before `EXECUTE q` runs its text argument under R.

`python3 roles.py`           the lane's files (see FILES); prints every statement on an object the session user does
                             not own, with the role in force, and exits 1 on a statement under the wrong role
`python3 roles.py <file>...` the same for the files named
"""
import os
import re
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.abspath(os.path.join(HERE, '..', '..', '..'))
MIGDIR = os.path.join(REPO, 'supabase', 'migrations')
LAST = '20261123170000'
SESSION = 'postgres'


def split(sql):
    """Top-level statements, comments removed; literals and dollar-quoted bodies kept as written."""
    out, cur, i, n = [], [], 0, len(sql)
    while i < n:
        if sql.startswith('--', i):
            j = sql.find('\n', i)
            i = n if j < 0 else j
            continue
        if sql.startswith('/*', i):
            j = sql.find('*/', i + 2)
            i = n if j < 0 else j + 2
            cur.append(' ')
            continue
        c = sql[i]
        if c == "'":
            j = i + 1
            while True:
                j = sql.find("'", j)
                if j < 0:
                    j = n - 1
                    break
                if sql[j + 1:j + 2] == "'":
                    j += 2
                    continue
                break
            cur.append(sql[i:j + 1])
            i = j + 1
            continue
        if c == '"':
            j = sql.find('"', i + 1)
            j = n - 1 if j < 0 else j
            cur.append(sql[i:j + 1])
            i = j + 1
            continue
        if c == '$' and (i == 0 or not (sql[i - 1].isalnum() or sql[i - 1] == '_')):
            m = re.match(r'\$([A-Za-z_][A-Za-z0-9_]*)?\$', sql[i:])
            if m:
                tag = m.group(0)
                j = sql.find(tag, i + len(tag))
                j = n - len(tag) if j < 0 else j
                cur.append(sql[i:j + len(tag)])
                i = j + len(tag)
                continue
        if c == ';':
            s = ''.join(cur).strip()
            if s:
                out.append(s)
            cur = []
            i += 1
            continue
        cur.append(c)
        i += 1
    s = ''.join(cur).strip()
    if s:
        out.append(s)
    return out


def dollar_bodies(text):
    """(start, body) of every top-level dollar-quoted string in text."""
    out, i = [], 0
    while True:
        m = re.compile(r'(?<![A-Za-z0-9_])\$([A-Za-z_][A-Za-z0-9_]*)?\$').search(text, i)
        if not m:
            return out
        tag = m.group(0)
        j = text.find(tag, m.end())
        if j < 0:
            return out
        out.append((m.start(), text[m.end():j]))
        i = j + len(tag)


def unquote(lit):
    return lit[1:-1].replace("''", "'")


ROLE_SET = re.compile(r"^SET\s+(?:LOCAL\s+|SESSION\s+)?ROLE\s+(?:TO\s+|=\s*)?([A-Za-z_][A-Za-z0-9_]*)\s*$", re.I)
ROLE_RESET = re.compile(r"^(?:RESET\s+ROLE|SET\s+(?:LOCAL\s+|SESSION\s+)?ROLE\s+(?:TO\s+|=\s*)?NONE|RESET\s+ALL)\s*$", re.I)
OBJ = r'public\.("?[A-Za-z_][A-Za-z0-9_]*"?)'
CREATE_FN = re.compile(r'^CREATE\s+(OR\s+REPLACE\s+)?FUNCTION\s+' + OBJ, re.I)
CREATE_REL = re.compile(r'^CREATE\s+(?:UNLOGGED\s+)?(TABLE|VIEW|SEQUENCE|MATERIALIZED\s+VIEW)\s+(?:IF\s+NOT\s+EXISTS\s+)?' + OBJ, re.I)
ALTER_DROP = re.compile(r'^(ALTER|DROP)\s+(FUNCTION|TABLE|VIEW|SEQUENCE|MATERIALIZED\s+VIEW)\s+(?:IF\s+EXISTS\s+)?(?:ONLY\s+)?' + OBJ, re.I)
GRANT = re.compile(r'^(GRANT|REVOKE)\s+.*?\bON\s+(?:(FUNCTION|TABLE|SEQUENCE|ROUTINE)\s+)?(' + r'public\.[^;]*)$', re.I | re.S)
COMMENT = re.compile(r'^COMMENT\s+ON\s+(FUNCTION|TABLE|VIEW|COLUMN)\s+' + OBJ, re.I)


class Model:
    def __init__(self):
        self.owner = {}       # object name -> owner role
        self.ops = []         # (file, line, statement, object, owner, role)
        self.helpers = {}     # pg_temp helper name -> role it runs its text argument under
        self.inherits = set()  # roles the session user was granted WITH INHERIT TRUE in this text (acts as their owner)

    def line_of(self, ctx, stmt):
        raw = ctx['raw']
        k = raw.find(stmt[:60])
        return raw.count('\n', 0, k) + 1 if k >= 0 else 0

    def op(self, ctx, stmt, names, role, kind):
        for nm in names:
            nm = nm.strip('"')
            own = self.owner.get(nm, SESSION)
            if kind == 'create':
                self.owner.setdefault(nm, role)
                continue
            if kind == 'create_or_replace' and nm not in self.owner:
                self.owner[nm] = role
                continue
            if own != SESSION or role != SESSION:
                eff = own if (role == SESSION and own in self.inherits) else role
                self.ops.append((ctx['file'], self.line_of(ctx, stmt), ' '.join(stmt.split())[:150]
                                 + ('   [session user granted this role WITH INHERIT TRUE first]' if eff != role else ''), nm, own, eff))

    def run(self, ctx, text, role, top):
        """Statements of text in order; returns the role in force after them (top level) or the starting role."""
        start = role
        for st in split(text):
            role = self.statement(ctx, st, role)
        return role if top else start

    def statement(self, ctx, st, role):
        s = st.strip()
        gi = re.match(r'^GRANT\s+(\w+)\s+TO\s+' + SESSION + r'\s+WITH\s+INHERIT\s+TRUE', s, re.I)
        if gi:
            self.inherits.add(gi.group(1))
            return role
        if ROLE_SET.match(s):
            return ROLE_SET.match(s).group(1)
        if ROLE_RESET.match(s):
            return SESSION
        m = re.match(r"^EXECUTE\s+('(?:[^']|'')*')\s*$", s, re.I)
        if m:
            inner = unquote(m.group(1))
            if ROLE_SET.match(inner.strip()) or ROLE_RESET.match(inner.strip()):
                return self.statement(ctx, inner, role)
            self.run(ctx, inner, role, top=True)
            return role
        mc = CREATE_FN.match(s)
        if mc:
            name = mc.group(2).strip('"')
            self.op(ctx, s, [name], role, 'create_or_replace' if mc.group(1) else 'create')
            if re.match(r'^CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+pg_temp\.', s, re.I):
                pass
            return role
        if re.match(r'^CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+pg_temp\.(\w+)', s, re.I):
            hname = re.match(r'^CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+pg_temp\.(\w+)', s, re.I).group(1)
            bodies = dollar_bodies(s)
            body = bodies[-1][1] if bodies else ''
            sw = re.search(r"SET\s+LOCAL\s+ROLE\s+(\w+)\s*;[\s\S]*?\bEXECUTE\s+q\b", body, re.I)
            if sw:
                self.helpers[hname] = sw.group(1)
            # helper bodies run when called, as the session user
            self.body(ctx, body, SESSION)
            return role
        mr = CREATE_REL.match(s)
        if mr:
            self.op(ctx, s, [mr.group(2)], role, 'create')
            return role
        ma = ALTER_DROP.match(s)
        if ma:
            names = [ma.group(3)]
            if ma.group(1).upper() == 'DROP':
                names = re.findall(OBJ, s)
            self.op(ctx, s, names, role, 'alter')
            return role
        mg = GRANT.match(s)
        if mg and not re.search(r'\bON\s+(?:ALL\s+|SCHEMA\b)', s, re.I):
            names = re.findall(r'public\.("?[A-Za-z_][A-Za-z0-9_]*"?)\s*(?:\(|,|\s+TO\b|\s+FROM\b|$)', mg.group(3))
            self.op(ctx, s, names, role, 'alter')
            return role
        mo = COMMENT.match(s)
        if mo:
            self.op(ctx, s, [mo.group(2)], role, 'alter')
            return role
        if re.match(r'^DO\b', s, re.I):
            bodies = dollar_bodies(s)
            if bodies:
                self.body(ctx, bodies[0][1], role)
            return role
        return role

    def body(self, ctx, body, role):
        """A plpgsql body: role changes in order, direct DDL, EXECUTE of a text, helper calls that switch role."""
        for st in split(body):
            s = st.strip()
            # strip block keywords that precede a statement in the same chunk
            s = re.sub(r'^(?:(?:DECLARE\b[\s\S]*?\bBEGIN|BEGIN|ELSE|THEN|LOOP|EXCEPTION\s+WHEN\s+[^\n]*?THEN|END\s+IF|END\s+LOOP|END)\s+)+', '', s, flags=re.I)
            s = re.sub(r'^(?:IF|ELSIF)\b[\s\S]*?\bTHEN\s+', '', s, flags=re.I)
            if ROLE_SET.match(s) or ROLE_RESET.match(s):
                role = self.statement(ctx, s, role)
                continue
            m = re.match(r"^EXECUTE\s+('(?:[^']|'')*')\s*$", s, re.I)
            if m and (ROLE_SET.match(unquote(m.group(1)).strip()) or ROLE_RESET.match(unquote(m.group(1)).strip())
                      or re.match(r'^GRANT\s+\w+\s+TO\s+\w+\s+WITH\s+INHERIT\s+TRUE', unquote(m.group(1)).strip(), re.I)):
                role = self.statement(ctx, unquote(m.group(1)), role)
                continue
            # helper calls that run their text under another role
            hit = False
            for h, r in self.helpers.items():
                for mm in re.finditer(r'pg_temp\.' + re.escape(h) + r'\s*\(', s):
                    hit = True
                    for _, inner in dollar_bodies(s[mm.end():]):
                        self.run(ctx, inner, r, top=True)
                        break
            if hit:
                continue
            m = re.match(r'^EXECUTE\b(.*)$', s, re.I | re.S)
            if m:
                rest = m.group(1)
                db = dollar_bodies(rest)
                if db:
                    self.run(ctx, db[0][1], role, top=True)
                else:
                    lm = re.match(r"\s*('(?:[^']|'')*')", rest)
                    if lm:
                        self.run(ctx, unquote(lm.group(1)), role, top=True)
                continue
            if re.match(r'^(CREATE|ALTER|DROP|GRANT|REVOKE|COMMENT)\b', s, re.I):
                self.statement(ctx, s, role)


def model_after_migrations():
    m = Model()
    for f in sorted(x for x in os.listdir(MIGDIR) if x.endswith('.sql') and x[:14] <= LAST):
        raw = open(os.path.join(MIGDIR, f), encoding='utf-8').read()
        m.run({'file': 'supabase/migrations/' + f, 'raw': raw}, raw, SESSION, top=True)
    return m


def role_migrations():
    """Migrations up to LAST that switch role (they create objects another role owns)."""
    out = []
    for f in sorted(x for x in os.listdir(MIGDIR) if x.endswith('.sql') and x[:14] <= LAST):
        t = open(os.path.join(MIGDIR, f), encoding='utf-8').read()
        if any(ROLE_SET.match(s.strip()) for s in split(t)):
            out.append('supabase/migrations/' + f)
    return out


# rollback files, apply files and harnesses of the role-switching migrations (and the lane's 20261123* folders)
# every test folder of the hosted-MCP and Keepr Cloud migrations (20261112..20261123): every .sql file in it, nested
# folders included (rollback files, apply files, harnesses and the pieces composed harnesses are built from)
FOLDERS = ['backlog-4236', 'backlog-4238', 'backlog-4243', 'backlog-4244', 'backlog-4245', 'backlog-4263', 'backlog-4263-pr2',
           'backlog-4263-pr4a', 'backlog-4263-pr4b', 'backlog-4263-pr4c', 'backlog-4263-pr5', 'backlog-4263-pr6',
           'backlog-4263-pr8', 'backlog-4263-prod', 'backlog-4263-prod-verify', 'backlog-4263-addr', 'backlog-4263-age', 'backlog-4263-bounds', 'backlog-4263-notice',
           'backlog-4263-sync2-s1', 'backlog-4263-sync2-s2', 'backlog-4263-sync2-erase', 'backlog-4263-sync2-t',
           'backlog-4263-sync2-n', 'backlog-4265', 'backlog-4266']


def lane_files():
    out = []
    for d in FOLDERS:
        p = os.path.join(REPO, 'supabase', 'tests', d)
        if not os.path.isdir(p):
            continue
        for dp, _, fs in os.walk(p):
            out += [os.path.relpath(os.path.join(dp, f), REPO) for f in fs if f.endswith('.sql')]
    return sorted(out)


def erase_harness_text():
    """The erase harness is composed at run time; `harness.py run --print` prints the call (no database call)."""
    r = subprocess.run([sys.executable, os.path.join(REPO, 'supabase/tests/backlog-4263-sync2-erase/harness.py'), 'run', '--print',
                        '--controls', '--mutants'], capture_output=True, text=True, cwd=REPO)
    lines = [l for l in r.stdout.splitlines() if not l.startswith('MUTATION APPLIED') and not l.startswith(('  - ', '  + '))]
    text = '\n'.join(lines)
    # a wrong flag or a failed compose would read as "0 statements": require the composed call itself
    assert r.returncode == 0 and len(text) > 100000 and text.count('DO $') >= 5, ('erase harness did not compose', r.returncode, len(text))
    return text


def check(files, extra=None, texts=None):
    """texts: file -> text to use instead of the file on disk (a generator checking what it is about to write)."""
    base = model_after_migrations()
    per = {}
    for f in files:
        m = Model()
        m.owner = dict(base.owner)
        raw = (texts or {}).get(f)
        if raw is None:
            raw = open(os.path.join(REPO, f), encoding='utf-8').read()
        m.run({'file': f, 'raw': raw}, raw, SESSION, top=True)
        per[f] = m.ops
    for name, raw in (extra or {}).items():
        m = Model()
        m.owner = dict(base.owner)
        m.run({'file': name, 'raw': raw}, raw, SESSION, top=True)
        per[name] = m.ops
    return per


def main(argv):
    files = argv or lane_files()
    extra = {} if argv else {'supabase/tests/backlog-4263-sync2-erase/harness.py run --print': erase_harness_text()}
    per = check(files, extra)
    bad = 0
    print('role-switching migrations: ' + ', '.join(os.path.basename(x)[:14] for x in role_migrations()))
    mig = [o for o in model_after_migrations().ops if o[4] != o[5]]
    print(f'migrations (reported, not changed here): {len(mig)} statements under a role that does not own the object')
    for f, line, stmt, obj, own, role in mig:
        print(f'   MIGRATION {f}:{line} owner {own}, role {role}: {stmt}')
    for f, ops in per.items():
        wrong = [o for o in ops if o[4] != o[5]]
        bad += len(wrong)
        print(f'== {f}: {len(ops)} statements on objects not owned by the session user or under another role, {len(wrong)} under the wrong role')
        for _, line, stmt, obj, own, role in ops:
            print(f"   {'WRONG' if own != role else 'ok   '} :{line} owner {own}, role {role}: {stmt}")
    print(f'files {len(per)}, wrong-role statements {bad}')
    return 1 if bad else 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
