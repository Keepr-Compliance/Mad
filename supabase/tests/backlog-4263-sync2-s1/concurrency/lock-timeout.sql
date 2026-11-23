-- every call that writes (setup, mutant install, mutant drop, teardown): wait at most 3 s for any lock
SET LOCAL lock_timeout = '3s';
