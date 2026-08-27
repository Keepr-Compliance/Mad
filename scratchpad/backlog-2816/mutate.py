import io, sys, subprocess
P = "electron/services/db/transactionSearchDbService.ts"

MUTATIONS = {
  "buildTextQuery": ("""        OR ${TEXT_ATTACHMENT_MATCH}
        OR ${TEXT_THREAD_NAME_MATCH}
      )`;
  const whereParams = [transactionId, transactionId, pat, pat, pat, pat];""",
"""        OR ${TEXT_ATTACHMENT_MATCH}
      )`;
  const whereParams = [transactionId, transactionId, pat, pat, pat];"""),
  "buildGlobalTextQuery": ("""      OR ${TEXT_ATTACHMENT_MATCH}
      OR ${TEXT_THREAD_NAME_MATCH}`;
  const matchParams = [pat, pat, pat, pat];""",
"""      OR ${TEXT_ATTACHMENT_MATCH}`;
  const matchParams = [pat, pat, pat];"""),
  "buildUnattachedTextQuery": ("""        OR ${TEXT_ATTACHMENT_MATCH}
        OR ${TEXT_THREAD_NAME_MATCH}
      )`;
  const whereParams = [userId, pat, pat, pat, pat];""",
"""        OR ${TEXT_ATTACHMENT_MATCH}
      )`;
  const whereParams = [userId, pat, pat, pat];"""),
  "isolation": ("""          AND tn.user_id = m.user_id""",
"""          AND 1=1"""),
}

name = sys.argv[1]
old, new = MUTATIONS[name]
s = io.open(P, encoding="utf-8").read()
assert s.count(old) == 1, "anchor not unique for " + name
io.open(P, "w", encoding="utf-8").write(s.replace(old, new, 1))
print("MUTATED:", name)
