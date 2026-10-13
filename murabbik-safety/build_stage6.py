from pathlib import Path
import difflib,subprocess,hashlib
root=Path(__file__).resolve().parent
prior=(root/'server_stage4_get_candidate.js').read_text()
s=prior
# Safe default even if a persistent control document is accidentally marked
# certified: the source+deadline coverage audit is still incomplete.
anchor="  if (process.env.MURABBIK_PREPARED_READ_ENABLE !== '1') return null;"
assert s.count(anchor)==1
s=s.replace(anchor,"  // HARD STOP: incomplete write paths/deadlines and historical migration.\n  // This cannot be enabled by environment variables or Firestore data alone.\n  const ALL_SMART_ALERT_SOURCES_MIGRATED_AND_CERTIFIED = false;\n  if (!ALL_SMART_ALERT_SOURCES_MIGRATED_AND_CERTIFIED) return null;\n"+anchor,1)

routes=['/api/insemination/save','/api/pregnancy-diagnosis/save',
 '/api/uterine-check/save','/api/disease/save','/api/lameness/save',
 '/api/mastitis/save','/api/weaning/save','/api/ovsynch/save']
for route in routes:
    key='"'+route+'"'
    assert s.count(key)>=1,route
    start=s.index(key)
    end=s.find('app.post(',start+len(key))
    if end<0: end=len(s)
    segment=s[start:end]
    assert segment.count('await batch.commit();')==1,(route,segment.count('await batch.commit();'))
    assert 'const uid = req.userId;' in segment,route
    assert 'const batch = db.batch();' in segment,route
    needle='await batch.commit();'
    inject='''// Stage 6: write generation alongside the event and animal updates.
// The feature flag is OFF by default; it never certifies the prepared read.
require('./server/smart-alert-mutation-barrier').appendToBatchIfEnabled({
  batch, db, tenant: tenantKey(uid), FieldValue: admin.firestore.FieldValue
});
'''
    segment=segment.replace(needle,inject+needle,1)
    s=s[:start]+segment+s[end:]

# Within the successful branch of each Firestore transaction, after all reads
# and source writes, append the marker to THE SAME transaction.
txroutes={
 '/api/close-up/save': 'return {\n                created: true',
 '/api/dry-off/save': 'return {\n  created: true'
}
for route, outcome in txroutes.items():
    key='"'+route+'"'
    start=s.index(key)
    end=s.find('app.post(',start+len(key))
    if end<0:end=len(s)
    segment=s[start:end]
    assert segment.count(outcome)==1,(route,segment.count(outcome))
    assert segment.count('await db.runTransaction(')==1,route
    assert segment.index(outcome)>segment.index('await updateAnimalAfter'),route
    hook="""// Stage 6: invalidate prepared output atomically with this event transaction.
require('./server/smart-alert-mutation-barrier').appendToTransactionIfEnabled({
  tx, db, tenant: tenantKey(uid), FieldValue: admin.firestore.FieldValue
});
"""
    segment=segment.replace(outcome,hook+outcome,1)
    s=s[:start]+segment+s[end:]

# These small, per-animal batches include the two highest-volume clinical
# writers. Never alter bulk commits here (the 500-write Firestore limit).
for route, var in [('/api/vaccination/save','writeBatch'),('/api/daily-milk/save','batch')]:
    key='"'+route+'"'
    start=s.index(key)
    end=s.find('app.post(',start+len(key))
    if end<0: end=len(s)
    sec=s[start:end]
    needle='await '+var+'.commit();'
    assert sec.count(needle)==1,(route,sec.count(needle))
    assert 'const uid = req.userId;' in sec,route
    hook="""// Stage 6: invalidation is committed atomically with each source event.
require('./server/smart-alert-mutation-barrier').appendToBatchIfEnabled({
  batch: VAR, db, tenant: tenantKey(uid), FieldValue: admin.firestore.FieldValue
});
""".replace('VAR',var)
    sec=sec.replace(needle,hook+needle,1)
    s=s[:start]+sec+s[end:]

# Highest-priority historical correction: corrected event and history rows
# are already grouped in one small batch. Increment in that SAME commit.
correction_marker='      await batch.commit();\n\n      if (\n        typeof scheduleGroupsRebuildSrv === "function" &&'
assert s.count(correction_marker)==1
s=s.replace(correction_marker,"""      // Stage 6: correction invalidates prior results in the SAME batch.
      require('./server/smart-alert-mutation-barrier').appendToBatchIfEnabled({
        batch, db, tenant: tenantKey(uid), FieldValue: admin.firestore.FieldValue
      });
"""+correction_marker,1)

