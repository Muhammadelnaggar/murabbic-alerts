#!/usr/bin/env python3
"""Apply the 6+3 reviewed Smart Alerts dashboard blocks to exact GitHub main dashboard.
No network/GitHub writes. Refuses unknown input SHA or ambiguous snippets.
"""
import argparse
import hashlib
import re
from pathlib import Path

EXPECTED_GIT_BLOB = '7ab54a030f2b5a6af0acbc2f513333486f4f03e1'

def git_blob_sha(content: bytes) -> str:
    return hashlib.sha1(b'blob ' + str(len(content)).encode() + b'\0' + content).hexdigest()

def pairs(path, old_heading, new_heading):
    content=Path(path).read_text(encoding='utf-8')
    expression=rf'{re.escape(old_heading)}\s*```javascript\n(.*?)\n```\s*{re.escape(new_heading)}\s*```javascript\n(.*?)\n```'
    return re.findall(expression, content, re.S)

def apply(source, pairs):
    for index,(old,new) in enumerate(pairs,1):
        n=source.count(old)
        if n!=1:
            raise ValueError(f'Exact replacement {index}: {n} occurrences (requires exactly one).')
        source=source.replace(old,new,1)
    return source

def main():
    ap=argparse.ArgumentParser()
    ap.add_argument('dashboard',help='exact www/dashboard.html from GitHub main')
    ap.add_argument('--out',help='candidate destination (default dashboard.smart-alerts.candidate.html)')
    ap.add_argument('--fixture-only',action='store_true',help='local test using Oct 8 fixture, not a deployable candidate')
    args=ap.parse_args()
    src=Path(args.dashboard)
    raw=src.read_bytes()
    sha=git_blob_sha(raw)
    if not args.fixture_only and sha!=EXPECTED_GIT_BLOB:
        raise RuntimeError(f'Wrong dashboard blob: got {sha}; expected {EXPECTED_GIT_BLOB}. STOP, do not apply.')
    text=raw.decode('utf8').replace('\r\n','\n')
    root=Path(__file__).resolve().parent
    docs=root
    stage1=pairs(docs/'MURABBIK_DASH_SMART_ALERTS_STAGE1_OLD_NEW_20261013.md','### القديم كاملًا','### البديل كاملًا')
    stage3=pairs(docs/'MURABBIK_DASH_STAGE3_VISIBILITY_OLD_NEW_20261013.md','### OLD COMPLETE','### NEW COMPLETE')
    if len(stage1)!=6 or len(stage3)!=3:raise AssertionError((len(stage1),len(stage3)))
    result=apply(apply(text,stage1),stage3)
    out=Path(args.out or src.with_name('dashboard.smart-alerts.candidate.html'))
    if out.resolve()==src.resolve(): raise ValueError('Must not overwrite original')
    out.write_text(result,encoding='utf-8')
    print(f'PASS: original_blob={sha} stage1=6 stage3=3 output={out} candidate_sha256={hashlib.sha256(out.read_bytes()).hexdigest()}')

if __name__=='__main__':main()