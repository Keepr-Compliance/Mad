-- /*t:sessB*/ session 2: wait at most 8 s for a lock. It has to outwait session 1's hold: 4 s hold - 1 s launch offset
-- = about 3 s of waiting expected, so 8 s is more than twice that. Session 1 uses 3 s (it takes its locks first).
SET LOCAL lock_timeout = '8s';
