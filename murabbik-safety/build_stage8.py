#!/usr/bin/env python3
"""Stage8 surgical edits to last verified Stage7 candidate. No deployed code."""
from pathlib import Path
from hashlib import sha256
import difflib
ROOT=Path(__file__).resolve().parent
src=ROOT/'server_stage7_candidate.js'
base=src.read_bytes()
BASE='d51b2e397798f54782be6872337e095e7192f014f7e9b00a8ffb3b1a69197a69'
assert sha256(base).hexdigest()==BASE, 'Refusing unknown Stage7 baseline'
s=base.decode('utf-8')
H="""// Stage 8: source writes and prepared-generation change share ONE Firestore batch.
require('./server/smart-alert-mutation-barrier').appendToBatchIfEnabled({
  batch, db, tenant: tenantKey(uid), FieldValue: admin.firestore.FieldValue
});
"""
def edit_segment(tag, start, end, old, new, expected=1):
 global s
 a=s.index(start);b=s.index(end,a+len(start));seg=s[a:b]
 assert seg.count(old)==expected, f'{tag} expected {expected} anchors; found {seg.count(old)}'
 seg2=seg.replace(old,new)
 s=s[:a]+seg2+s[b:]
 print(tag, 'OK')
# two import paths, two commit sites for each. A marker for each actual committed group;
# rejected rows do not receive a marker and do not bump generation.
for name,start,end in [
 ('animal import','app.post("/api/add-animal/import",','// ============================================================\n//                 API: HERD IMPORT V2'),
 ('herd import operational','app.post("/api/herd-import-v2/save-operational",','app.post("/api/herd-import-v2/')
]:
 # a nearby helper may appear earlier; route unique; find next route after route start when end isn't reliable
 a=s.index(start)
 import re
 nxt=re.search(r'\napp\.(?:get|post|put|patch|delete)\(',s[a+len(start):]); b=a+len(start)+nxt.start() if nxt else len(s)
 seg=s[a:b]
 assert seg.count('await batch.commit();')==2,(name,seg.count('await batch.commit();'))
 seg=seg.replace('await batch.commit();',H+'await batch.commit();')
 s=s[:a]+seg+s[b:]
 print(name,'OK')
# 2 bulk endpoints, 1 commit function each; mark only if ops>0.
for name,path in [('insemination bulk','/api/insemination/bulk-save'),('pregnancy bulk','/api/pregnancy-diagnosis/bulk-save')]:
 start='app.post("'+path+'"'; a=s.index(start);n=s.find('app.post(',a+len(start));b=n if n>=0 else len(s)
 seg=s[a:b]
 old='''if (ops > 0 && (force || ops >= 400)) {
        await batch.commit();'''
 new='''if (ops > 0 && (force || ops >= 400)) {
'''+H+'        await batch.commit();'
 assert seg.count(old)==1,(name,seg.count(old))
 seg=seg.replace(old,new);s=s[:a]+seg+s[b:]
 print(name,'OK')
# V2 actual atomic write set: include source animals + seed events + completed job
# single batch, but never on already-completed no-op.
start='async function herdImportV2CommitAtomicWriteSetInternalSrv(';a=s.index(start);b=s.index('function addAnimalImportKindSrv',a)
seg=s[a:b]
assert seg.count('    await batch.commit();')==1
seg=seg.replace('    await batch.commit();','    '+H+'await batch.commit();');s=s[:a]+seg+s[b:]
print('herd V2 atomic seed import OK')
updated=ROOT/'server_stage8_candidate.js';updated.write_text(s)
( ROOT/'stage7_to_stage8.patch').write_text(''.join(difflib.unified_diff(base.decode('utf-8').splitlines(keepends=True),s.splitlines(keepends=True),fromfile='server_stage7_candidate.js',tofile='server_stage8_candidate.js')))
print('Stage8 SHA256',sha256(updated.read_bytes()).hexdigest(), 'patch_bytes', (ROOT/'stage7_to_stage8.patch').stat().st_size)