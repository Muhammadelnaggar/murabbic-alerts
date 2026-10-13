from pathlib import Path
import difflib,hashlib,subprocess
root=Path(__file__).resolve().parent
old=(root/'server_stage6_candidate.js').read_text(encoding='utf8')
EXPECTED='297ad40aae1deabb3cc7d6ebb56cddea4cc500197f040913d0aef36f05950adf'
assert hashlib.sha256(old.encode()).hexdigest()==EXPECTED, 'Unexpected Stage6 baseline. DO NOT edit.'
s=old
HOOK="""// Stage 7: invalidate the prepared result inside the successful write transaction.
require('./server/smart-alert-mutation-barrier').appendToTransactionIfEnabled({
  tx, db, tenant: tenantKey(uid), FieldValue: admin.firestore.FieldValue
});
"""
# Scoped editing: an exact, single anchor inside a known POST route.
def edit_route(route,needle,substitute):
    global s
    import re
    route_re=re.compile(r'app\.post\(\s*[\'\"]'+re.escape(route)+r'[\'\"]\s*,')
    matches=list(route_re.finditer(s))
    assert len(matches)==1,(route,len(matches))
    start=matches[0].start()
    tail=s[start:]
    # only next POST route (route in this giant server may span multiple helpers)
    nxt=re.search(r'\bapp\.post\s*\(',tail[matches[0].end()-start:])
    end=start+(matches[0].end()-start)+(nxt.start() if nxt else len(tail))
    segment=s[start:end]
    assert segment.count(needle)==1,(route,'anchor not unique',segment.count(needle))
    assert 'appendToTransactionIfEnabled({' not in segment,route
    segment=segment.replace(needle,substitute,1)
    s=s[:start]+segment+s[end:]

# 1. Farm vaccination program: 3 writes to farm program, version, settings.
# Bump after the final set, only if saving a valid new version.
needle='''            return {
              version,

              previousVersion,

              rowCount:
                rows.length
            };'''
edit_route('/api/vaccination/farm-program',needle, '            '+HOOK.replace('\n','\n            ').rstrip()+'\n\n'+needle)

# 2. Abortion: only after actual new event and animal status update.
needle='''    return { created: true };
  });'''
edit_route('/api/abortion/save',needle, '    '+HOOK.replace('\n','\n    ').rstrip()+'\n\n'+needle)

# 3. Daily milk session: both draft session writes and complete day writes
# must invalidate, but rejected/out-of-order sessions must not.
needle='''                return {
                  corrected:
                    existingIndex >= 0,

                  completed,

                  milkSessions:
                    nextSessions,

                  currentTotalKg,

                  nextSessionNumber
                };'''
edit_route('/api/daily-milk/session/save',needle, '                '+HOOK.replace('\n','\n                ').rstrip()+'\n\n'+needle)

# 4. Hoof trimming: only first insert, not duplicate event.
needle='''        created = true;
      });'''
edit_route('/api/hoof-trimming/save',needle,'        '+HOOK.replace('\n','\n        ').rstrip()+'\n\n'+needle)

assert s.count('// Stage 7: invalidate the prepared result inside the successful write transaction.')==4
assert 'const ALL_SMART_ALERT_SOURCES_MIGRATED_AND_CERTIFIED = false;' in s
out=root/'server_stage7_candidate.js';out.write_text(s,encoding='utf8')
patch=''.join(difflib.unified_diff(old.splitlines(keepends=True),s.splitlines(keepends=True),fromfile='server_stage6_candidate.js',tofile='server_stage7_candidate.js'))
(root/'stage6_to_stage7.patch').write_text(patch,encoding='utf8')
subprocess.run(['node','--check',str(out)],check=True)
# Reverse exact inserted hooks without touching baseline.
reverse=s
hook7=HOOK
for indent in ['            ','    ','                ','        ']:
    inserted=indent+hook7.replace('\n','\n'+indent).rstrip()+'\n\n'
    assert reverse.count(inserted)==1,(indent,reverse.count(inserted))
    reverse=reverse.replace(inserted,'',1)
assert reverse==old,'Candidate changes beyond reviewed hooks.'
print('BASE_SHA256',EXPECTED)
print('STAGE7_SHA256',hashlib.sha256(s.encode()).hexdigest())
print('PATCH_BYTES',len(patch.encode()),'HOOKS',4)