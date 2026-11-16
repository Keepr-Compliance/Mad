#!/usr/bin/env python3
"""Read kt-sql output on stdin; print the P3986_RESULT object (or the raw text if absent)."""
import json, sys
t = sys.stdin.read()
try:
    msg = json.loads(t.splitlines()[0])["message"]
    body = msg.split("P3986_RESULT ", 1)[1]
    obj, _ = json.JSONDecoder().raw_decode(body)
    print(json.dumps(obj, indent=1))
except Exception:
    print(t)