# The successful calving transaction writes event, dam, calves, then returns.
calving_anchor='            return {\n              created:\n                true,\n\n              transition\n            };'
assert s.count(calving_anchor)==1
s=s.replace(calving_anchor,"""            // Stage 6: atomic generation bump only for successful calving.
            require('./server/smart-alert-mutation-barrier').appendToTransactionIfEnabled({
              tx, db, tenant: tenantKey(uid), FieldValue: admin.firestore.FieldValue
            });
"""+calving_anchor,1)

out=root/'server_stage6_candidate.js';out.write_text(s)
subprocess.run(['node','--check',str(out)],check=True)
# Prepared read model remains untouched from Stage4; shipped in server/.
# Publisher remains untouched from Stage5; shipped in server/.
# The verified baseline server_original.js is included without modification.
# The original Stage4 candidate is already present; do not overwrite it.
(root/'stage4_to_stage6.patch').write_text(''.join(difflib.unified_diff(prior.splitlines(keepends=True),s.splitlines(keepends=True),fromfile='server_stage4_get_candidate.js',tofile='server_stage6_candidate.js')))
for route in routes:
    key='"'+route+'"'
    start=s.index(key)
    end=s.find('app.post(',start+len(key))
    if end<0: end=len(s)
    sec=s[start:end]
    assert sec.count('appendToBatchIfEnabled({')==1
    assert sec.index('appendToBatchIfEnabled({')<sec.index('await batch.commit();')
# Removing the added blocks must restore the exact original stage 4 candidate.
copy=s.replace('''  // HARD STOP: incomplete write paths/deadlines and historical migration.
  // This cannot be enabled by environment variables or Firestore data alone.
  const ALL_SMART_ALERT_SOURCES_MIGRATED_AND_CERTIFIED = false;
  if (!ALL_SMART_ALERT_SOURCES_MIGRATED_AND_CERTIFIED) return null;
''','')
for route in routes:
    copy=copy.replace('''// Stage 6: write generation alongside the event and animal updates.
// The feature flag is OFF by default; it never certifies the prepared read.
require('./server/smart-alert-mutation-barrier').appendToBatchIfEnabled({
  batch, db, tenant: tenantKey(uid), FieldValue: admin.firestore.FieldValue
});
''','',1)
tx_hook="""// Stage 6: invalidate prepared output atomically with this event transaction.
require('./server/smart-alert-mutation-barrier').appendToTransactionIfEnabled({
  tx, db, tenant: tenantKey(uid), FieldValue: admin.firestore.FieldValue
});
"""
for _ in range(2):
    assert tx_hook in copy
    copy=copy.replace(tx_hook,'',1)
for v in ['writeBatch','batch']:
    hook="""// Stage 6: invalidation is committed atomically with each source event.
require('./server/smart-alert-mutation-barrier').appendToBatchIfEnabled({
  batch: VAR, db, tenant: tenantKey(uid), FieldValue: admin.firestore.FieldValue
});
""".replace('VAR',v)
    assert hook in copy
    copy=copy.replace(hook,'',1)
for extra in ["""      // Stage 6: correction invalidates prior results in the SAME batch.
      require('./server/smart-alert-mutation-barrier').appendToBatchIfEnabled({
        batch, db, tenant: tenantKey(uid), FieldValue: admin.firestore.FieldValue
      });
""", """            // Stage 6: atomic generation bump only for successful calving.
            require('./server/smart-alert-mutation-barrier').appendToTransactionIfEnabled({
              tx, db, tenant: tenantKey(uid), FieldValue: admin.firestore.FieldValue
            });
"""]:
    assert extra in copy
    copy=copy.replace(extra,'',1)
assert copy==prior
print('STARTED from Stage4 SHA256',hashlib.sha256(prior.encode()).hexdigest())
print('Stage6 SHA256',hashlib.sha256(s.encode()).hexdigest())
print('batch routes',len(routes)+3,'transaction routes',len(txroutes)+1,'candidate size',len(s),'patch bytes',len((root/'stage4_to_stage6.patch').read_bytes()))